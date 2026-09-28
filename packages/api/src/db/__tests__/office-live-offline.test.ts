import { describe, expect, it } from 'vitest'
import { appendOfficeCommand, encodeOfficeState, snapshotToYDoc, type OfficeCommand } from '@use-brian/office-model'
import { completePresentationSnapshot, id } from '../../../../core/src/office/__tests__/fixtures.js'
import { createOfficeLiveStore } from '../office-live.js'
import type { OfficeDbQuery } from '../office-artifacts.js'

function command(artifactId: string, commandId: string, targetId = id(34), value = 'center'): OfficeCommand {
  return { artifactId, baseVersion: 4, actor: { type: 'user', id: id(900) }, origin: 'offline', commandId, kind: 'setObjectProperty', targetId, path: ['alignment'], value }
}

function fakeDb(initialCommands: OfficeCommand[] = []) {
  const snapshot = completePresentationSnapshot()
  const doc = snapshotToYDoc(snapshot)
  for (const item of initialCommands) appendOfficeCommand(doc, item)
  let row: { ydoc: Buffer; seq: number; baseVersion: number; canonicalHash: string } = { ydoc: Buffer.from(encodeOfficeState(doc)), seq: 4 + initialCommands.length, baseVersion: 4, canonicalHash: 'initial' }
  let updates = 0
  const db: OfficeDbQuery = async <T>(_userId: string, sql: string, params: unknown[]) => {
    if (sql.includes('UPDATE office_collab_documents')) {
      updates += 1
      if (row.seq !== params[1]) return { rows: [] as T[] }
      row = { ydoc: params[2] as Buffer, seq: row.seq + Number(params[5]), baseVersion: row.baseVersion, canonicalHash: String(params[4]) }
      return { rows: [{ seq: row.seq }] as T[] }
    }
    return { rows: [row] as T[] }
  }
  return { snapshot, db, updates: () => updates, row: () => row }
}

describe('[COMP:api/office-store] atomic offline command admission', () => {
  it('persists all commands in one write or none when a later command is invalid', async () => {
    const state = fakeDb()
    const first = command(state.snapshot.artifactId, id(901))
    const invalid = command(state.snapshot.artifactId, id(902), id(999))
    await expect(createOfficeLiveStore(state.db).appendOfflineCommands({ userId: id(900), artifactId: state.snapshot.artifactId, expectedSeq: 4, commands: [first, invalid] })).rejects.toThrow()
    expect(state.updates()).toBe(0)
  })

  it('admits one sequence-fenced batch and acknowledges an exact retry', async () => {
    const state = fakeDb()
    const commands: OfficeCommand[] = [command(state.snapshot.artifactId, id(903)), command(state.snapshot.artifactId, id(904), id(34), 'end')]
    const store = createOfficeLiveStore(state.db)
    const first = await store.appendOfflineCommands({ userId: id(900), artifactId: state.snapshot.artifactId, expectedSeq: 4, commands })
    if (!first || first === 'conflict') throw new Error('batch should apply')
    expect(first.seq).toBe(6)
    expect(state.updates()).toBe(1)
    const retried = await store.appendOfflineCommands({ userId: id(900), artifactId: state.snapshot.artifactId, expectedSeq: 4, commands })
    if (!retried || retried === 'conflict') throw new Error('retry should be acknowledged')
    expect(retried.seq).toBe(6)
    expect(state.updates()).toBe(1)
    await expect(store.appendOfflineCommands({ userId: id(900), artifactId: state.snapshot.artifactId, expectedSeq: 4, commands: [command(state.snapshot.artifactId, id(903), id(34), 'start'), commands[1]!] })).resolves.toBe('conflict')
  })

  it('continues only a contiguous legacy prefix and rejects a foreign base', async () => {
    const first = command(completePresentationSnapshot().artifactId, id(905))
    const state = fakeDb([first])
    const second = command(state.snapshot.artifactId, id(906), id(34), 'end')
    const store = createOfficeLiveStore(state.db)
    const applied = await store.appendOfflineCommands({ userId: id(900), artifactId: state.snapshot.artifactId, expectedSeq: 4, commands: [first, second] })
    if (!applied || applied === 'conflict') throw new Error('legacy prefix should continue')
    expect(applied.seq).toBe(6)
    expect(state.updates()).toBe(1)
    const foreign = { ...second, commandId: id(907), baseVersion: 3 }
    await expect(store.appendOfflineCommands({ userId: id(900), artifactId: state.snapshot.artifactId, expectedSeq: 6, commands: [foreign] })).resolves.toBe('conflict')
  })
})
