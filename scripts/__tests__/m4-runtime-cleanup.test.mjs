/** [COMP:invariants/chat-import-graph] Actual owned-process lifecycle, no fixture credentials. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { stopOwnedApiChild } from '../testing/chat-import-receipt.mjs'

test('runtime receipt waits for the exact owned process to exit', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  await once(child.stdout, 'data')
  const result = await stopOwnedApiChild(child, 1000)
  assert.equal(result.pid, child.pid)
  assert.equal(result.forced, false)
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  assert.ok(result.finishedAt >= result.startedAt)
})

test('a child ignoring TERM is killed within the bounded cleanup window', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  await once(child.stdout, 'data')
  const result = await stopOwnedApiChild(child, 50)
  assert.equal(result.forced, true)
  assert.equal(child.signalCode, 'SIGKILL')
})
