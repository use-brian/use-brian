import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { bootstrapNegative } from './bootstrap-negative.mjs'

function fake() {
  const child = new EventEmitter()
  child.pid = 123
  for (const key of ['stdin', 'stdout', 'stderr']) {
    child[key] = new EventEmitter()
    child[key].destroy = () => { child[key].destroyed = true }
  }
  child.stdin.writableEnded = false
  child.stdin.end = () => {
    child.stdin.writableEnded = true
    child.stdin.emit('finish')
  }
  child.kills = []
  child.kill = signal => { child.kills.push(signal); return true }
  child.unref = () => { child.unreferenced = true }
  return child
}
function run(child, options = {}) {
  return bootstrapNegative('/never-executed', {
    spawnChild: (binary, args, opts) => {
      assert.equal(binary, '/never-executed')
      assert.deepEqual(args, [])
      assert.deepEqual(opts, { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
      return child
    }, deadlineMs: 100, killGraceMs: 10, ...options,
  })
}

test('holds stdin open; exit and stdout EOF alone do not settle; close 77 succeeds', async () => {
  const child = fake()
  let settled = false
  const promise = run(child).then(result => { settled = true; return result })
  assert.equal(child.stdin.writableEnded, false)
  child.stdout.emit('end')
  child.emit('exit', 77, null)
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(child.stdin.destroyed, undefined)
  child.emit('close', 77, null)
  assert.deepEqual(await promise, { code: 77, stdoutBytes: 0 })
  assert.deepEqual(child.kills, [])
})

test('late stdout between exit and close fails', async () => {
  const child = fake(), promise = run(child)
  child.emit('exit', 77, null)
  child.stdout.emit('data', Buffer.from('late authority data'))
  child.emit('close', 77, null)
  await assert.rejects(promise, /Unexpected stdout/)
})

test('premature stdin EOF cannot manufacture a passing refusal', async () => {
  const child = fake(), promise = run(child)
  child.stdin.end()
  child.emit('close', 77, null)
  await assert.rejects(promise, /stdin ended/)
})

test('stdout EOF without close reaches deadline, never passes', async () => {
  const child = fake(), promise = run(child, { deadlineMs: 5 })
  child.stdout.emit('end')
  await assert.rejects(promise, /deadline exceeded.*close not observed/)
  assert.deepEqual(child.kills, ['SIGKILL'])
  assert.equal(child.unreferenced, true)
})

test('bounds and discards stderr', async () => {
  const child = fake(), promise = run(child, { maxOutputBytes: 4 })
  child.stderr.emit('data', Buffer.alloc(5))
  child.emit('close', 77, null)
  await assert.rejects(promise, /output limit/)
})

test('bounded stderr alone is not protocol output', async () => {
  const child = fake(), promise = run(child)
  child.stderr.emit('data', Buffer.from('diagnostic'))
  child.emit('close', 77, null)
  await promise
})

for (const [code, signal] of [[0, null], [70, null], [null, 'SIGKILL']]) {
  test(`rejects close ${code}/${signal}`, async () => {
    const child = fake(), promise = run(child)
    child.emit('close', code, signal)
    await assert.rejects(promise, /Expected bootstrap refusal/)
  })
}

test('synchronous spawn failure', async () => {
  await assert.rejects(bootstrapNegative('missing', { spawnChild() { throw new Error('ENOENT') } }), /ENOENT/)
})

test('asynchronous spawn error followed by close', async () => {
  const child = fake(), promise = run(child)
  child.emit('error', new Error('ENOENT'))
  child.emit('close', -2, null)
  await assert.rejects(promise, /spawn\/process error: ENOENT/)
})

for (const mode of ['false', 'throw']) {
  test(`kill ${mode} is bounded and reported, no close required`, async () => {
    const child = fake()
    child.kill = () => { if (mode === 'throw') throw new Error('EPERM'); return false }
    const promise = run(child, { deadlineMs: 5 })
    await assert.rejects(promise, mode === 'throw' ? /SIGKILL failed: EPERM/ : /SIGKILL was not delivered/)
    assert.equal(child.unreferenced, true)
  })
}

test('stream errors fail rather than becoming refusal evidence', async () => {
  const child = fake(), promise = run(child)
  child.stdin.emit('error', new Error('EPIPE'))
  child.emit('close', 77, null)
  await assert.rejects(promise, /stream error: EPIPE/)
  // A late error must not become an unhandled EventEmitter error.
  child.stdout.emit('error', new Error('late'))
})

test('CLI keeps macOS gate on non-Mac hosts', { skip: process.platform === 'darwin' }, () => {
  const result = spawnSync(process.execPath, [new URL('./bootstrap-negative.mjs', import.meta.url).pathname, '/never-executed'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /requires macOS/)
})
