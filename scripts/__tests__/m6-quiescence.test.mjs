import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acknowledge, checkQuiescence, runOwned } from '../testing/m6/quiescence.mjs'

test('quiet requires explicit owners and real exit receipts; a new job invalidates the hold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm6-quiet-')), freezeId = 'test-freeze'
  try {
    assert.throws(() => checkQuiescence({ dir, freezeId, owners: [] }), /nonempty/)
    assert.equal(checkQuiescence({ dir, freezeId, owners: ['test'] }).controlledTaskWorkload, false)
    const run = await runOwned({ dir, freezeId, owner: 'test', command: [process.execPath, '-e', 'setTimeout(()=>{},40)'] })
    assert.equal(run.exitCode, 0); assert.equal(run.processQuiet, true); assert.ok(run.processes.length)
    acknowledge({ dir, freezeId, owner: 'test' })
    assert.equal(checkQuiescence({ dir, freezeId, owners: ['test'] }).controlledTaskWorkload, true)
    await runOwned({ dir, freezeId, owner: 'test', command: [process.execPath, '-e', ''] })
    assert.equal(checkQuiescence({ dir, freezeId, owners: ['test'] }).controlledTaskWorkload, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fixture disposal, acknowledgement freshness and receipt bytes fail closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm6-quiet-')), freezeId = 'test-freeze'
  try {
    assert.throws(() => acknowledge({ dir, freezeId, owner: 'test', noWorkloads: true, fixtures: [dir] }), /still exists/)
    acknowledge({ dir, freezeId, owner: 'test', noWorkloads: true })
    assert.equal(checkQuiescence({ dir, freezeId, owners: ['test'] }).controlledTaskWorkload, true)
    const path = join(dir, freezeId, 'acks/test.json'), ack = JSON.parse(readFileSync(path))
    ack.checkedAt = '2000-01-01T00:00:00.000Z'; writeFileSync(path, JSON.stringify(ack))
    assert.equal(checkQuiescence({ dir, freezeId, owners: ['test'] }).controlledTaskWorkload, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
