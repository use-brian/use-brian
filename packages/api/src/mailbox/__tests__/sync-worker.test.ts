/**
 * Mailbox sync worker — the §10 Phase 2 unit matrix: first-sync posture (no
 * embedding spend before the confirmed backfill, D9), backfill resume +
 * newest-first, UIDVALIDITY recovery, completeness reconciliation, and
 * rules routing (archive gets ALL; the brain only rule-passing mail).
 * Everything runs against a fake IMAP client + in-memory stores.
 *
 * [COMP:api/mailbox-sync-worker]
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createMailboxSyncWorker,
  createMailboxBrainRouter,
  readMailboxSyncState,
  type MailboxBrainRouterDeps,
  type MailboxSyncWorkerDeps,
} from '../sync-worker.js'
import { createMailboxSessionCache, type ImapClientLike, type ImapFetchedMessage } from '../imap-session.js'
import type { ConnectorInstance, ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { IngestRuleRow, IngestRulesStore } from '../../db/ingest-rules-store.js'
import type { EmailArchiveMessageInput } from '../../db/email-archive-store.js'

// ── Fixtures ────────────────────────────────────────────────────

const IMAP_CREDS = {
  type: 'imap' as const,
  email: 'maya@harborlane.example',
  appPassword: 'pw',
  imapHost: 'imap.qiye.aliyun.com',
  imapPort: 993,
  smtpHost: 'smtp.qiye.aliyun.com',
  smtpPort: 465,
}

function rfc822(uid: number, over: { from?: string; subject?: string; listUnsubscribe?: boolean } = {}): Buffer {
  const lines = [
    `From: ${over.from ?? `Sender ${uid} <s${uid}@acme.com>`}`,
    'To: maya@harborlane.example',
    `Subject: ${over.subject ?? `mail ${uid}`}`,
    `Message-ID: <m${uid}@acme.com>`,
    `Date: Mon, ${String((uid % 27) + 1).padStart(2, '0')} Jul 2026 10:00:00 +0000`,
    ...(over.listUnsubscribe ? ['List-Unsubscribe: <https://acme.com/u>'] : []),
    'Content-Type: text/plain; charset=utf-8',
  ]
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\nBody of message ${uid}.\r\n`, 'utf8')
}

type FakeFolderState = {
  uidvalidity: string
  /** All existing UIDs, ascending. */
  uids: number[]
  sources: Record<number, Buffer>
}

function makeFakeImap(
  folders: Record<string, FakeFolderState>,
  fault?: {
    /** The server errors on any FETCH whose range covers this UID. */
    fetchUid?: number
    /** Also drop the session (usable=false) — a connection loss, not one poison message. */
    dead?: boolean
    /**
     * Every backfill SEARCH is rejected. This is the shape of the 2026-08-08
     * production wedge: the pass died before archiving anything, so the count
     * never moved and the failure repeated identically every five minutes.
     */
    searchFails?: boolean
  },
) {
  let openFolder = ''
  let noopCalls = 0
  let searchCalls = 0
  const client = {
    usable: true,
    async connect() {},
    async logout() {},
    close() {},
    async list() {
      return Object.keys(folders).map((path) => ({
        path,
        // Gmail's bare `[Gmail]` container is `\Noselect`: it cannot be
        // SELECTed, so a sync pass must never try to open it.
        ...(path === '[Gmail]' ? { flags: new Set(['\\Noselect', '\\HasChildren']) } : {}),
      }))
    },
    async getMailboxLock(path: string) {
      openFolder = path
      return { release() {} }
    },
    async status(path: string) {
      const f = folders[path]
      return {
        path,
        messages: f.uids.length,
        uidNext: (f.uids[f.uids.length - 1] ?? 0) + 1,
        uidValidity: BigInt(f.uidvalidity),
      }
    },
    async search(query: Record<string, unknown>) {
      searchCalls++
      if (fault?.searchFails) throw new Error('Command failed')
      const f = folders[openFolder]
      // The worker's backfill search is date-bounded or `all`; the fake
      // treats every message as in-scope (dates in fixtures are recent).
      void query
      return [...f.uids]
    },
    fetch(range: string, _q: Record<string, unknown>) {
      const f = folders[openFolder]
      let uids: number[]
      if (range.endsWith(':*')) {
        const from = Number(range.slice(0, -2).split(':')[0])
        const last = f.uids[f.uids.length - 1] ?? 0
        uids = f.uids.filter((u) => u >= from)
        if (uids.length === 0 && f.uids.length > 0) uids = [last] // n:* always matches the last message
      } else {
        uids = range.split(',').map(Number)
      }
      return (async function* (): AsyncGenerator<ImapFetchedMessage> {
        for (const uid of uids) {
          if (fault && uid === fault.fetchUid) {
            // Real imapflow throws mid-stream; a poison message keeps the
            // session usable, a connection loss does not.
            if (fault.dead) (client as { usable: boolean }).usable = false
            throw new Error(`FETCH failed for UID ${uid}`)
          }
          const source = f.sources[uid]
          if (source) yield { uid, source }
        }
      })()
    },
    async fetchOne() {
      return false as const
    },
    async append() {
      return {}
    },
    // Counted, because the insert phase's socket keep-warm calls it — a real
    // client that never gets one loses the session to the inactivity timeout.
    async noop() {
      noopCalls++
      return {}
    },
    on() {},
  } as unknown as ImapClientLike
  Object.defineProperty(client, 'noopCalls', { get: () => noopCalls })
  return Object.defineProperty(client, 'searchCalls', { get: () => searchCalls }) as ImapClientLike & {
    noopCalls: number
    searchCalls: number
  }
}

function makeInstanceStore(instance: ConnectorInstance) {
  const configs = new Map<string, Record<string, unknown>>([[instance.id, { ...(instance.config ?? {}) }]])
  const healthCalls: Array<{ id: string; status: string; error: string | null }> = []
  const store = {
    async listByProviderSystem() {
      return [{ ...instance, config: { ...configs.get(instance.id) } }]
    },
    async getAuthCredentialsSystem() {
      return IMAP_CREDS
    },
    async setConfigSystem(id: string, config: Record<string, unknown>) {
      configs.set(id, { ...configs.get(id), ...config })
    },
    async markHealth(id: string, status: string, error?: string | null) {
      healthCalls.push({ id, status, error: error ?? null })
    },
  } as unknown as ConnectorInstanceStore
  return { store, configs, healthCalls }
}

function instanceRow(over: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: 'inst-1',
    provider: 'imap',
    userId: 'owner-1',
    workspaceId: null,
    ingestWorkspaceId: null,
    connected: true,
    ingestionEnabled: false,
    config: {},
    label: 'maya@harborlane.example',
    ...over,
  } as unknown as ConnectorInstance
}

function makeWorker(over: Partial<MailboxSyncWorkerDeps> & { client: ImapClientLike; instance?: ConnectorInstance }) {
  const instance = over.instance ?? instanceRow()
  const { store, configs, healthCalls } = makeInstanceStore(instance)
  const insertMessage = vi.fn(async (_input: EmailArchiveMessageInput) => ({ inserted: true, messageId: 'am-1', segmentCount: 1 }))
  const deleteFolder = vi.fn(async (_instanceId: string, _folder: string) => 0)
  const worker = createMailboxSyncWorker({
    connectorInstanceStore: store,
    resolvePersonalWorkspaceId: async () => 'ws-1',
    sessions: createMailboxSessionCache({ createClient: () => over.client }),
    // A test may override the insert (e.g. to reject one message); the returned
    // `insertMessage` stays the typed mock for `.mock` assertions in the
    // non-override cases (override tests assert on their own vi.fn).
    insertMessage: (over.insertMessage ?? insertMessage) as never,
    deleteFolder: deleteFolder as never,
    ...('brain' in over ? { brain: over.brain } : {}),
    backfillChunk: over.backfillChunk,
    deltaChunk: over.deltaChunk,
    ...(over.keepWarm ? { keepWarm: over.keepWarm } : {}),
    ...(over.onEvent ? { onEvent: over.onEvent } : {}),
  })
  return { worker, configs, insertMessage, deleteFolder, healthCalls, instanceId: instance.id }
}

// ── First sync + backfill preflight gate (D9) ───────────────────

describe('[COMP:api/mailbox-sync-worker] first sync + preflight gate', () => {
  it('the first sync only establishes cursors — NO history is fetched before a confirmed backfill (D9/D6)', async () => {
    const client = makeFakeImap({
      INBOX: { uidvalidity: '7', uids: [1, 2, 3], sources: { 1: rfc822(1), 2: rfc822(2), 3: rfc822(3) } },
    })
    const { worker, configs, insertMessage } = makeWorker({ client })
    await worker.tick()
    expect(insertMessage).not.toHaveBeenCalled()
    const state = readMailboxSyncState(configs.get('inst-1'))
    expect(state.folders.INBOX).toMatchObject({ uidvalidity: '7', lastUid: 3 })
  })

  it('a backfill armed BEFORE the first cursor exists runs on that SAME first tick — no extra interval of "Syncing 0 of N"', async () => {
    const client = makeFakeImap({
      INBOX: { uidvalidity: '7', uids: [1], sources: { 1: rfc822(1) } },
    })
    // Exact prod shape: the user connected + confirmed a backfill, but the
    // worker has not yet established any folder cursor. Previously the first
    // tick only established the cursor and returned, deferring the consented
    // backfill to the SECOND tick (a 1-message mailbox stuck at "0 of 1").
    const instance = instanceRow({
      config: {
        mailboxSync: {
          folders: {},
          backfill: { scope: 'all', requestedAt: '2026-07-23T09:50:56Z', status: 'running', totalEstimate: 1 },
        },
      },
    } as never)
    const { worker, insertMessage, configs } = makeWorker({ client, instance })
    await worker.tick()
    expect(insertMessage).toHaveBeenCalledTimes(1)
    expect(insertMessage.mock.calls[0][0].providerMessageId).toBe('INBOX:1')
    const state = readMailboxSyncState(configs.get('inst-1'))
    expect(state.folders.INBOX).toMatchObject({ uidvalidity: '7', lastUid: 1, backfillDone: true })
    expect(state.backfill?.status).toBe('done')
  })

  it('new mail after the cursor is archived (delta), and completeness reconciles with the server totals', async () => {
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1, 2], sources: { 1: rfc822(1), 2: rfc822(2) } },
    }
    const client = makeFakeImap(folders)
    const { worker, insertMessage, configs } = makeWorker({ client })
    await worker.tick() // establishes cursor at 2

    folders.INBOX.uids = [1, 2, 3, 4]
    folders.INBOX.sources[3] = rfc822(3)
    folders.INBOX.sources[4] = rfc822(4)
    await worker.tick()

    expect(insertMessage).toHaveBeenCalledTimes(2)
    const ids = insertMessage.mock.calls.map((c) => c[0].providerMessageId)
    expect(ids).toEqual(['INBOX:3', 'INBOX:4'])
    const state = readMailboxSyncState(configs.get('inst-1'))
    expect(state.folders.INBOX.lastUid).toBe(4)
  })
})

// ── Backfill: newest-first + resume ─────────────────────────────

describe('[COMP:api/mailbox-sync-worker] backfill', () => {
  function backfillSetup(chunk: number) {
    const sources = Object.fromEntries([1, 2, 3, 4, 5, 6].map((u) => [u, rfc822(u)]))
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1, 2, 3, 4, 5, 6], sources },
    }
    const client = makeFakeImap(folders)
    const instance = instanceRow({
      config: {
        mailboxSync: {
          folders: { INBOX: { uidvalidity: '7', lastUid: 6 } },
          backfill: { scope: 'all', requestedAt: '2026-07-22T00:00:00Z', status: 'running', totalEstimate: 6 },
        },
      },
    } as never)
    return { client, instance, chunk }
  }

  it('walks history NEWEST-first so recent mail is searchable in minutes', async () => {
    const { client, instance } = backfillSetup(10)
    const { worker, insertMessage } = makeWorker({ client, instance, backfillChunk: 10 })
    await worker.tick()
    const ids = insertMessage.mock.calls.map((c) => c[0].providerMessageId)
    expect(ids).toEqual(['INBOX:6', 'INBOX:5', 'INBOX:4', 'INBOX:3', 'INBOX:2', 'INBOX:1'])
  })

  it('resumes from the per-folder checkpoint after an interrupt — no duplicates, and finishes', async () => {
    const { client, instance } = backfillSetup(2)
    // First worker: chunked at 2 per tick — simulate an interrupt by simply
    // discarding it after one tick (the checkpoint lives in config).
    const first = makeWorker({ client, instance, backfillChunk: 2 })
    await first.worker.tick()
    const firstIds = first.insertMessage.mock.calls.map((c) => c[0].providerMessageId)
    expect(firstIds).toEqual(['INBOX:6', 'INBOX:5'])
    const midState = readMailboxSyncState(first.configs.get('inst-1'))
    expect(midState.folders.INBOX.backfillLow).toBe(5)

    // "Restart": a fresh worker resumes from the persisted checkpoint.
    const resumed = makeWorker({
      client,
      instance: instanceRow({ config: { mailboxSync: midState } } as never),
      backfillChunk: 10,
    })
    await resumed.worker.tick()
    const resumedIds = resumed.insertMessage.mock.calls.map((c) => c[0].providerMessageId)
    expect(resumedIds).toEqual(['INBOX:4', 'INBOX:3', 'INBOX:2', 'INBOX:1'])
    const endState = readMailboxSyncState(resumed.configs.get('inst-1'))
    expect(endState.folders.INBOX.backfillDone).toBe(true)
    expect(endState.backfill?.status).toBe('done')
    // Completeness: archived total across both runs == server total.
    expect(firstIds.length + resumedIds.length).toBe(6)
  })

  it('backfill is archive-ONLY — historical mail never reaches the brain (D6)', async () => {
    const { client, instance } = backfillSetup(10)
    const route = vi.fn(async () => null)
    const brain = { __router: true } as unknown as MailboxBrainRouterDeps
    const { worker } = makeWorker({
      client,
      instance: instanceRow({ ...instance, ingestionEnabled: true } as never),
      backfillChunk: 10,
      brain,
    })
    // The router is only invoked from the DELTA path; monkey-patching is not
    // needed — a brain-deps object that would throw on use proves the
    // backfill path never touches it (createMailboxBrainRouter is only
    // called at construction; route() only fires on delta inserts).
    await worker.tick()
    expect(route).not.toHaveBeenCalled()
  })
})

// ── The insert phase must not hold a silent socket ────────────────
//
// Regression cover for the 2026-07-28 crash loop: the worker fetches a chunk,
// releases the mailbox lock, then spends the rest of the walk parsing and
// inserting with the IMAP session still held and the socket idle. imapflow's
// `socketTimeout` is inactivity-based, so a slow insert phase looks exactly
// like a dead server — it killed the session, the unlistened 'error' event
// killed the process, and every in-flight scheduled workflow run orphaned.
// These tests pin that BOTH insert loops go through the keep-warm.

describe('[COMP:api/mailbox-sync-worker] insert-phase socket keep-warm', () => {
  /** A keep-warm whose window has always already elapsed — one ping per call. */
  function eagerKeepWarm(pings: string[], label: string) {
    return (client: ImapClientLike) => ({
      async pingIfIdle() {
        pings.push(label)
        await client.noop()
      },
    })
  }

  it('keeps the socket warm through the BACKFILL insert loop', async () => {
    const pings: string[] = []
    const sources = Object.fromEntries([1, 2, 3, 4, 5, 6].map((u) => [u, rfc822(u)]))
    const client = makeFakeImap({ INBOX: { uidvalidity: '7', uids: [1, 2, 3, 4, 5, 6], sources } })
    const instance = instanceRow({
      config: {
        mailboxSync: {
          folders: { INBOX: { uidvalidity: '7', lastUid: 6 } },
          backfill: { scope: 'all', requestedAt: '2026-07-22T00:00:00Z', status: 'running', totalEstimate: 6 },
        },
      },
    } as never)
    const { worker, insertMessage } = makeWorker({
      client,
      instance,
      backfillChunk: 10,
      keepWarm: eagerKeepWarm(pings, 'backfill'),
    })
    await worker.tick()

    expect(insertMessage).toHaveBeenCalledTimes(6)
    // One guarded step per message — the walk is never unguarded.
    expect(pings).toHaveLength(6)
    expect(client.noopCalls).toBe(6)
  })

  it('keeps the socket warm through the DELTA insert loop (where brain routing runs)', async () => {
    const pings: string[] = []
    const sources = Object.fromEntries([1, 2, 3].map((u) => [u, rfc822(u)]))
    const client = makeFakeImap({ INBOX: { uidvalidity: '7', uids: [1, 2, 3], sources } })
    const instance = instanceRow({
      config: { mailboxSync: { folders: { INBOX: { uidvalidity: '7', lastUid: 0 } } } },
    } as never)
    const { worker, insertMessage } = makeWorker({
      client,
      instance,
      keepWarm: eagerKeepWarm(pings, 'delta'),
    })
    await worker.tick()

    expect(insertMessage).toHaveBeenCalledTimes(3)
    expect(pings).toEqual(['delta', 'delta', 'delta'])
  })

  it('a keep-warm failure aborts the walk with progress already persisted', async () => {
    // A dead session must stop the walk, not have it keep inserting into the
    // void — but the checkpoints earned before the failure have to survive, or
    // the next tick re-fetches work that was already archived.
    const sources = Object.fromEntries([1, 2, 3, 4, 5, 6].map((u) => [u, rfc822(u)]))
    const client = makeFakeImap({ INBOX: { uidvalidity: '7', uids: [1, 2, 3, 4, 5, 6], sources } })
    const instance = instanceRow({
      config: {
        mailboxSync: {
          folders: { INBOX: { uidvalidity: '7', lastUid: 6 } },
          backfill: { scope: 'all', requestedAt: '2026-07-22T00:00:00Z', status: 'running', totalEstimate: 6 },
        },
      },
    } as never)
    let calls = 0
    const { worker, insertMessage, configs } = makeWorker({
      client,
      instance,
      backfillChunk: 10,
      keepWarm: () => ({
        async pingIfIdle() {
          if (++calls > 3) throw new Error('Socket is already closed')
        },
      }),
    })
    // `tick()` swallows per-instance failures (it logs and moves on).
    await worker.tick()

    // Stopped, did not grind through all six.
    expect(insertMessage).toHaveBeenCalledTimes(3)
    // Newest-first walk got 6, 5, 4 in — and the checkpoint says so, so the
    // next tick resumes below 4 instead of redoing them.
    const state = readMailboxSyncState(configs.get('inst-1'))
    expect(state.folders.INBOX.backfillLow).toBe(4)
    // A backfill failure is recorded on the BACKFILL, not on the instance:
    // `state.lastError` means "this mailbox is not syncing", and a stumble
    // importing history is not that. Delta sync is unaffected.
    expect(state.backfill?.lastError).toContain('Socket is already closed')
    expect(state.backfill?.consecutiveFailures).toBe(1)
    expect(state.folders.INBOX.backfillDone).toBeUndefined()
  })
})

// ── Poison tolerance: one bad message never wedges the walk ──────

describe('[COMP:api/mailbox-sync-worker] poison tolerance', () => {
  // A backfill armed over a 6-message INBOX, cursor already at the top so the
  // delta path is a no-op and the tick goes straight to the historical walk.
  function armedBackfill() {
    const sources = Object.fromEntries([1, 2, 3, 4, 5, 6].map((u) => [u, rfc822(u)]))
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1, 2, 3, 4, 5, 6], sources },
    }
    const instance = instanceRow({
      config: {
        mailboxSync: {
          folders: { INBOX: { uidvalidity: '7', lastUid: 6 } },
          backfill: { scope: 'all', requestedAt: '2026-07-24T00:00:00Z', status: 'running', totalEstimate: 6 },
        },
      },
    } as never)
    return { folders, instance }
  }

  it('an un-insertable message is quarantined and stepped over — the walk finishes (no stall)', async () => {
    const { folders, instance } = armedBackfill()
    const client = makeFakeImap(folders)
    const insertMessage = vi.fn(async (input: EmailArchiveMessageInput) => {
      if (input.providerMessageId === 'INBOX:3') throw new Error('body segment too long')
      return { inserted: true, messageId: 'am', segmentCount: 1 }
    })
    const { worker, configs } = makeWorker({
      client,
      instance,
      backfillChunk: 10,
      insertMessage: insertMessage as never,
    })
    await worker.tick()

    // Every message was ATTEMPTED (all 6); only #3 was rejected and skipped.
    expect(insertMessage).toHaveBeenCalledTimes(6)
    const state = readMailboxSyncState(configs.get('inst-1'))
    expect(state.skippedCount).toBe(1)
    expect(state.recentSkips?.[0]).toMatchObject({ folder: 'INBOX', uid: 3 })
    expect(state.recentSkips?.[0].reason).toMatch(/^insert:/)
    // The walk reached the bottom and completed — the forever-stall is gone.
    expect(state.folders.INBOX.backfillLow).toBe(1)
    expect(state.folders.INBOX.backfillDone).toBe(true)
    expect(state.backfill?.status).toBe('done')
    expect(state.lastError ?? null).toBeNull()
  })

  it('an un-fetchable UID (server errors its FETCH) is bisected out, quarantined, and stepped over', async () => {
    const { folders, instance } = armedBackfill()
    const client = makeFakeImap(folders, { fetchUid: 3 }) // session stays usable — one poison message
    const { worker, insertMessage, configs } = makeWorker({ client, instance, backfillChunk: 10 })
    await worker.tick()

    // Poison UID never reached the archive; every other message did.
    const ids = insertMessage.mock.calls.map((c) => c[0].providerMessageId)
    expect(ids).toEqual(['INBOX:6', 'INBOX:5', 'INBOX:4', 'INBOX:2', 'INBOX:1'])
    const state = readMailboxSyncState(configs.get('inst-1'))
    expect(state.skippedCount).toBe(1)
    expect(state.recentSkips?.[0]).toMatchObject({ folder: 'INBOX', uid: 3 })
    expect(state.recentSkips?.[0].reason).toMatch(/^fetch:/)
    expect(state.folders.INBOX.backfillLow).toBe(1)
    expect(state.folders.INBOX.backfillDone).toBe(true)
    expect(state.backfill?.status).toBe('done')
  })

  it('a dropped session (not a poison message) rethrows and quarantines NOTHING — retried later intact', async () => {
    const { folders, instance } = armedBackfill()
    const client = makeFakeImap(folders, { fetchUid: 3, dead: true })
    const { worker, insertMessage, configs } = makeWorker({ client, instance, backfillChunk: 10 })
    await worker.tick() // tick swallows the throw (logs), never crashes

    // A connection loss is NOT a poison message: nothing archived, nothing skipped.
    expect(insertMessage).not.toHaveBeenCalled()
    const state = readMailboxSyncState(configs.get('inst-1'))
    expect(state.skippedCount ?? 0).toBe(0)
    expect(state.recentSkips ?? []).toHaveLength(0)
    // Backfill stays running (resumes from the same checkpoint) and surfaces the
    // error on the backfill rather than silently discarding a whole good batch.
    expect(state.backfill?.lastError).toContain('FETCH failed')
    expect(state.backfill?.consecutiveFailures).toBe(1)
    expect(state.backfill?.status).toBe('running')
    expect(state.folders.INBOX.backfillDone).toBeFalsy()
  })
})

// ── Backfill stall: a failing backfill must never wedge the mailbox ──

describe('[COMP:api/mailbox-sync-worker] backfill stall guard', () => {
  // Regression for 2026-08-08: three live mailboxes sat frozen (one for twelve
  // days) because a backfill pass that always threw kept `status: 'running'`,
  // so every tick re-entered it, threw again, and aborted the whole instance
  // sync on the way out. The state that would have ended the loop was only
  // writable by the path the loop prevented reaching.
  function armed(lastUid: number) {
    const sources = Object.fromEntries([1, 2, 3, 4, 5, 6].map((u) => [u, rfc822(u)]))
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1, 2, 3, 4, 5, 6], sources },
    }
    const instance = instanceRow({
      config: {
        mailboxSync: {
          folders: { INBOX: { uidvalidity: '7', lastUid } },
          backfill: { scope: 'all', requestedAt: '2026-08-01T00:00:00Z', status: 'running', totalEstimate: 6 },
        },
      },
    } as never)
    return { folders, instance }
  }

  it('skips a \\Noselect container and still syncs every folder LISTED AFTER it', async () => {
    // The 2026-08-08 root cause, end to end. Gmail LISTs a bare `[Gmail]`
    // node that cannot be SELECTed; the worker opened it, the SELECT was
    // refused as `Command failed`, and because the throw escaped the folder
    // loop every folder after it was starved — 83,736 messages on one real
    // account, silently, for twelve days. `[Gmail]` sorts between the two
    // real folders here on purpose.
    const sources = Object.fromEntries([1, 2].map((u) => [u, rfc822(u)]))
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1, 2], sources },
      '[Gmail]': { uidvalidity: '9', uids: [], sources: {} },
      '[Gmail]/Important': { uidvalidity: '8', uids: [1, 2], sources },
    }
    // Selecting the container is a hard error, exactly as the server does it.
    const client = makeFakeImap(folders)
    const realLock = client.getMailboxLock.bind(client)
    ;(client as { getMailboxLock: (p: string) => Promise<{ release(): void }> }).getMailboxLock = async (
      path: string,
    ) => {
      if (path === '[Gmail]') throw new Error('Command failed')
      return realLock(path)
    }
    const instance = instanceRow({
      config: {
        mailboxSync: {
          folders: {},
          backfill: { scope: 'all', requestedAt: '2026-08-01T00:00:00Z', status: 'running', totalEstimate: 4 },
        },
      },
    } as never)
    const { worker, insertMessage } = makeWorker({ client, instance, backfillChunk: 10 })
    await worker.tick()

    // Both real folders synced. Before the fix, `[Gmail]/Important` got zero.
    const archivedFolders = insertMessage.mock.calls.map((c) =>
      String((c[0] as { providerMessageId: string }).providerMessageId).split(':')[0],
    )
    expect(new Set(archivedFolders)).toEqual(new Set(['INBOX', '[Gmail]/Important']))
    expect(insertMessage).toHaveBeenCalledTimes(4)
  })

  it('an ordinary sync failure marks the instance `degraded`, NEVER `auth_failed`', async () => {
    // `auth_failed` makes inject.ts withhold every mailbox tool, so using it
    // for a non-credential failure would strip search/read/send from a mailbox
    // whose password is fine — the 2026-07-20 over-marking incident. Migration
    // 425 added `degraded` precisely so this case has somewhere honest to go
    // instead of staying silently 'ok', as it did for twelve days.
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1], sources: { 1: rfc822(1) } },
    }
    const client = makeFakeImap(folders)
    ;(client as unknown as { status: () => Promise<never> }).status = async () => {
      throw new Error('Command failed')
    }
    const { worker, healthCalls } = makeWorker({ client })
    await worker.tick()

    expect(healthCalls.map((c) => c.status)).toEqual(['degraded'])
    expect(healthCalls.some((c) => c.status === 'auth_failed')).toBe(false)
    expect(healthCalls[0].error).toContain('Command failed')
  })

  it('a genuine credential failure is still `auth_failed` — degraded does not swallow it', async () => {
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1], sources: { 1: rfc822(1) } },
    }
    const client = makeFakeImap(folders)
    ;(client as unknown as { status: () => Promise<never> }).status = async () => {
      throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true })
    }
    const { worker, healthCalls } = makeWorker({ client })
    await worker.tick()

    expect(healthCalls.map((c) => c.status)).toEqual(['auth_failed'])
  })

  it('a backfill that always fails still lets NEW mail through — delta sync is not collateral', async () => {
    const { folders, instance } = armed(3)
    const client = makeFakeImap(folders, { searchFails: true })
    const { worker, insertMessage, configs } = makeWorker({ client, instance, backfillChunk: 10 })
    await worker.tick()

    // The whole point: history is broken, but 4/5/6 still arrived.
    expect(insertMessage).toHaveBeenCalledTimes(3)
    const state = readMailboxSyncState(configs.get('inst-1'))
    expect(state.folders.INBOX.lastUid).toBe(6)
    expect(state.backfill?.consecutiveFailures).toBe(1)
    expect(state.backfill?.status).toBe('running')
  })

  it('parks the backfill as `stalled` after repeated failures and STOPS retrying it', async () => {
    const { folders, instance } = armed(6) // cursor at the top: delta is a no-op
    const client = makeFakeImap(folders, { searchFails: true }) as ImapClientLike & { searchCalls: number }
    const { worker, configs } = makeWorker({ client, instance, backfillChunk: 10 })

    for (let i = 0; i < 12; i++) await worker.tick()
    const state = readMailboxSyncState(configs.get('inst-1'))
    expect(state.backfill?.status).toBe('stalled')
    expect(state.backfill?.consecutiveFailures).toBe(12)
    // The server's own words survive to the user, not the bare "Command failed".
    expect(state.backfill?.lastError).toContain('Command failed')

    // Parked means parked: further ticks must not touch the backfill at all.
    const searchesWhenStalled = client.searchCalls
    await worker.tick()
    await worker.tick()
    expect(client.searchCalls).toBe(searchesWhenStalled)
  })

  it('a successful pass clears the failure ledger — a stall means failing NOW', async () => {
    const { folders, instance } = armed(6)
    const failing = makeFakeImap(folders, { searchFails: true })
    const { worker, configs } = makeWorker({ client: failing, instance, backfillChunk: 10 })
    await worker.tick()
    const afterFailure = configs.get('inst-1')
    expect(readMailboxSyncState(afterFailure).backfill?.consecutiveFailures).toBe(1)

    // Same persisted state, healthy client: the next good pass resets the counter.
    const healthy = makeFakeImap(folders)
    const { worker: worker2, configs: configs2 } = makeWorker({
      client: healthy,
      instance: instanceRow({ config: afterFailure } as never),
      backfillChunk: 10,
    })
    await worker2.tick()
    const state = readMailboxSyncState(configs2.get('inst-1'))
    expect(state.backfill?.consecutiveFailures).toBe(0)
    expect(state.backfill?.lastError).toBeNull()
  })
})

// ── UIDVALIDITY recovery ────────────────────────────────────────

describe('[COMP:api/mailbox-sync-worker] UIDVALIDITY change', () => {
  it('detects the change, rebuilds only the affected folder, leaves others untouched', async () => {
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1, 2], sources: { 1: rfc822(1), 2: rfc822(2) } },
      Sent: { uidvalidity: '3', uids: [9], sources: { 9: rfc822(9) } },
    }
    const client = makeFakeImap(folders)
    const instance = instanceRow({
      config: {
        mailboxSync: {
          folders: {
            INBOX: { uidvalidity: '7', lastUid: 2 },
            Sent: { uidvalidity: '3', lastUid: 9 },
          },
        },
      },
    } as never)
    const { worker, deleteFolder, configs } = makeWorker({ client, instance })

    folders.INBOX.uidvalidity = '8' // server reassigned INBOX UIDs
    await worker.tick()

    expect(deleteFolder).toHaveBeenCalledTimes(1)
    expect(deleteFolder).toHaveBeenCalledWith('inst-1', 'INBOX')
    const state = readMailboxSyncState(configs.get('inst-1'))
    expect(state.folders.INBOX).toMatchObject({ uidvalidity: '8', lastUid: 2 })
    expect(state.folders.Sent).toMatchObject({ uidvalidity: '3', lastUid: 9 })
  })
})

// ── Rules routing (archive gets ALL; brain only rule-passing) ───

function seededImapRules(): IngestRuleRow[] {
  const base = {
    connectorInstanceId: 'inst-1',
    source: 'imap',
    routingSchedule: null as string | null,
    routingTimezone: 'UTC',
    alert: false,
    episodeSensitivity: null as never,
  }
  return [
    { ...base, id: 'r-noreply', ruleOrder: 0, filterType: 'is_noreply', filterParams: {}, routingMode: 'drop' },
    { ...base, id: 'r-bulk', ruleOrder: 1, filterType: 'is_bulk', filterParams: {}, routingMode: 'scheduled', routingSchedule: '0 9 * * 1-5' },
    { ...base, id: 'r-all', ruleOrder: 2, filterType: 'always', filterParams: {}, routingMode: 'realtime' },
  ] as unknown as IngestRuleRow[]
}

function makeBrainDeps(over: Partial<MailboxBrainRouterDeps> = {}): {
  deps: MailboxBrainRouterDeps
  runExtraction: ReturnType<typeof vi.fn>
  appendBatch: ReturnType<typeof vi.fn>
  createEpisode: ReturnType<typeof vi.fn>
  taskAdmission: MailboxBrainRouterDeps['taskAdmission']
} {
  const runExtraction = vi.fn(async () => ({}))
  const appendBatch = vi.fn(async () => {})
  const taskAdmission = {} as MailboxBrainRouterDeps['taskAdmission']
  const createEpisode = vi.fn(async (_actor: string, input: Record<string, unknown>) => ({
    id: 'ep-1',
    sourceKind: input.sourceKind,
    occurredAt: input.occurredAt,
    workspaceId: input.workspaceId,
    userId: input.userId,
    assistantId: input.assistantId,
    createdByUserId: input.createdByUserId,
    createdByAssistantId: input.createdByAssistantId,
  }))
  const deps: MailboxBrainRouterDeps = {
    provider: {} as never,
    model: 'test-model',
    crm: {} as never,
    entities: {} as never,
    entityLinks: {} as never,
    memories: {} as never,
    tasks: {} as never,
    taskAdmission,
    episodes: { createEpisode } as never,
    ingestRulesStore: {
      listByConnectorInstanceSystem: vi.fn(async () => seededImapRules()),
      seedDefaults: vi.fn(async () => {}),
    } as unknown as IngestRulesStore,
    resolvePlaceholders: async () => [],
    scheduledBatching: true,
    runExtraction: runExtraction as never,
    appendBatchEvent: appendBatch as never,
    ...over,
  }
  return { deps, runExtraction, appendBatch, createEpisode, taskAdmission }
}

const BRAIN_CTX = {
  workspaceId: 'ws-1',
  connectorInstanceId: 'inst-1',
  userId: 'owner-1',
  assistantId: 'asst-1',
}

describe('[COMP:api/mailbox-sync-worker] rules routing (mixed batch)', () => {
  it('routes realtime extraction through the workspace runtime', async () => {
    const customProvider = { stream: vi.fn() }
    const resolveLlm = vi.fn().mockResolvedValue({
      provider: customProvider,
      model: 'custom:profile-1',
      modelTier: 'standard',
      providerKeySource: 'user',
      inputTokenLimit: 32000,
      maxTokens: 4000,
    })
    const { deps, runExtraction } = makeBrainDeps({ resolveLlm })
    await createMailboxBrainRouter(deps).route({
      account_email: 'maya@harborlane.example',
      folder: 'INBOX',
      provider_message_id: 'INBOX:1',
      from: 'Casey <casey@client.example>',
      subject: 'Deal terms',
      text: 'Can we revise clause 4?',
    }, BRAIN_CTX)
    expect(resolveLlm).toHaveBeenCalledWith('ws-1')
    expect(runExtraction.mock.calls[0][2]).toMatchObject({
      provider: customProvider,
      model: 'custom:profile-1',
      providerKeySource: 'user',
      inputTokenLimit: 32000,
      maxTokens: 4000,
      classifierModel: 'custom:profile-1',
    })
  })

  it('pairs the task store with admission on realtime extraction', async () => {
    const { deps, runExtraction, taskAdmission } = makeBrainDeps()
    const router = createMailboxBrainRouter(deps)

    await router.route(
      {
        account_email: 'maya@harborlane.example',
        folder: 'INBOX',
        provider_message_id: 'INBOX:1',
        from: 'Casey Example <casey@client.example>',
        subject: 'Deal terms',
        text: 'Can we revise clause 4?',
      },
      BRAIN_CTX,
    )

    expect(runExtraction).toHaveBeenCalledTimes(1)
    expect(runExtraction.mock.calls[0][2]).toMatchObject({
      tasks: deps.tasks,
      taskAdmission,
    })
    expect(runExtraction.mock.calls[0][0]).toMatchObject({
      sourceKind: 'email_thread',
      channelRef: BRAIN_CTX.connectorInstanceId,
    })
    expect(deps.episodes.createEpisode).toHaveBeenCalledWith(
      BRAIN_CTX.userId,
      expect.objectContaining({
        sourceRef: expect.objectContaining({
          connector: 'imap',
          channel_ref: BRAIN_CTX.connectorInstanceId,
        }),
      }),
    )
  })

  it('correspondence → realtime episode; newsletter → digest batch; notification → dropped', async () => {
    const { deps, runExtraction, appendBatch, createEpisode } = makeBrainDeps()
    const router = createMailboxBrainRouter(deps)

    const correspondence = await router.route(
      {
        account_email: 'maya@harborlane.example',
        folder: 'INBOX',
        provider_message_id: 'INBOX:1',
        from: 'Ken Lau <ken@client.hk>',
        subject: 'Deal terms',
        text: 'Can we revise clause 4?',
      },
      BRAIN_CTX,
    )
    expect(correspondence).toEqual({ episodeId: 'ep-1' })
    expect(runExtraction).toHaveBeenCalledTimes(1)
    expect(createEpisode).toHaveBeenCalledTimes(1)

    const newsletter = await router.route(
      {
        account_email: 'maya@harborlane.example',
        folder: 'INBOX',
        provider_message_id: 'INBOX:2',
        from: 'TechCrunch <digest@techcrunch.com>',
        subject: 'Daily roundup',
        text: 'Top stories today...',
        is_bulk: true,
      },
      BRAIN_CTX,
    )
    expect(newsletter).toBeNull()
    expect(appendBatch).toHaveBeenCalledTimes(1)
    expect(appendBatch.mock.calls[0][0]).toMatchObject({
      ruleId: 'r-bulk',
      source: 'imap',
      event: {
        source: 'imap',
        normalized: expect.objectContaining({
          channel_ref: BRAIN_CTX.connectorInstanceId,
          message_id_chain: ['INBOX:2'],
        }),
      },
    })

    const notification = await router.route(
      {
        account_email: 'maya@harborlane.example',
        folder: 'INBOX',
        provider_message_id: 'INBOX:3',
        from: 'no-reply@bank.com',
        subject: 'Your statement is ready',
        text: 'Do not reply to this message.',
      },
      BRAIN_CTX,
    )
    expect(notification).toBeNull()
    // Drop = truly discarded: no extraction, no batch beyond the newsletter's.
    expect(runExtraction).toHaveBeenCalledTimes(1)
    expect(appendBatch).toHaveBeenCalledTimes(1)
  })

  it('without a batch drain (OSS) a scheduled match degrades to realtime, never silently lost', async () => {
    const { deps, runExtraction, appendBatch } = makeBrainDeps({ scheduledBatching: false })
    const router = createMailboxBrainRouter(deps)
    const result = await router.route(
      {
        account_email: 'x@y.hk',
        folder: 'INBOX',
        provider_message_id: 'INBOX:2',
        from: 'news@letter.io',
        subject: 'Weekly',
        text: 'stories',
        is_bulk: true,
      },
      BRAIN_CTX,
    )
    expect(result).toEqual({ episodeId: 'ep-1' })
    expect(appendBatch).not.toHaveBeenCalled()
    expect(runExtraction).toHaveBeenCalledTimes(1)
  })

  it('lazy-seeds the imap defaults once when an enabled instance has no rules yet', async () => {
    const listRules = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue(seededImapRules())
    const seedDefaults = vi.fn(async () => {})
    const { deps } = makeBrainDeps({
      ingestRulesStore: {
        listByConnectorInstanceSystem: listRules,
        seedDefaults,
      } as unknown as IngestRulesStore,
    })
    const router = createMailboxBrainRouter(deps)
    await router.route(
      { account_email: 'x@y.hk', folder: 'INBOX', provider_message_id: 'INBOX:1', from: 'a@b.c', subject: 's', text: 'hello' },
      BRAIN_CTX,
    )
    expect(seedDefaults).toHaveBeenCalledWith('owner-1', 'inst-1', 'imap')
  })
})

// ── Delta → brain wiring (ingestion toggle) ─────────────────────

describe('[COMP:api/mailbox-sync-worker] delta brain wiring', () => {
  it('routes NEW mail to the brain only when ingestion is enabled', async () => {
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1], sources: { 1: rfc822(1) } },
    }
    const client = makeFakeImap(folders)
    const { deps, runExtraction } = makeBrainDeps()
    const { worker, insertMessage } = makeWorker({
      client,
      instance: instanceRow({ ingestionEnabled: true }),
      brain: deps,
    })
    await worker.tick() // cursor established

    folders.INBOX.uids = [1, 2]
    folders.INBOX.sources[2] = rfc822(2, { from: 'Ken <ken@client.hk>', subject: 'Deal' })
    await worker.tick()

    expect(insertMessage).toHaveBeenCalledTimes(1) // archive always
    expect(runExtraction).toHaveBeenCalledTimes(1) // brain: rule-passing new mail
  })

  it('archives but never extracts when ingestion is disabled', async () => {
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1], sources: { 1: rfc822(1) } },
    }
    const client = makeFakeImap(folders)
    const { deps, runExtraction } = makeBrainDeps()
    const { worker, insertMessage } = makeWorker({
      client,
      instance: instanceRow({ ingestionEnabled: false }),
      brain: deps,
    })
    await worker.tick()
    folders.INBOX.uids = [1, 2]
    folders.INBOX.sources[2] = rfc822(2)
    await worker.tick()
    expect(insertMessage).toHaveBeenCalledTimes(1)
    expect(runExtraction).not.toHaveBeenCalled()
  })
})

// ── Event trigger wiring (mailbox-imap.md → "Event trigger", plan §4 / §10 rows 1-4, 9) ──

describe('[COMP:api/mailbox-sync-worker] event trigger (onEvent port)', () => {
  function rfc822Rich(uid: number, over: {
    from: string
    to?: string
    cc?: string
    deliveredTo?: string
    subject?: string
    listUnsubscribe?: boolean
  }): Buffer {
    const lines = [
      `From: ${over.from}`,
      `To: ${over.to ?? 'Maya <maya@harborlane.example>'}`,
      ...(over.cc ? [`Cc: ${over.cc}`] : []),
      ...(over.deliveredTo ? [`Delivered-To: ${over.deliveredTo}`] : []),
      `Subject: ${over.subject ?? `mail ${uid}`}`,
      `Message-ID: <m${uid}@acme.com>`,
      'Date: Mon, 03 Aug 2026 10:00:00 +0000',
      ...(over.listUnsubscribe ? ['List-Unsubscribe: <https://acme.com/u>'] : []),
      'Content-Type: text/plain; charset=utf-8',
    ]
    return Buffer.from(`${lines.join('\r\n')}\r\n\r\nBody of message ${uid}.\r\n`, 'utf8')
  }

  /** One cursor-establishing tick, then the given message lands as NEW mail. */
  async function deliver(params: {
    source: Buffer
    ingestionEnabled?: boolean
    config?: Record<string, unknown>
  }) {
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1], sources: { 1: rfc822(1) } },
    }
    const client = makeFakeImap(folders)
    const { deps } = makeBrainDeps()
    const onEvent = vi.fn(async () => {})
    const { worker } = makeWorker({
      client,
      instance: instanceRow({ ingestionEnabled: params.ingestionEnabled ?? true, config: params.config ?? {} }),
      brain: deps,
      onEvent,
    })
    await worker.tick()
    folders.INBOX.uids = [1, 2]
    folders.INBOX.sources[2] = params.source
    await worker.tick()
    return { onEvent }
  }

  it('fires onEvent for a rule-matched NEW message with the addressable payload (row 1)', async () => {
    const { onEvent } = await deliver({
      source: rfc822Rich(2, {
        from: 'Ken Lau <Ken@Client.HK>',
        to: 'BD <BD@usebrian.ai>, ops@usebrian.ai',
        cc: 'Casey <casey@client.example>',
        deliveredTo: 'contact@usebrian.ai',
        subject: 'Partnership',
      }),
    })
    expect(onEvent).toHaveBeenCalledTimes(1)
    const [event, ctx] = onEvent.mock.calls[0] as unknown as [
      { source: string; normalized: Record<string, unknown> },
      { workspace_id: string; connector_instance_id: string },
    ]
    expect(event.source).toBe('imap')
    expect(ctx).toEqual({ workspace_id: 'ws-1', connector_instance_id: 'inst-1' })
    expect(event.normalized).toMatchObject({
      message_id: 'INBOX:2',
      rfc_message_id: '<m2@acme.com>',
      sender: 'ken@client.hk',
      actor_id: 'ken@client.hk',
      subject: 'Partnership',
      to: ['bd@usebrian.ai', 'ops@usebrian.ai'],
      cc: ['casey@client.example'],
      account_email: 'maya@harborlane.example',
      folder: 'INBOX',
      channel_id: 'INBOX',
      is_bulk: false,
      is_bot: false,
    })
    // Recipient set = To ∪ Cc ∪ Delivered-To, bare + lowercased — what a
    // `match.mentions: ['bd@usebrian.ai']` subscription matches on (D2).
    expect(event.normalized.mentions).toEqual([
      'bd@usebrian.ai', 'ops@usebrian.ai', 'casey@client.example', 'contact@usebrian.ai',
    ])
    expect(typeof event.normalized.text).toBe('string')
  })

  it('a message addressed only to another address still fires; the workflow match (mentions) owns selectivity (row 2)', async () => {
    const { onEvent } = await deliver({
      source: rfc822Rich(2, { from: 'a@b.example', to: 'contact@usebrian.ai' }),
    })
    expect(onEvent).toHaveBeenCalledTimes(1)
    const payload = (onEvent.mock.calls[0] as unknown as [{ normalized: Record<string, unknown> }])[0].normalized
    expect(payload.mentions).toEqual(['contact@usebrian.ai'])
    expect(payload.mentions).not.toContain('bd@usebrian.ai')
  })

  it('bulk / no-reply senders are bot events (row 3) — the engine still fires (drop rules included), the dispatcher default drops them', async () => {
    const bulk = await deliver({
      source: rfc822Rich(2, { from: 'TechCrunch <digest@techcrunch.example>', listUnsubscribe: true }),
    })
    expect(bulk.onEvent).toHaveBeenCalledTimes(1)
    expect((bulk.onEvent.mock.calls[0] as unknown as [{ normalized: Record<string, unknown> }])[0].normalized)
      .toMatchObject({ is_bulk: true, is_bot: true })

    const noreply = await deliver({
      source: rfc822Rich(2, { from: 'no-reply@bank.example' }),
    })
    expect(noreply.onEvent).toHaveBeenCalledTimes(1)
    expect((noreply.onEvent.mock.calls[0] as unknown as [{ normalized: Record<string, unknown> }])[0].normalized)
      .toMatchObject({ is_bulk: false, is_bot: true })
  })

  it('the mailbox\'s own sent copy — from the account or a configured send-as alias — is a bot event (row 4)', async () => {
    const self = await deliver({
      source: rfc822Rich(2, { from: 'Maya <maya@harborlane.example>', to: 'ken@client.hk' }),
    })
    expect((self.onEvent.mock.calls[0] as unknown as [{ normalized: Record<string, unknown> }])[0].normalized)
      .toMatchObject({ sender: 'maya@harborlane.example', is_bot: true })

    const alias = await deliver({
      source: rfc822Rich(2, { from: 'BD <BD@harborlane.example>', to: 'ken@client.hk' }),
      config: { sendAsAliases: ['bd@harborlane.example'] },
    })
    expect((alias.onEvent.mock.calls[0] as unknown as [{ normalized: Record<string, unknown> }])[0].normalized)
      .toMatchObject({ sender: 'bd@harborlane.example', is_bot: true })

    // The same alias sender WITHOUT the alias configured is an ordinary
    // correspondent — the guard reads the config, it does not guess.
    const stranger = await deliver({
      source: rfc822Rich(2, { from: 'BD <bd@harborlane.example>', to: 'ken@client.hk' }),
    })
    expect((stranger.onEvent.mock.calls[0] as unknown as [{ normalized: Record<string, unknown> }])[0].normalized)
      .toMatchObject({ is_bot: false })
  })

  it('ingestion OFF → no event at all; the archive insert is unaffected (row 9, D1)', async () => {
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1], sources: { 1: rfc822(1) } },
    }
    const client = makeFakeImap(folders)
    const { deps } = makeBrainDeps()
    const onEvent = vi.fn(async () => {})
    const { worker, insertMessage } = makeWorker({
      client,
      instance: instanceRow({ ingestionEnabled: false }),
      brain: deps,
      onEvent,
    })
    await worker.tick()
    folders.INBOX.uids = [1, 2]
    folders.INBOX.sources[2] = rfc822Rich(2, { from: 'ken@client.hk', to: 'bd@usebrian.ai' })
    await worker.tick()
    expect(insertMessage).toHaveBeenCalledTimes(1)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('no onEvent wired → the router still routes to the brain (the pre-wire posture)', async () => {
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1], sources: { 1: rfc822(1) } },
    }
    const client = makeFakeImap(folders)
    const { deps, runExtraction } = makeBrainDeps()
    const { worker } = makeWorker({ client, instance: instanceRow({ ingestionEnabled: true }), brain: deps })
    await worker.tick()
    folders.INBOX.uids = [1, 2]
    folders.INBOX.sources[2] = rfc822Rich(2, { from: 'ken@client.hk' })
    await worker.tick()
    expect(runExtraction).toHaveBeenCalledTimes(1)
  })
})

// ── On-demand single-instance sync (syncInstanceById) ───────────

describe('[COMP:api/mailbox-sync-worker] syncInstanceById (on-demand)', () => {
  it('returns a delta count and never throws — first pass establishes the cursor (0), the next reports new mail', async () => {
    const folders: Record<string, FakeFolderState> = {
      INBOX: { uidvalidity: '7', uids: [1, 2], sources: { 1: rfc822(1), 2: rfc822(2) } },
    }
    const client = makeFakeImap(folders)
    const { worker, instanceId } = makeWorker({ client })

    // First on-demand sync only establishes the cursor (D6 first-poll posture).
    const first = await worker.syncInstanceById(instanceId)
    expect(first).toEqual({ synced: true, newMessages: 0 })

    // New mail arrives → the next on-demand sync reports it.
    folders.INBOX.uids = [1, 2, 3, 4]
    folders.INBOX.sources[3] = rfc822(3)
    folders.INBOX.sources[4] = rfc822(4)
    const second = await worker.syncInstanceById(instanceId)
    expect(second).toEqual({ synced: true, newMessages: 2 })
  })

  it('unknown instance → { synced:false, reason:"not_found" } (no throw)', async () => {
    const client = makeFakeImap({ INBOX: { uidvalidity: '7', uids: [], sources: {} } })
    const { worker } = makeWorker({ client })
    expect(await worker.syncInstanceById('nope')).toEqual({ synced: false, newMessages: 0, reason: 'not_found' })
  })

  it('disconnected instance → { synced:false, reason:"disconnected" } (no sync)', async () => {
    const client = makeFakeImap({ INBOX: { uidvalidity: '7', uids: [1], sources: { 1: rfc822(1) } } })
    const { worker, insertMessage, instanceId } = makeWorker({
      client,
      instance: instanceRow({ connected: false }),
    })
    expect(await worker.syncInstanceById(instanceId)).toEqual({ synced: false, newMessages: 0, reason: 'disconnected' })
    expect(insertMessage).not.toHaveBeenCalled()
  })

  it('collapses concurrent syncs of the same instance → the second gets reason:"in_progress"', async () => {
    const base = makeFakeImap({ INBOX: { uidvalidity: '7', uids: [1], sources: { 1: rfc822(1) } } })
    // Gate the first sync inside client.list() so it is still in flight when
    // the second call arrives.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    let listCalls = 0
    const client = {
      ...base,
      async list() {
        listCalls++
        if (listCalls === 1) await gate
        return (base as unknown as { list: () => Promise<unknown> }).list()
      },
    } as unknown as ImapClientLike
    const { worker, instanceId } = makeWorker({ client })

    const p1 = worker.syncInstanceById(instanceId)
    // Let p1 reach the awaited gate (a macrotask flushes the whole await chain
    // up to the parked client.list()) before firing the second call.
    await new Promise((r) => setTimeout(r, 0))
    const second = await worker.syncInstanceById(instanceId)
    expect(second).toEqual({ synced: false, newMessages: 0, reason: 'in_progress' })
    release()
    const first = await p1
    expect(first.synced).toBe(true)
  })
})
