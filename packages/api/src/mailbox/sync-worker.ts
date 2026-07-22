/**
 * Mailbox sync worker — the IMAP poller (mailbox-imap.md §Phase 2).
 *
 * Per connected `imap` connector instance, on a few-minute cadence:
 *
 *   1. DELTA sync (always): `UIDNEXT` polling per folder — every new message
 *      lands in the email archive corpus (D5), and, when the instance has
 *      `ingestion_enabled`, additionally routes through the instance's
 *      `ingest_rules` into the brain (connection-day-forward only, D6).
 *      A `UIDVALIDITY` change deletes and re-arms that folder — never
 *      corrupts (§5). The FIRST sync of a folder only establishes the
 *      cursor (the ingest pollers' first-poll posture): history flows only
 *      through the confirmed backfill.
 *   2. BACKFILL (only after the D9 preflight + user confirmation armed it):
 *      newest-first, chunked per tick, checkpointed per folder
 *      (`backfillLow`), resumable across restarts. Backfill is archive-ONLY
 *      — historical mail never reaches the brain by default (D6).
 *
 * Sync state is an OPAQUE per-provider cursor on `connector_instance.config`
 * (D13): `config.mailboxSync = { folders: { [path]: { uidvalidity, lastUid,
 * backfillLow? } }, backfill? }`. Nothing above the seam is IMAP-shaped.
 *
 * Structure follows `createKnowledgeSyncWorker` (own-table store, injected
 * seams, `start/stop/tick`); instance iteration + cursor persistence follow
 * the github ingest poller; inbound bodies are attacker-controlled and are
 * spotlight-delimited at the Pipeline B boundary (which `processEpisode`
 * applies to every source).
 *
 * [COMP:api/mailbox-sync-worker]
 */

import { simpleParser } from 'mailparser'
import {
  composeFilters,
  computeNextRun,
  createIngestEngine,
  mailboxEpisodeText,
  mailboxFilterImplementations,
  normalizeMailboxMessage,
  processEpisode,
  universalFilters,
  emailFilterImplementations,
  type AnalyticsLogger,
  type CrmStore,
  type EntityLinksStore,
  type EntityStore,
  type IngestEngine,
  type IngestRule,
  type LLMProvider,
  type MailboxIngestMessage,
  type MemoryStore,
  type PipelineBEpisode,
  type PlaceholderResolver,
  type SourceKind,
  type TaskStore,
  type UsageStore,
} from '@use-brian/core'
import type { ConnectorInstance, ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { DbEpisodesStore } from '../db/episodes-store.js'
import type { IngestRuleRow, IngestRulesStore } from '../db/ingest-rules-store.js'
import { appendBatchEvent } from '../db/pending-ingest-batches-store.js'
import {
  deleteEmailArchiveFolder,
  insertEmailArchiveMessage,
  type EmailArchiveMessageInput,
} from '../db/email-archive-store.js'
import {
  createMailboxSessionCache,
  type ImapClientLike,
  type ImapFetchedMessage,
  type MailboxSessionCache,
} from './imap-session.js'
import { htmlToText, messageRef, parseReferencesHeader } from './mailbox-api.js'
import type { MailboxAccountSettings } from './types.js'

// ── Sync-state (the opaque cursor, D13) ─────────────────────────

export type MailboxFolderCursor = {
  uidvalidity: string
  /** Highest UID already delta-synced. */
  lastUid: number
  /** Backfill checkpoint — lowest UID already archived (descending walk). */
  backfillLow?: number
  backfillDone?: boolean
}

export type MailboxBackfillScope = '12m' | '2y' | 'all'

export type MailboxBackfillState = {
  scope: MailboxBackfillScope
  requestedAt: string
  status: 'running' | 'done'
  /** STATUS-count ceiling captured at arm time — drives "Syncing N of M". */
  totalEstimate?: number
}

export type MailboxSyncState = {
  folders: Record<string, MailboxFolderCursor>
  backfill?: MailboxBackfillState
  lastSyncAt?: string
  lastError?: string | null
}

export function readMailboxSyncState(config: Record<string, unknown> | null | undefined): MailboxSyncState {
  const raw = (config?.mailboxSync ?? {}) as Partial<MailboxSyncState>
  return {
    folders: (raw.folders ?? {}) as Record<string, MailboxFolderCursor>,
    ...(raw.backfill ? { backfill: raw.backfill } : {}),
    ...(raw.lastSyncAt ? { lastSyncAt: raw.lastSyncAt } : {}),
    ...(raw.lastError !== undefined ? { lastError: raw.lastError } : {}),
  }
}

export function backfillFloorDate(scope: MailboxBackfillScope, now: Date): Date | null {
  if (scope === 'all') return null
  const months = scope === '12m' ? 12 : 24
  const d = new Date(now)
  d.setMonth(d.getMonth() - months)
  return d
}

/** Folders excluded from sync — junk/trash/drafts and virtual all-mail. */
const SKIP_SPECIAL_USE = new Set(['\\Junk', '\\Trash', '\\Drafts', '\\All'])

// ── Message parsing (fetched source → archive input + brain input) ──

const SYNC_SOURCE_BYTES = 512 * 1024

type ParsedSyncMessage = {
  archive: Omit<EmailArchiveMessageInput, 'instanceId' | 'workspaceId' | 'ownerUserId'>
  brain: MailboxIngestMessage
}

export async function parseSyncedMessage(params: {
  accountEmail: string
  folder: string
  msg: ImapFetchedMessage
}): Promise<ParsedSyncMessage | null> {
  const { accountEmail, folder, msg } = params
  if (!msg.source) return null
  let parsed
  try {
    parsed = await simpleParser(msg.source)
  } catch {
    return null // an unparseable message is skipped, never fatal (poller posture)
  }
  const env = msg.envelope ?? {}
  const from =
    parsed.from?.text ??
    (env.from?.[0] ? `${env.from[0].name ?? ''} <${env.from[0].address ?? ''}>`.trim() : '')
  const toList = parsed.to
    ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).map((a) => a.text)
    : (env.to ?? []).map((a) => a.address ?? '').filter(Boolean)
  const ccList = parsed.cc
    ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).map((a) => a.text)
    : []
  const bodyText =
    parsed.text ?? (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '')
  const subject = parsed.subject ?? env.subject ?? ''
  const sentAt = parsed.date ?? env.date ?? msg.internalDate ?? null
  const refsRaw = parsed.references
  const references = refsRaw ? (Array.isArray(refsRaw) ? refsRaw : [refsRaw]) : parseReferencesHeader(msg.headers)
  const attachments = (parsed.attachments ?? []).map((a) => ({
    filename: a.filename ?? 'attachment',
    mime: a.contentType ?? 'application/octet-stream',
    size: a.size ?? 0,
  }))
  const headerLines = parsed.headerLines ?? []
  const isBulk =
    parsed.headers?.has('list-unsubscribe') === true ||
    headerLines.some((h) => /^precedence:\s*(bulk|list)/i.test(h.line ?? ''))
  const providerMessageId = messageRef(folder, msg.uid)
  const rfcMessageId = parsed.messageId ?? env.messageId ?? null
  const sentAtDate = sentAt ? new Date(sentAt) : null
  const sentAtValid = sentAtDate && !Number.isNaN(sentAtDate.getTime()) ? sentAtDate : null

  return {
    archive: {
      folder,
      providerMessageId,
      rfcMessageId,
      subject,
      from,
      to: toList,
      cc: ccList,
      sentAt: sentAtValid,
      bodyText,
      inReplyTo: parsed.inReplyTo ?? env.inReplyTo ?? null,
      references,
      attachments,
    },
    brain: {
      account_email: accountEmail,
      folder,
      provider_message_id: providerMessageId,
      rfc_message_id: rfcMessageId,
      from,
      to: toList,
      cc: ccList,
      subject,
      text: bodyText,
      timestamp: sentAtValid ? sentAtValid.toISOString() : null,
      references,
      is_bulk: isBulk,
      attachments,
    },
  }
}

// ── Brain router (rules engine → episode / digest batch / drop) ─────

export type MailboxBrainRouterDeps = {
  provider: LLMProvider
  /** Extraction model id — Standard tier per model-routing.md. */
  model: string
  crm: CrmStore
  entities: EntityStore
  entityLinks: EntityLinksStore
  memories: MemoryStore
  tasks?: TaskStore
  episodes: DbEpisodesStore
  ingestRulesStore: IngestRulesStore
  resolvePlaceholders: PlaceholderResolver
  classifierModel?: string | null
  analytics?: AnalyticsLogger
  usageStore?: UsageStore
  ingestCharge?: (episode: { id: string; workspaceId: string; sourceKind: string; createdByUserId: string }) => Promise<void>
  /** Hosted batch worker available. False executes scheduled matches realtime (the WhatsApp OSS posture). */
  scheduledBatching?: boolean
  /** Test seam — defaults to core `processEpisode`. */
  runExtraction?: typeof processEpisode
  /** Test seam — defaults to `appendBatchEvent`. */
  appendBatchEvent?: typeof appendBatchEvent
  now?: () => Date
}

export type MailboxBrainContext = {
  workspaceId: string
  connectorInstanceId: string
  userId: string
  assistantId: string | null
}

function toEngineRule(row: IngestRuleRow): IngestRule {
  return {
    id: row.id,
    connector_instance_id: row.connectorInstanceId,
    source: row.source,
    rule_order: row.ruleOrder,
    filter_type: row.filterType,
    filter_params: row.filterParams,
    routing_mode: row.routingMode as IngestRule['routing_mode'],
    routing_schedule: row.routingSchedule,
    routing_timezone: row.routingTimezone,
    alert: row.alert,
    episode_sensitivity: row.episodeSensitivity,
  }
}

export function buildMailboxIngestEngine(
  rules: IngestRuleRow[],
  resolvePlaceholders: PlaceholderResolver,
): IngestEngine {
  const engineRules = rules.filter((r) => r.routingMode !== 'reply').map(toEngineRule)
  return createIngestEngine({
    rules: { listByConnectorInstance: async () => engineRules },
    // Universal + email axes (subject/domain for user-authored rules) +
    // mailbox axes (is_noreply / is_bulk — the seeded defaults).
    filters: composeFilters(universalFilters, emailFilterImplementations, mailboxFilterImplementations),
    batches: { appendEvent: async () => {} },
    pipelineB: { process: async () => ({ episodeId: null }) },
    resolvePlaceholders,
  })
}

const MAILBOX_SOURCE_KIND: SourceKind = 'email_thread'
const CONTENT_REF_MAX_CHARS = 16_000

export type MailboxBrainRouter = {
  /** Route one NEW message; resolves the episode id when realtime extraction ran. */
  route: (message: MailboxIngestMessage, ctx: MailboxBrainContext) => Promise<{ episodeId: string } | null>
}

export function createMailboxBrainRouter(deps: MailboxBrainRouterDeps): MailboxBrainRouter {
  const runExtraction = deps.runExtraction ?? processEpisode
  const appendEvent = deps.appendBatchEvent ?? appendBatchEvent
  const now = deps.now ?? (() => new Date())

  async function runRealtime(
    message: MailboxIngestMessage,
    ctx: MailboxBrainContext,
    ruleSensitivity: 'public' | 'internal' | 'confidential',
  ): Promise<{ episodeId: string }> {
    const envelope = normalizeMailboxMessage(message, {
      workspace_id: ctx.workspaceId,
      user_id: ctx.userId,
      assistant_id: ctx.assistantId,
      created_by_user_id: ctx.userId,
      created_by_assistant_id: ctx.assistantId,
    })
    const episodeRowSensitivity: 'public' | 'internal' | 'private' =
      ruleSensitivity === 'confidential' ? 'private' : ruleSensitivity
    const content = mailboxEpisodeText(message).slice(0, CONTENT_REF_MAX_CHARS)

    const episode = await deps.episodes.createEpisode(ctx.userId, {
      sourceKind: MAILBOX_SOURCE_KIND,
      sourceRef: envelope.source_ref,
      occurredAt: envelope.occurred_at,
      workspaceId: envelope.workspace_id,
      userId: envelope.user_id,
      assistantId: envelope.assistant_id,
      createdByUserId: envelope.created_by_user_id,
      createdByAssistantId: envelope.created_by_assistant_id,
      sensitivity: episodeRowSensitivity,
      contentRef: { kind: 'manual_paste', text: content },
      status: 'open',
    })

    const pipelineEpisode: PipelineBEpisode = {
      id: episode.id,
      sourceKind: episode.sourceKind as SourceKind,
      occurredAt: episode.occurredAt,
      sensitivity: ruleSensitivity,
      workspaceId: episode.workspaceId,
      userId: episode.userId,
      assistantId: episode.assistantId,
      createdByUserId: episode.createdByUserId,
      createdByAssistantId: episode.createdByAssistantId,
    }
    await runExtraction(pipelineEpisode, content, {
      provider: deps.provider,
      model: deps.model,
      crm: deps.crm,
      entities: deps.entities,
      entityLinks: deps.entityLinks,
      memories: deps.memories,
      tasks: deps.tasks,
      episodes: deps.episodes,
      classifierModel: deps.classifierModel,
      analytics: deps.analytics,
      usage: deps.usageStore,
      ingestCharge: deps.ingestCharge,
    })
    return { episodeId: episode.id }
  }

  return {
    async route(message, ctx) {
      const text = (message.text ?? '').trim()
      const subject = (message.subject ?? '').trim()
      if (!text && !subject) return null

      // Lazy-seed the imap defaults on the first routed message (idempotent —
      // an instance with ANY rule is never re-seeded, so user edits stick).
      let rules = await deps.ingestRulesStore.listByConnectorInstanceSystem(ctx.connectorInstanceId)
      if (rules.length === 0) {
        try {
          await deps.ingestRulesStore.seedDefaults(ctx.userId, ctx.connectorInstanceId, 'imap')
          rules = await deps.ingestRulesStore.listByConnectorInstanceSystem(ctx.connectorInstanceId)
        } catch (err) {
          console.error('[mailbox-sync] seedDefaults failed:', err)
        }
      }
      if (rules.length === 0) return null

      const engine = buildMailboxIngestEngine(rules, deps.resolvePlaceholders)
      const sender = message.from ? message.from.toLowerCase() : ''
      const decision = await engine.ingest(
        {
          source: 'imap',
          normalized: {
            sender: extractBareAddress(sender),
            actor_id: extractBareAddress(sender),
            subject,
            text,
            is_bulk: message.is_bulk === true,
            mentions: [],
            user_flags: [],
          },
        },
        { workspace_id: ctx.workspaceId, connector_instance_id: ctx.connectorInstanceId },
      )
      if (!decision.matched || decision.rule_id === null) return null
      if (decision.routing_mode === 'drop') return null

      const ruleSensitivity = (decision.episode_sensitivity ?? 'internal') as
        | 'public'
        | 'internal'
        | 'confidential'

      if (decision.routing_mode === 'scheduled' && deps.scheduledBatching) {
        const firesAt = decision.schedule
          ? computeNextRun({ type: 'cron', expression: decision.schedule }, decision.timezone || 'UTC', now())
          : now()
        await appendEvent({
          workspaceId: ctx.workspaceId,
          ruleId: decision.rule_id,
          source: 'imap',
          firesAt,
          event: {
            normalized: {
              sender: extractBareAddress(sender),
              subject,
              text: mailboxEpisodeText(message),
            },
          },
        })
        return null
      }

      // Realtime — also the scheduled fallback when no batch drain exists
      // (the WhatsApp OSS posture: better realtime than never-drained).
      return runRealtime(message, ctx, ruleSensitivity)
    },
  }
}

function extractBareAddress(mailbox: string): string {
  const angled = mailbox.match(/<([^<>\s]+@[^<>\s]+)>/)
  return (angled ? angled[1] : mailbox).trim().toLowerCase()
}

// ── The worker ──────────────────────────────────────────────────

export type MailboxSyncWorkerDeps = {
  connectorInstanceStore: ConnectorInstanceStore
  /**
   * Resolve the workspace an instance's archive rows + episodes land in:
   * workspace-scoped → its workspace; else `ingest_workspace_id` (an exposed
   * personal connector routes to the exposing workspace, migration 311);
   * else the owner's OWN personal workspace. Injected because the personal-
   * workspace lookup is a workspaces-table query this module must not own.
   */
  resolvePersonalWorkspaceId: (userId: string) => Promise<string | null>
  /** Workspace primary assistant for extraction attribution; null is fine. */
  resolveAssistantId?: (workspaceId: string) => Promise<string | null>
  /** Brain routing deps — absent = archive-only sync (brain flow dark). */
  brain?: MailboxBrainRouterDeps
  sessions?: MailboxSessionCache
  insertMessage?: typeof insertEmailArchiveMessage
  deleteFolder?: typeof deleteEmailArchiveFolder
  intervalMs?: number
  /** Max NEW (delta) messages fetched per folder per tick. */
  deltaChunk?: number
  /** Max backfill messages fetched per folder per tick. */
  backfillChunk?: number
  now?: () => Date
}

export type MailboxSyncWorker = {
  start(): void
  stop(): void
  isRunning(): boolean
  /** One full pass over every connected imap instance (tests call this directly). */
  tick(): Promise<void>
}

const DEFAULT_INTERVAL_MS = 5 * 60_000
const DEFAULT_DELTA_CHUNK = 100
const DEFAULT_BACKFILL_CHUNK = 200

export function createMailboxSyncWorker(deps: MailboxSyncWorkerDeps): MailboxSyncWorker {
  const sessions = deps.sessions ?? createMailboxSessionCache()
  const insertMessage = deps.insertMessage ?? insertEmailArchiveMessage
  const deleteFolder = deps.deleteFolder ?? deleteEmailArchiveFolder
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const deltaChunk = deps.deltaChunk ?? DEFAULT_DELTA_CHUNK
  const backfillChunk = deps.backfillChunk ?? DEFAULT_BACKFILL_CHUNK
  const now = deps.now ?? (() => new Date())
  const router = deps.brain ? createMailboxBrainRouter(deps.brain) : null

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function resolveWorkspaceId(inst: ConnectorInstance): Promise<string | null> {
    if (inst.workspaceId) return inst.workspaceId
    if (inst.ingestWorkspaceId) return inst.ingestWorkspaceId
    if (inst.userId) return deps.resolvePersonalWorkspaceId(inst.userId)
    return null
  }

  async function syncFolder(params: {
    client: ImapClientLike
    inst: ConnectorInstance
    settings: MailboxAccountSettings
    folder: string
    state: MailboxSyncState
    workspaceId: string
    assistantId: string | null
  }): Promise<void> {
    const { client, inst, settings, folder, state, workspaceId, assistantId } = params
    const ownerUserId = inst.userId
    if (!ownerUserId) return

    const status = await client.status(folder, { messages: true, uidNext: true, uidValidity: true })
    const uidvalidity = String(status.uidValidity ?? '')
    const uidNext = status.uidNext ?? 1
    let cursor: MailboxFolderCursor | undefined = state.folders[folder]

    // UIDVALIDITY change: the server reassigned this folder's UIDs — every
    // stored provider id is invalid. Rebuild the folder, touch nothing else.
    if (cursor && cursor.uidvalidity !== uidvalidity) {
      await deleteFolder(inst.id, folder)
      cursor = undefined
    }

    if (!cursor) {
      // First sync: establish the cursor, ingest nothing (first-poll
      // posture). History flows only through the confirmed backfill; a
      // pre-existing backfill consent re-arms automatically (backfillLow
      // resets with the cursor).
      state.folders[folder] = { uidvalidity, lastUid: Math.max(0, uidNext - 1) }
      return
    }

    // ── Delta: new mail since lastUid ──
    if (uidNext - 1 > cursor.lastUid) {
      const lock = await client.getMailboxLock(folder)
      const fetched: ImapFetchedMessage[] = []
      try {
        for await (const msg of client.fetch(
          `${cursor.lastUid + 1}:*`,
          {
            uid: true,
            envelope: true,
            internalDate: true,
            headers: ['references'],
            source: { start: 0, maxLength: SYNC_SOURCE_BYTES },
          },
          { uid: true },
        )) {
          // `n:*` always matches at least the last message — skip stale UIDs.
          if (msg.uid > cursor.lastUid) fetched.push(msg)
          if (fetched.length >= deltaChunk) break
        }
      } finally {
        lock.release()
      }
      fetched.sort((a, b) => a.uid - b.uid)
      for (const msg of fetched) {
        const parsed = await parseSyncedMessage({ accountEmail: settings.email, folder, msg })
        if (parsed) {
          const { inserted } = await insertMessage({
            ...parsed.archive,
            instanceId: inst.id,
            workspaceId,
            ownerUserId,
          })
          // Brain flow: NEW mail only, rule-selected, only when ingestion is
          // enabled on the instance (the connected card's toggle).
          if (inserted && router && inst.ingestionEnabled) {
            try {
              await router.route(parsed.brain, {
                workspaceId,
                connectorInstanceId: inst.id,
                userId: ownerUserId,
                assistantId,
              })
            } catch (err) {
              console.error('[mailbox-sync] brain route failed (archive kept):', err)
            }
          }
        }
        cursor.lastUid = Math.max(cursor.lastUid, msg.uid)
        state.folders[folder] = cursor
      }
    }

    // ── Backfill: descending walk below backfillLow (archive-only, D6) ──
    const backfill = state.backfill
    if (backfill && backfill.status === 'running' && !cursor.backfillDone) {
      const floor = backfillFloorDate(backfill.scope, now())
      const lock = await client.getMailboxLock(folder)
      let inScope: number[] | false = false
      try {
        inScope = await client.search(
          floor ? { since: floor } : { all: true },
          { uid: true },
        )
      } finally {
        lock.release()
      }
      const high = cursor.backfillLow ?? cursor.lastUid + 1
      const pending = (inScope || []).filter((uid) => uid < high).sort((a, b) => b - a)
      if (pending.length === 0) {
        cursor.backfillDone = true
        state.folders[folder] = cursor
        return
      }
      const chunk = pending.slice(0, backfillChunk)
      const chunkSet = new Set(chunk)
      const fetched: ImapFetchedMessage[] = []
      const lock2 = await client.getMailboxLock(folder)
      try {
        for await (const msg of client.fetch(
          chunk.join(','),
          {
            uid: true,
            envelope: true,
            internalDate: true,
            headers: ['references'],
            source: { start: 0, maxLength: SYNC_SOURCE_BYTES },
          },
          { uid: true },
        )) {
          if (chunkSet.has(msg.uid)) fetched.push(msg)
        }
      } finally {
        lock2.release()
      }
      // Newest-first: recent mail is searchable within minutes of consent.
      fetched.sort((a, b) => b.uid - a.uid)
      for (const msg of fetched) {
        const parsed = await parseSyncedMessage({ accountEmail: settings.email, folder, msg })
        if (parsed) {
          await insertMessage({
            ...parsed.archive,
            instanceId: inst.id,
            workspaceId,
            ownerUserId,
          })
        }
        cursor.backfillLow = Math.min(cursor.backfillLow ?? Number.MAX_SAFE_INTEGER, msg.uid)
        state.folders[folder] = cursor
      }
      if (chunk.length === pending.length) {
        cursor.backfillDone = true
        state.folders[folder] = cursor
      }
    }
  }

  async function syncInstance(inst: ConnectorInstance): Promise<void> {
    const creds = await deps.connectorInstanceStore.getAuthCredentialsSystem(inst.id)
    if (!creds || creds.type !== 'imap') return
    const { type: _t, ...settings } = creds
    const workspaceId = await resolveWorkspaceId(inst)
    if (!workspaceId) {
      console.warn(`[mailbox-sync] instance ${inst.id}: no resolvable workspace; skipped`)
      return
    }
    const assistantId = deps.resolveAssistantId ? await deps.resolveAssistantId(workspaceId) : null
    const state = readMailboxSyncState(inst.config)

    try {
      await sessions.withClient(`sync:${inst.id}`, settings, async (client) => {
        const folders = await client.list()
        const syncable = folders.filter((f) => {
          const special = (f as { specialUse?: string }).specialUse
          return !special || !SKIP_SPECIAL_USE.has(special)
        })
        for (const f of syncable) {
          await syncFolder({
            client,
            inst,
            settings,
            folder: f.path,
            state,
            workspaceId,
            assistantId,
          })
        }
      })
      if (state.backfill && state.backfill.status === 'running') {
        const allDone = Object.values(state.folders).every((c) => c.backfillDone)
        if (allDone) state.backfill = { ...state.backfill, status: 'done' }
      }
      state.lastSyncAt = now().toISOString()
      state.lastError = null
      await deps.connectorInstanceStore.setConfigSystem(inst.id, { mailboxSync: state })
      await deps.connectorInstanceStore.markHealth?.(inst.id, 'ok', null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      state.lastError = message
      await deps.connectorInstanceStore.setConfigSystem(inst.id, { mailboxSync: state }).catch(() => {})
      if ((err as { authenticationFailed?: boolean })?.authenticationFailed) {
        await deps.connectorInstanceStore.markHealth?.(inst.id, 'auth_failed', message).catch(() => {})
      }
      throw err
    }
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const instances = await deps.connectorInstanceStore.listByProviderSystem('imap')
      for (const inst of instances) {
        if (!inst.connected) continue
        try {
          await syncInstance(inst)
        } catch (err) {
          console.error(
            `[mailbox-sync] instance ${inst.id} failed:`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), intervalMs)
      timer.unref?.()
      void tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    isRunning() {
      return timer !== null
    },
    tick,
  }
}
