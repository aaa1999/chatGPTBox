/* eslint-env node */
// ChatGPTBox desktop app main process (Windows counterpart of safari/build.sh packaging).
//
// Architecture: the Electron shell hosts the already-built browser extension (build/firefox,
// MV2) in two windows:
//   - a hidden "background host" window running background.js (all API/session logic),
//   - visible panel windows loading IndependentPanel.html (chat) or popup.html (settings).
// A preload shim (preload/extension-shim.cjs) exposes a webextension-compatible
// `window.browser` in every window and bridges storage / runtime messaging / ports
// over IPC to this main process, which acts as the hub.
//
// The background host disables webSecurity so its fetch calls reach AI providers
// directly, mirroring the extension's host permissions. Cookie-based "Web" API modes
// depend on the browser cookie jar and are therefore not available in the desktop app.
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  shell,
  nativeImage,
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { StorageHub } from './storage.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.dirname(__dirname)

const RUNTIME_ID = 'chatgptbox-desktop'
const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+H'

const resolveExtensionDir = () => {
  if (process.env.CGB_EXTENSION_DIR) return path.resolve(process.env.CGB_EXTENSION_DIR)
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'extension')
    if (fs.existsSync(packaged)) return packaged
  }
  return path.resolve(desktopDir, '..', 'build', 'firefox')
}

const extensionDir = resolveExtensionDir()
const extensionDirUrl = pathToFileURL(extensionDir).href

if (!fs.existsSync(path.join(extensionDir, 'background.js'))) {
  console.error(
    `[desktop] extension build not found in ${extensionDir}. Run "npm run build" first.`,
  )
  app.quit()
}

const isExtensionUrl = (url) =>
  typeof url === 'string' && (url === extensionDirUrl || url.startsWith(extensionDirUrl + '/'))

const extensionUrlToRelativePath = (url) => url.slice(extensionDirUrl.length).replace(/^\//, '')

// ---------------------------------------------------------------------------
// Hub state

let storageHub = null
let backgroundWindow = null
let mainPanelWindow = null
let tray = null

const secondaryPanelWindows = new Set()
const windowIdsForRuntime = new Map() // BrowserWindow id (returned to shim) -> BrowserWindow

const ports = new Map() // portId -> { name, clientWebContents }
const pendingRuntimeCalls = new Map() // callId -> { resolve, expected: Set<WebContents> }
let runtimeCallSeq = 0

const liveWebContents = () => {
  const all = []
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) all.push(win.webContents)
  }
  return all
}

const backgroundContents = () =>
  backgroundWindow && !backgroundWindow.isDestroyed() && !backgroundWindow.webContents.isDestroyed()
    ? backgroundWindow.webContents
    : null

// ---------------------------------------------------------------------------
// Storage bridge

const attachStorageHub = () => {
  storageHub = new StorageHub({
    filePath: path.join(app.getPath('userData'), 'storage.json'),
    onChanged: (changes) => {
      for (const contents of liveWebContents()) {
        contents.send('cgb:storage:onChanged', changes)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// runtime.sendMessage routing (request/response, first non-undefined wins)

const settleRuntimeCall = (callId) => {
  const call = pendingRuntimeCalls.get(callId)
  if (!call) return
  if (call.expected.size === 0) {
    pendingRuntimeCalls.delete(callId)
    call.resolve(call.resolved ? call.value : undefined)
  }
}

const handleRuntimeSendMessage = (event, message) => {
  const targets = liveWebContents().filter((contents) => contents !== event.sender)
  if (targets.length === 0) return Promise.resolve(undefined)

  const callId = 'runtime-call-' + ++runtimeCallSeq
  return new Promise((resolve) => {
    pendingRuntimeCalls.set(callId, { resolve, expected: new Set(targets), resolved: false })
    for (const target of targets) {
      target.send('cgb:runtime:message', {
        callId,
        message,
        sender: { id: RUNTIME_ID, url: extensionDirUrl + '/' },
      })
    }
  })
}

const handleRuntimeReply = (event, payload) => {
  const { callId, response } = payload || {}
  const call = pendingRuntimeCalls.get(callId)
  if (!call) return
  if (response !== undefined && !call.resolved) {
    call.resolved = true
    call.value = response
    pendingRuntimeCalls.delete(callId)
    call.resolve(response)
    return
  }
  call.expected.delete(event.sender)
  settleRuntimeCall(callId)
}

const handleTargetGone = (contents) => {
  for (const [callId, call] of pendingRuntimeCalls) {
    if (call.expected.delete(contents)) settleRuntimeCall(callId)
  }
}

// ---------------------------------------------------------------------------
// runtime.connect port routing (panel <-> background host)

const notifyPortDisconnected = (portId, side) => {
  const contents = side === 'background' ? backgroundContents() : ports.get(portId)?.client
  if (contents && !contents.isDestroyed()) contents.send(`cgb:port:disconnected:${portId}`)
}

const handlePortConnect = (event, payload) => {
  const { portId, name } = payload || {}
  const background = backgroundContents()
  if (!background) {
    event.sender.send(`cgb:port:disconnected:${portId}`)
    return
  }
  ports.set(portId, { name, client: event.sender })
  background.send('cgb:port:connect', {
    portId,
    name,
    sender: { id: RUNTIME_ID, url: extensionDirUrl + '/' },
  })
}

const handlePortPost = (event, payload) => {
  const { portId, msg } = payload || {}
  const entry = ports.get(portId)
  if (!entry) return
  if (entry.client === event.sender) {
    const background = backgroundContents()
    if (background) background.send(`cgb:port:message:${portId}`, msg)
    else notifyPortDisconnected(portId, 'client')
  } else if (backgroundContents() === event.sender) {
    if (!entry.client.isDestroyed()) entry.client.send(`cgb:port:message:${portId}`, msg)
  }
}

const handlePortDisconnect = (event, payload) => {
  const { portId } = payload || {}
  if (!ports.has(portId)) return
  const fromClient = ports.get(portId).client === event.sender
  ports.delete(portId)
  if (fromClient) notifyPortDisconnected(portId, 'background')
  else notifyPortDisconnected(portId, 'client')
}

const disconnectAllPorts = () => {
  for (const portId of [...ports.keys()]) {
    notifyPortDisconnected(portId, 'client')
    notifyPortDisconnected(portId, 'background')
    ports.delete(portId)
  }
}

// ---------------------------------------------------------------------------
// tabs / windows bridge

const openExtensionWindowFromUrl = (url, { width, height } = {}) => {
  const relativePath = extensionUrlToRelativePath(url) || 'IndependentPanel.html'
  return createPanelWindow(relativePath, { width, height, secondary: true })
}

const handleTabsCreate = async (event, payload) => {
  const { url } = payload || {}
  if (isExtensionUrl(url)) {
    const win = openExtensionWindowFromUrl(url)
    return { id: win.id }
  }
  if (typeof url === 'string') await shell.openExternal(url)
  return { id: -1 }
}

const handleWindowsCreate = (event, payload) => {
  const { url, width, height } = payload || {}
  const target = isExtensionUrl(url)
    ? url
    : pathToFileURL(path.join(extensionDir, 'IndependentPanel.html')).href
  const win = openExtensionWindowFromUrl(target, { width, height })
  return { id: win.id }
}

const handleWindowsUpdate = (event, payload) => {
  const { windowId, updateProperties } = payload || {}
  const win = windowIdsForRuntime.get(windowId)
  if (win && !win.isDestroyed() && updateProperties && updateProperties.focused) {
    win.show()
    win.focus()
  }
  return {}
}

// ---------------------------------------------------------------------------
// Windows

const baseWindowArgs = (role) => [
  '--cgb-role=' + role,
  '--cgb-ext-dir=' + extensionDir,
  '--cgb-runtime-id=' + RUNTIME_ID,
]

const baseWebPreferences = {
  preload: path.join(desktopDir, 'preload', 'extension-shim.cjs'),
  contextIsolation: false,
  sandbox: false,
  nodeIntegration: false,
}

const createBackgroundWindow = () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      ...baseWebPreferences,
      additionalArguments: [
        ...baseWindowArgs('background'),
        '--cgb-bg-bundle=' + pathToFileURL(path.join(extensionDir, 'background.js')).href,
      ],
      // Mirror the extension's host permissions: the background bundle fetches AI
      // providers cross-origin from this hidden page.
      webSecurity: false,
      backgroundThrottling: false,
    },
  })
  win.loadFile(path.join(__dirname, 'background-host.html'))
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[desktop] background host crashed:', details.reason)
    disconnectAllPorts()
    if (!win.isDestroyed()) win.destroy()
    backgroundWindow = createBackgroundWindow()
  })
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('[desktop:background]', message)
  })
  return win
}

const createPanelWindow = (
  targetPath = 'IndependentPanel.html',
  { width, height, secondary } = {},
) => {
  const isSettings = targetPath.startsWith('popup')
  const win = new BrowserWindow({
    width: width || (isSettings ? 520 : 460),
    height: height || (isSettings ? 680 : 720),
    title: 'ChatGPTBox',
    icon: path.join(extensionDir, 'logo.png'),
    autoHideMenuBar: true,
    webPreferences: {
      ...baseWebPreferences,
      additionalArguments: baseWindowArgs(secondary ? 'extension' : 'panel'),
    },
  })
  windowIdsForRuntime.set(win.id, win)
  win.on('closed', () => {
    windowIdsForRuntime.delete(win.id)
    secondaryPanelWindows.delete(win)
  })
  win.loadFile(path.join(extensionDir, targetPath))
  if (secondary) secondaryPanelWindows.add(win)
  return win
}

const getOrCreateMainPanel = () => {
  if (mainPanelWindow && !mainPanelWindow.isDestroyed()) return mainPanelWindow
  mainPanelWindow = createPanelWindow()
  mainPanelWindow.on('close', (event) => {
    // Tray-resident app: hide instead of quitting; use the tray menu to exit.
    event.preventDefault()
    mainPanelWindow.hide()
  })
  return mainPanelWindow
}

const togglePanel = () => {
  const panel = getOrCreateMainPanel()
  if (panel.isVisible() && panel.isFocused()) {
    panel.hide()
  } else {
    panel.show()
    panel.focus()
  }
}

// ---------------------------------------------------------------------------
// Tray + global shortcut (TODO.md: 桌面端通过全局快捷键触发)

const createTray = () => {
  const iconPath = path.join(extensionDir, 'logo.png')
  const image = nativeImage.createFromPath(iconPath)
  const trayIcon = image.isEmpty() ? undefined : image.resize({ width: 16, height: 16 })
  if (!trayIcon) return null
  tray = new Tray(trayIcon)
  tray.setToolTip('ChatGPTBox')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Chat Panel', click: () => togglePanel() },
      { label: 'Settings', click: () => createPanelWindow('popup.html', { secondary: true }) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
  tray.on('click', () => togglePanel())
  return tray
}

const registerGlobalShortcut = () => {
  const success = globalShortcut.register(TOGGLE_SHORTCUT, togglePanel)
  if (!success) console.warn(`[desktop] failed to register global shortcut ${TOGGLE_SHORTCUT}`)
  else console.log(`[desktop] global shortcut registered: ${TOGGLE_SHORTCUT} (toggle chat panel)`)
}

// ---------------------------------------------------------------------------
// IPC wiring

const attachIpcHandlers = () => {
  ipcMain.handle('cgb:storage:get', (_event, keys) => storageHub.get(keys))
  ipcMain.handle('cgb:storage:set', (_event, values) => storageHub.set(values))
  ipcMain.handle('cgb:storage:remove', (_event, keys) => storageHub.remove(keys))
  ipcMain.handle('cgb:storage:clear', () => storageHub.clear())

  ipcMain.handle('cgb:runtime:sendMessage', handleRuntimeSendMessage)
  ipcMain.on('cgb:runtime:reply', handleRuntimeReply)

  ipcMain.on('cgb:port:connect', handlePortConnect)
  ipcMain.on('cgb:port:post', handlePortPost)
  ipcMain.on('cgb:port:disconnect', handlePortDisconnect)

  ipcMain.handle('cgb:tabs:create', handleTabsCreate)
  ipcMain.handle('cgb:windows:create', handleWindowsCreate)
  ipcMain.handle('cgb:windows:update', handleWindowsUpdate)

  app.on('web-contents-created', (_event, contents) => {
    contents.on('destroyed', () => handleTargetGone(contents))
  })
}

// ---------------------------------------------------------------------------
// App lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const panel = getOrCreateMainPanel()
    panel.show()
    panel.focus()
  })

  app.whenReady().then(() => {
    console.log(`[desktop] extension dir: ${extensionDir}`)
    attachStorageHub()
    attachIpcHandlers()
    backgroundWindow = createBackgroundWindow()
    getOrCreateMainPanel()
    createTray()
    registerGlobalShortcut()
    console.log('[desktop] ready')

    app.on('activate', () => {
      getOrCreateMainPanel().show()
    })
  })

  app.on('window-all-closed', () => {
    // Keep running from the tray while the hidden background host exists.
    if (backgroundWindow && !backgroundWindow.isDestroyed()) return
    app.quit()
  })

  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
    if (storageHub) storageHub.persist()
    if (backgroundWindow && !backgroundWindow.isDestroyed()) {
      backgroundWindow.destroy()
      backgroundWindow = null
    }
  })
}
