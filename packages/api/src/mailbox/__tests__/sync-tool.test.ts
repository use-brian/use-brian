/**
 * syncMailboxNow tool — the on-demand freshness lever. Accounts are
 * injection-bound (never model inputs), the primary is the default, and every
 * non-synced outcome maps to honest product copy (in_progress is NOT an
 * error). Global-seam round-trip is covered too.
 *
 * [COMP:tools/mailbox-sync-now]
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createSyncMailboxNowTool,
  setGlobalMailboxSyncDeps,
  getGlobalMailboxSyncDeps,
} from '../sync-tool.js'
import type { MailboxSyncSummary } from '../sync-worker.js'
import type { ToolContext } from '@use-brian/core'

const CTX = {} as unknown as ToolContext

afterEach(() => {
  setGlobalMailboxSyncDeps(null)
})

const ok = (newMessages: number): MailboxSyncSummary => ({ synced: true, newMessages })

describe('[COMP:tools/mailbox-sync-now] syncMailboxNow tool', () => {
  it('syncs the primary by default and a named account otherwise — the model never passes an instance id', async () => {
    const syncInstanceById = vi.fn(async (_id: string) => ok(2))
    const tool = createSyncMailboxNowTool({
      accounts: [
        { instanceId: 'inst-primary', email: 'me@corp.example', isPrimary: true },
        { instanceId: 'inst-other', email: 'other@corp.example', isPrimary: false },
      ],
      deps: { syncInstanceById },
    })
    // Default → primary instance.
    const r1 = await tool.execute({}, CTX)
    expect(syncInstanceById).toHaveBeenNthCalledWith(1, 'inst-primary')
    expect(r1.isError).toBeFalsy()
    expect(r1.data).toContain('2 new messages')
    expect(r1.data).toContain('me@corp.example')

    // account → the named instance.
    await tool.execute({ account: 'other@corp.example' }, CTX)
    expect(syncInstanceById).toHaveBeenNthCalledWith(2, 'inst-other')

    // The input schema exposes no instance knob.
    const shape = Object.keys((tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape)
    expect(shape).toEqual(['account'])
  })

  it('reports "up to date" when the sync pulled nothing new', async () => {
    const tool = createSyncMailboxNowTool({
      accounts: [{ instanceId: 'inst-1', email: 'me@corp.example', isPrimary: true }],
      deps: { syncInstanceById: async () => ok(0) },
    })
    const r = await tool.execute({}, CTX)
    expect(r.isError).toBeFalsy()
    expect(r.data).toContain('up to date')
  })

  it('singular vs plural message count', async () => {
    const tool = createSyncMailboxNowTool({
      accounts: [{ instanceId: 'inst-1', email: 'me@corp.example', isPrimary: true }],
      deps: { syncInstanceById: async () => ok(1) },
    })
    const r = await tool.execute({}, CTX)
    expect(r.data).toContain('1 new message ')
    expect(r.data).not.toContain('1 new messages')
  })

  it('no mailbox connected → honest error, no sync call', async () => {
    const syncInstanceById = vi.fn(async () => ok(0))
    const tool = createSyncMailboxNowTool({ accounts: [], deps: { syncInstanceById } })
    const r = await tool.execute({}, CTX)
    expect(r.isError).toBe(true)
    expect(syncInstanceById).not.toHaveBeenCalled()
  })

  it('unknown account → honest error listing the connected mailboxes, no sync call', async () => {
    const syncInstanceById = vi.fn(async () => ok(0))
    const tool = createSyncMailboxNowTool({
      accounts: [{ instanceId: 'inst-1', email: 'me@corp.example', isPrimary: true }],
      deps: { syncInstanceById },
    })
    const r = await tool.execute({ account: 'ghost@corp.example' }, CTX)
    expect(r.isError).toBe(true)
    expect(r.data).toContain('me@corp.example')
    expect(syncInstanceById).not.toHaveBeenCalled()
  })

  it('disconnected → error; in_progress → NOT an error (the archive is catching up)', async () => {
    const disconnected = createSyncMailboxNowTool({
      accounts: [{ instanceId: 'inst-1', email: 'me@corp.example', isPrimary: true }],
      deps: { syncInstanceById: async () => ({ synced: false, newMessages: 0, reason: 'disconnected' }) },
    })
    const rDisc = await disconnected.execute({}, CTX)
    expect(rDisc.isError).toBe(true)
    expect(rDisc.data).toContain('disconnected')

    const inProgress = createSyncMailboxNowTool({
      accounts: [{ instanceId: 'inst-1', email: 'me@corp.example', isPrimary: true }],
      deps: { syncInstanceById: async () => ({ synced: false, newMessages: 0, reason: 'in_progress' }) },
    })
    const rProg = await inProgress.execute({}, CTX)
    expect(rProg.isError).toBeFalsy()
    expect(rProg.data).toContain('already running')
  })

  it('is read/allow-shaped: not read-only (it mutates the archive), no confirmation', () => {
    const tool = createSyncMailboxNowTool({
      accounts: [{ instanceId: 'inst-1', email: 'me@corp.example', isPrimary: true }],
      deps: { syncInstanceById: async () => ok(0) },
    })
    expect(tool.isReadOnly).toBe(false)
    expect(tool.requiresConfirmation).toBe(false)
  })

  it('global seam round-trips and defaults to null (tool dark until boot arms it)', () => {
    expect(getGlobalMailboxSyncDeps()).toBeNull()
    const deps = { syncInstanceById: async () => ok(0) }
    setGlobalMailboxSyncDeps(deps)
    expect(getGlobalMailboxSyncDeps()).toBe(deps)
  })
})
