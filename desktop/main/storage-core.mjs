// Pure webextension storage-area semantics shared by the desktop storage hub and its tests.
// Mirrors the behavior of browser.storage.local as relied on by src/config and src/services.

const hasOwn = (state, key) => Object.prototype.hasOwnProperty.call(state, key)

export const resolveStorageGet = (state, keys) => {
  if (keys === null || keys === undefined) return { ...state }

  if (typeof keys === 'string') {
    return hasOwn(state, keys) ? { [keys]: state[keys] } : {}
  }

  if (Array.isArray(keys)) {
    const result = {}
    for (const key of keys) {
      if (hasOwn(state, key)) result[key] = state[key]
    }
    return result
  }

  if (typeof keys === 'object') {
    const result = {}
    for (const [key, defaultValue] of Object.entries(keys)) {
      result[key] = hasOwn(state, key) ? state[key] : defaultValue
    }
    return result
  }

  return {}
}

export const computeStorageChanges = (oldState, newState) => {
  const changes = {}
  const keys = new Set([...Object.keys(oldState), ...Object.keys(newState)])
  for (const key of keys) {
    const oldValue = hasOwn(oldState, key) ? oldState[key] : undefined
    const newValue = hasOwn(newState, key) ? newState[key] : undefined
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes[key] = {
        ...(hasOwn(oldState, key) ? { oldValue } : {}),
        ...(hasOwn(newState, key) ? { newValue } : {}),
      }
    }
  }
  return changes
}

export const applyStorageSet = (state, values) => {
  if (!values || typeof values !== 'object') return { state, changes: {} }
  const newState = { ...state }
  for (const [key, value] of Object.entries(values)) {
    newState[key] = value
  }
  return { state: newState, changes: computeStorageChanges(state, newState) }
}

export const applyStorageRemove = (state, keys) => {
  if (keys === null || keys === undefined) {
    return { state: {}, changes: computeStorageChanges(state, {}) }
  }
  const keyList = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []
  const newState = { ...state }
  const removed = {}
  for (const key of keyList) {
    if (hasOwn(newState, key)) {
      removed[key] = newState[key]
      delete newState[key]
    }
  }
  return { state: newState, changes: computeStorageChanges(removed, {}) }
}
