import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { channelMediaReceiptStore, runChannelMediaReceipt, type ChannelMediaReceiptStore } from '../channel-media-receipt.js'

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }))
vi.mock('../../db/client.js', () => ({ query: sql }))

function fixture() {
  const states = new Map<string, string>()
  const store: ChannelMediaReceiptStore = {
    async claim(key) { const id = JSON.stringify(key); if (states.has(id)) return false; states.set(id, 'claimed'); return true },
    async finish(key, state) { states.set(JSON.stringify(key), state) },
  }
  return { store, states }
}
const key = { workspaceId: 'workspace', channelType: 'telegram', conversationId: '-100:topic:7', operationKey: 'message:123' }

describe('[COMP:channels/media-receipt] shared upload intake', () => {
  it('saves and acknowledges one upload once across concurrent bots and webhook replay', async () => {
    const { store } = fixture()
    const save = vi.fn(async () => {})
    const send = vi.fn(async () => {})
    const operation = async () => { await save(); await send() }
    await Promise.all(Array.from({ length: 10 }, () => runChannelMediaReceipt(key, operation, store)))
    await runChannelMediaReceipt(key, operation, store)
    expect(save).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    await runChannelMediaReceipt({ ...key, conversationId: '-100:topic:8' }, operation, store)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('does not replay an uncertain receipt send after the file was saved', async () => {
    const { store, states } = fixture()
    const save = vi.fn(async () => {})
    const send = vi.fn(async () => { throw new Error('transport lost response') })
    const operation = async () => { await save(); await send() }
    await expect(runChannelMediaReceipt(key, operation, store)).rejects.toThrow('transport lost response')
    await runChannelMediaReceipt(key, operation, store)
    expect(save).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    expect([...states.values()]).toEqual(['failed'])
  })
})


it('[COMP:channels/media-receipt] atomically claims one upload across PostgreSQL callers and preserves its terminal record', async () => {
  const db = new PGlite()
  try {
    await db.exec('CREATE TABLE workspaces(id UUID PRIMARY KEY)')
    await db.exec(await readFile(new URL('../../../migrations/772_channel_media_receipts.sql', import.meta.url), 'utf8'))
    const workspaceId = '11111111-1111-4111-8111-111111111111'
    await db.query('INSERT INTO workspaces(id) VALUES($1)', [workspaceId])
    sql.mockImplementation((text: string, args: unknown[]) => db.query(text, args))
    const saved = vi.fn(async () => {})
    const receipt = vi.fn(async () => {})
    const input = { ...key, workspaceId }
    await Promise.all(Array.from({ length: 8 }, () => runChannelMediaReceipt(input, async () => {
      await saved(); await receipt()
    }, channelMediaReceiptStore)))
    expect(saved).toHaveBeenCalledOnce()
    expect(receipt).toHaveBeenCalledOnce()
    expect((await db.query<{ state: string }>('SELECT state FROM channel_media_receipts')).rows).toEqual([{ state: 'complete' }])
    await db.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    expect((await db.query('SELECT * FROM channel_media_receipts')).rows).toEqual([])
  } finally { await db.close() }
})
