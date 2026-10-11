import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveStorageGet,
  applyStorageSet,
  applyStorageRemove,
  computeStorageChanges,
} from '../../../desktop/main/storage-core.mjs'

test('resolveStorageGet supports null, string, array and object-with-defaults forms', () => {
  const state = { apiKey: 'k', modelName: 'gpt', nested: { a: 1 } }

  assert.deepEqual(resolveStorageGet(state, null), state)
  assert.deepEqual(resolveStorageGet(state, undefined), state)
  assert.deepEqual(resolveStorageGet(state, 'apiKey'), { apiKey: 'k' })
  assert.deepEqual(resolveStorageGet(state, 'missing'), {})
  assert.deepEqual(resolveStorageGet(state, ['apiKey', 'missing']), { apiKey: 'k' })
  assert.deepEqual(resolveStorageGet(state, { missing: 42, apiKey: undefined }), {
    missing: 42,
    apiKey: 'k',
  })
})

test('applyStorageSet merges values and reports changed keys', () => {
  const state = { apiKey: 'old', modelName: 'gpt' }
  const { state: next, changes } = applyStorageSet(state, { apiKey: 'new', extra: true })

  assert.deepEqual(next, { apiKey: 'new', modelName: 'gpt', extra: true })
  assert.deepEqual(Object.keys(changes).sort(), ['apiKey', 'extra'])
  assert.equal(changes.apiKey.oldValue, 'old')
  assert.equal(changes.apiKey.newValue, 'new')
  assert.equal(changes.extra.newValue, true)
  assert.equal('oldValue' in changes.extra, false)

  const untouched = applyStorageSet(state, {})
  assert.deepEqual(untouched.changes, {})
})

test('applyStorageRemove handles string, array and null (clear all)', () => {
  const state = { a: 1, b: 2, c: 3 }

  const stringRemoval = applyStorageRemove(state, 'a')
  assert.deepEqual(stringRemoval.state, { b: 2, c: 3 })
  assert.equal(stringRemoval.changes.a.oldValue, 1)

  const arrayRemoval = applyStorageRemove(state, ['a', 'c'])
  assert.deepEqual(arrayRemoval.state, { b: 2 })

  const clearAll = applyStorageRemove(state, null)
  assert.deepEqual(clearAll.state, {})
  assert.equal(clearAll.changes.b.oldValue, 2)
  assert.equal('newValue' in clearAll.changes.b, false)
})

test('computeStorageChanges treats same-value writes as unchanged', () => {
  const oldState = { same: 1, differs: 'x', dropped: true }
  const newState = { same: 1, differs: 'y', added: 'z' }
  const changes = computeStorageChanges(oldState, newState)

  assert.deepEqual(Object.keys(changes).sort(), ['added', 'differs', 'dropped'])
  assert.equal('oldValue' in changes.added, false)
  assert.equal(changes.differs.oldValue, 'x')
  assert.equal(changes.differs.newValue, 'y')
  assert.equal('newValue' in changes.dropped, false)
})
