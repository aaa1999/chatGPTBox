/* eslint-env node */
// Launch the ChatGPTBox desktop shell against the local extension build (build/firefox).
// Run "npm run build" at the repo root first if the build output is missing.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const rootDir = path.dirname(desktopDir)
const extensionDir = process.env.CGB_EXTENSION_DIR || path.join(rootDir, 'build', 'firefox')

if (!fs.existsSync(path.join(extensionDir, 'background.js'))) {
  console.error(`[desktop] extension build not found at ${extensionDir}`)
  console.error('[desktop] run "npm run build" at the repo root first, then retry')
  process.exit(1)
}

let electronPath
try {
  // In plain Node the electron package resolves to the path of its binary.
  electronPath = require('electron')
} catch (error) {
  console.error(
    '[desktop] electron is not installed. Run "npm install" inside desktop/ first.',
    error,
  )
  process.exit(1)
}

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  cwd: desktopDir,
  env: { ...process.env, CGB_EXTENSION_DIR: extensionDir, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: 'inherit',
  windowsHide: false,
})

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (error) => {
  console.error('[desktop] failed to start electron:', error)
  process.exit(1)
})
