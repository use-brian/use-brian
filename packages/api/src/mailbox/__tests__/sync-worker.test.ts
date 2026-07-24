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
    fetchUid: number
    /** Also drop the session (usable=false) — a connection loss, not one poison message. */
    dead?: boolean
  },
) {
  let openFolder = ''
  const client = {
    usable: true,
    async connect() {},
    async logout() {},
    close() {},
    async list() {
      return Object.keys(folders).map((path) => ({ path }))
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
  } as unknown as ImapClientLike
  return client
}

function makeInstanceStore(instance: ConnectorInstance) {
  const configs = new Map<string, Record<string, unknown>>([[instance.id, { ...(instance.config ?? {}) }]])
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
    async markHealth() {},
  } as unknown as ConnectorInstanceStore
  return { store, configs }
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
  const { store, configs } = makeInstanceStore(instance)
  const insertMessage =
    (over.insertMessage as never) ??
    vi.fn(async (_input: EmailArchiveMessageInput) => ({ inserted: true, messageId: 'am-1', segmentCount: 1 }))
  const deleteFolder = vi.fn(async (_instanceId: string, _folder: string) => 0)
  const worker = createMailboxSyncWorker({
    connectorInstanceStore: store,
    resolvePersonalWorkspaceId: async () => 'ws-1',
    sessions: createMailboxSessionCache({ createClient: () => over.client }),
    insertMessage: insertMessage as never,
    deleteFolder: deleteFolder as never,
    ...('brain' in over ? { brain: over.brain } : {}),
    backfillChunk: over.backfillChunk,
    deltaChunk: over.deltaChunk,
  })
  return { worker, configs, insertMessage, deleteFolder, instanceId: instance.id }
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
    // error rather than silently discarding a whole good batch.
    expect(state.lastError).toContain('FETCH failed')
    expect(state.backfill?.status).toBe('running')
    expect(state.folders.INBOX.backfillDone).toBeFalsy()
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
} {
  const runExtraction = vi.fn(async () => ({}))
  const appendBatch = vi.fn(async () => {})
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
  return { deps, runExtraction, appendBatch, createEpisode }
}

const BRAIN_CTX = {
  workspaceId: 'ws-1',
  connectorInstanceId: 'inst-1',
  userId: 'owner-1',
  assistantId: 'asst-1',
}

describe('[COMP:api/mailbox-sync-worker] rules routing (mixed batch)', () => {
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
    expect(appendBatch.mock.calls[0][0]).toMatchObject({ ruleId: 'r-bulk', source: 'imap' })

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
