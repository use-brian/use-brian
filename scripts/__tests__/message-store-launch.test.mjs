import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMessageStoreLaunch } from '../message-store-launch.mjs'

const root = '/repo/sidanclaw-platform/use-brian'

test('[COMP:platform/local-message-store-lifecycle] discovers the sibling Go checkout', () => {
  const result = resolveMessageStoreLaunch({
    root,
    env: {},
    exists: (path) => path === '/repo/brian-message-store/go.mod',
  })
  assert.deepEqual(result, {
    enabled: true,
    cmd: 'go',
    args: ['run', './cmd/brian-message-store'],
    cwd: '/repo/brian-message-store',
    source: 'source',
  })
})

test('[COMP:platform/local-message-store-lifecycle] prefers an explicit binary', () => {
  const result = resolveMessageStoreLaunch({
    root,
    env: { BRIAN_MESSAGE_STORE_BIN: '/opt/usebrian/message-store' },
    exists: (path) => path === '/opt/usebrian/message-store',
  })
  assert.equal(result.enabled, true)
  assert.equal(result.cmd, '/opt/usebrian/message-store')
  assert.equal(result.source, 'binary')
})

test('[COMP:platform/local-message-store-lifecycle] can be explicitly disabled', () => {
  assert.deepEqual(
    resolveMessageStoreLaunch({ root, env: { BRIAN_MESSAGE_STORE_ENABLED: '0' } }),
    { enabled: false, reason: 'disabled' },
  )
})

test('[COMP:platform/local-message-store-lifecycle] explicit enable fails when missing', () => {
  assert.throws(
    () => resolveMessageStoreLaunch({
      root,
      env: { BRIAN_MESSAGE_STORE_ENABLED: '1' },
      exists: () => false,
    }),
    /no binary or Go checkout was found/,
  )
})
