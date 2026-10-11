/* eslint-env node */
// Windows packaging pipeline, mirroring safari/build.sh on macOS:
//   1. build the extension (root `npm run build` -> build/firefox, MV2)
//   2. stage extension assets for the desktop shell (build/desktop/extension)
//   3. package with electron-builder -> build/win/ChatGPTBox-Setup-<version>.exe (+ portable zip)
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const rootDir = path.dirname(desktopDir)
const firefoxBuildDir = path.join(rootDir, 'build', 'firefox')
const stagingDir = path.join(rootDir, 'build', 'desktop', 'extension')
const outputDir = path.join(rootDir, 'build', 'win')

const log = (message) => console.log(`[build:win] ${message}`)
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`command failed (${command} ${args.join(' ')}) with exit code ${result.status}`)
  }
  return result
}

const copyDir = (from, to, filter) => {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) {
      copyDir(src, dst, filter)
    } else if (!filter || filter(entry.name)) {
      fs.copyFileSync(src, dst)
    }
  }
}

// Content scripts never run in the desktop shell; skip them and build maps to keep
// the packaged app small.
const stageExtension = () => {
  fs.rmSync(stagingDir, { recursive: true, force: true })
  copyDir(firefoxBuildDir, stagingDir, (name) => {
    const lower = name.toLowerCase()
    if (lower.endsWith('.map')) return false
    if (lower.startsWith('content-script')) return false
    if (lower.endsWith('.zip')) return false
    return true
  })
  log(`staged extension assets -> ${stagingDir}`)
}

const readPngSize = (file) => {
  const header = fs.readFileSync(file).subarray(16, 24)
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) }
}

const prepareIcon = () => {
  const source = path.join(rootDir, 'src', 'logo.png')
  const resourcesDir = path.join(desktopDir, 'build-resources')
  const target = path.join(resourcesDir, 'icon.png')
  fs.mkdirSync(resourcesDir, { recursive: true })
  const { width, height } = readPngSize(source)
  // electron-builder converts a >=256px png into a Windows .ico automatically.
  if (width >= 256 && height >= 256) {
    fs.copyFileSync(source, target)
    log(`icon ready (${width}x${height}) -> ${target}`)
    return ['--config.win.icon=build-resources/icon.png']
  }
  log(`logo.png is ${width}x${height}; below 256px, keeping the default Electron icon`)
  return []
}

const packageApp = (version) => {
  const builderBin = path.join(desktopDir, 'node_modules', '.bin', 'electron-builder')
  const builderCmd = process.platform === 'win32' ? builderBin + '.cmd' : builderBin
  const args = [
    '--win',
    'nsis',
    'zip',
    '--config.extraMetadata.version=' + version,
    ...prepareIcon(),
  ]
  // Helps on networks where GitHub-hosted builder binaries (nsis, winCodeSign) are slow.
  const env = {
    ...process.env,
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
      'https://npmmirror.com/mirrors/electron-builder-binaries/',
  }
  log('running electron-builder (this downloads tooling on first use and may take a while)')
  run(builderCmd, args, { cwd: desktopDir, env })
}

const main = () => {
  log('building extension (root npm run build)')
  run('npm', ['run', 'build'], { cwd: rootDir })
  stageExtension()

  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'src', 'manifest.json'), 'utf8'))
  log(`packaging ChatGPTBox desktop v${manifest.version}`)

  fs.mkdirSync(outputDir, { recursive: true })
  packageApp(manifest.version)

  const artifacts = fs.readdirSync(outputDir).filter((name) => !name.startsWith('builder-'))
  if (artifacts.length === 0) throw new Error('no artifacts produced in ' + outputDir)
  log('artifacts:')
  for (const artifact of artifacts) log('  ' + path.join(outputDir, artifact))
}

try {
  main()
} catch (error) {
  console.error('[build:win] failed:', error.message)
  process.exit(1)
}
