/* eslint-env node */
// JSON-file backed implementation of browser.storage.local for the desktop app.
// The main process owns the file so every window (panel, settings, background host)
// observes a consistent state through the router's onChanged broadcast.
import fs from 'node:fs'
import path from 'node:path'
import { applyStorageRemove, applyStorageSet, resolveStorageGet } from './storage-core.mjs'

const PERSIST_DELAY_MS = 300

export class StorageHub {
  constructor({ filePath, onChanged }) {
    this.filePath = filePath
    this.onChanged = onChanged || (() => {})
    this.state = this.load()
    this.persistTimer = null
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  async get(keys) {
    return resolveStorageGet(this.state, keys)
  }

  async set(values) {
    const { state, changes } = applyStorageSet(this.state, values)
    this.state = state
    if (Object.keys(changes).length > 0) {
      this.schedulePersist()
      this.onChanged(changes)
    }
    return undefined
  }

  async remove(keys) {
    const { state, changes } = applyStorageRemove(this.state, keys)
    this.state = state
    if (Object.keys(changes).length > 0) {
      this.schedulePersist()
      this.onChanged(changes)
    }
    return undefined
  }

  async clear() {
    return this.remove(null)
  }

  schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persist()
    }, PERSIST_DELAY_MS)
  }

  persist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8')
  }
}
