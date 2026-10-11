/* eslint-env node */
// Preload shim exposing a webextension-polyfill-compatible `window.browser` in every
// desktop window. Runs before page scripts (contextIsolation off); the bundled
// webextension-polyfill detects the plain-object `browser` global and re-exports it,
// so `import Browser from 'webextension-polyfill'` resolves to this shim.
//
// Storage and runtime messaging are bridged over IPC to the main process hub; APIs that
// only make sense inside a real browser (content-script tabs, webRequest, cookies,
// context menus) are inert stubs so the extension bundles load and run unmodified.
const { ipcRenderer } = require('electron')
const { pathToFileURL } = require('url')
const path = require('path')
const fs = require('fs')

const parseArg = (name) => {
  const prefix = '--cgb-' + name + '='
  const match = process.argv.find((arg) => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : undefined
}

const extDir = parseArg('ext-dir')
const runtimeId = parseArg('runtime-id') || 'chatgptbox-desktop'
const role = parseArg('role') || 'panel'
const backgroundBundleUrl = parseArg('bg-bundle')

const extensionDirUrl = extDir ? pathToFileURL(extDir).href : 'file:///'

// Extension event objects. `_run` additionally returns each listener's raw return
// value so onMessage reply semantics (first non-undefined result wins) can be honored.
const createEvent = () => {
  const listeners = new Set()
  return {
    addListener(listener) {
      if (typeof listener === 'function') listeners.add(listener)
    },
    removeListener(listener) {
      listeners.delete(listener)
    },
    hasListener(listener) {
      return listeners.has(listener)
    },
    _emit(...args) {
      this._run(...args)
    },
    _run(...args) {
      const results = []
      for (const listener of Array.from(listeners)) {
        try {
          results.push(listener(...args))
        } catch (error) {
          console.error('[desktop-shim] listener error:', error)
          results.push(undefined)
        }
      }
      return results
    },
  }
}

const getURL = (resourcePath) => {
  if (typeof resourcePath !== 'string' || resourcePath === '' || resourcePath === '/') {
    return extensionDirUrl + '/'
  }
  return extensionDirUrl + '/' + resourcePath.replace(/^\/+/, '')
}

let cachedManifest = null
const getManifest = () => {
  if (!cachedManifest) {
    try {
      cachedManifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'))
    } catch (error) {
      console.error('[desktop-shim] failed to read manifest.json:', error)
      cachedManifest = { name: 'ChatGPTBox', version: '0.0.0', manifest_version: 2 }
    }
  }
  return cachedManifest
}

// ---------------------------------------------------------------------------
// storage.local

const storageOnChanged = createEvent()
ipcRenderer.on('cgb:storage:onChanged', (_event, changes) => {
  storageOnChanged._emit(changes, 'local')
})

const storageLocal = {
  get: (keys) => ipcRenderer.invoke('cgb:storage:get', keys),
  set: (values) => ipcRenderer.invoke('cgb:storage:set', values),
  remove: (keys) => ipcRenderer.invoke('cgb:storage:remove', keys),
  clear: () => ipcRenderer.invoke('cgb:storage:clear'),
  // The extension reads onChanged from both storage.onChanged (chromium style)
  // and storage.local.onChanged (firefox style); back both with one event.
  onChanged: storageOnChanged,
}

const storage = {
  local: storageLocal,
  onChanged: storageOnChanged,
}

// ---------------------------------------------------------------------------
// runtime messaging (sendMessage / onMessage with reply correlation)

const runtimeOnMessage = createEvent()

ipcRenderer.on('cgb:runtime:message', (_event, { callId, message, sender }) => {
  const results = runtimeOnMessage._run(message, sender)
  const immediate = results.find((r) => r !== undefined && typeof r?.then !== 'function')
  if (immediate !== undefined) {
    ipcRenderer.send('cgb:runtime:reply', { callId, response: immediate })
    return
  }
  const pending = results.filter((r) => r && typeof r.then === 'function')
  Promise.all(pending.map((p) => Promise.resolve(p).catch(() => undefined))).then((values) => {
    ipcRenderer.send('cgb:runtime:reply', { callId, response: values.find((v) => v !== undefined) })
  })
})

const sendMessage = (...args) => {
  const message = args.length > 1 && typeof args[0] === 'string' ? args[1] : args[0]
  return ipcRenderer.invoke('cgb:runtime:sendMessage', message)
}

// ---------------------------------------------------------------------------
// runtime ports

let portSeq = 0
const makePort = ({ portId, name, sender }) => {
  const onMessage = createEvent()
  const onDisconnect = createEvent()
  ipcRenderer.on(`cgb:port:message:${portId}`, (_event, msg) => {
    onMessage._emit(msg)
  })
  ipcRenderer.once(`cgb:port:disconnected:${portId}`, () => {
    onDisconnect._emit()
  })
  return {
    portId,
    name,
    sender,
    postMessage: (msg) => ipcRenderer.send('cgb:port:post', { portId, msg }),
    onMessage,
    onDisconnect,
    disconnect: () => ipcRenderer.send('cgb:port:disconnect', { portId }),
  }
}

const runtimeOnConnect = createEvent()
if (role === 'background') {
  ipcRenderer.on('cgb:port:connect', (_event, { portId, name, sender }) => {
    runtimeOnConnect._emit(makePort({ portId, name, sender }))
  })
}

const runtime = {
  id: runtimeId,
  getURL,
  getManifest,
  sendMessage,
  connect: (connectInfo) => {
    const portId = 'port-' + ++portSeq + '-' + Math.random().toString(36).slice(2, 8)
    const port = makePort({
      portId,
      name: connectInfo?.name,
      sender: { id: runtimeId, url: getURL('/') },
    })
    ipcRenderer.send('cgb:port:connect', { portId, name: port.name })
    return port
  },
  onMessage: runtimeOnMessage,
  onConnect: runtimeOnConnect,
  get lastError() {
    return null
  },
}

// ---------------------------------------------------------------------------
// Stubbed browser APIs (tabs / webRequest / cookies / menus / commands / ...)

const tabs = {
  query: async () => [],
  get: async (tabId) => {
    throw new Error(`No tab with id: ${tabId}`)
  },
  update: async () => {},
  sendMessage: async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.')
  },
  connect: () => {
    throw new Error('tabs.connect is not supported in the desktop app')
  },
  create: (createProperties) => ipcRenderer.invoke('cgb:tabs:create', createProperties),
  onUpdated: createEvent(),
}

const windows = {
  create: (createData) => ipcRenderer.invoke('cgb:windows:create', createData),
  update: (windowId, updateProperties) =>
    ipcRenderer.invoke('cgb:windows:update', { windowId, updateProperties }),
}

// window.browser must be a plain object so the bundled webextension-polyfill
// re-exports it as-is; the polyfill additionally requires a chrome global with
// runtime.id to accept its environment, so expose the same shim under both names.
window.browser = {
  runtime,
  storage,
  tabs,
  windows,
  cookies: {
    get: async () => null,
    getAll: async () => [],
    set: async () => {},
  },
  contextMenus: {
    removeAll: async () => {},
    create: () => ({}),
    onClicked: createEvent(),
  },
  commands: {
    onCommand: createEvent(),
  },
  permissions: {
    request: async () => true,
    remove: async () => true,
    contains: async () => false,
  },
  webRequest: {
    onBeforeRequest: createEvent(),
    onBeforeSendHeaders: createEvent(),
  },
  sidePanel: {
    setOptions: async () => {},
    setPanelBehavior: async () => {},
  },
  action: {
    setBadgeText: async () => {},
    setTitle: async () => {},
  },
}

window.chrome = window.browser

window.__CGB__ = {
  role,
  runtimeId,
  extensionDir: extDir,
  getURL,
  backgroundBundleUrl,
}
