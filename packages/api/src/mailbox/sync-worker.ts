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
 *      cursor for the DELTA path (the ingest pollers' first-poll posture):
 *      history flows only through the confirmed backfill. When a backfill is
 *      already armed, that same first tick also runs it — a user-consented
 *      backfill never waits an extra poll interval to begin.
 *   2. BACKFILL (only after the D9 preflight + user confirmation armed it):
 *      newest-first, chunked per tick, checkpointed per folder
 *      (`backfillLow`), resumable across restarts. Backfill is archive-ONLY
 *      — historical mail never reaches the brain by default (D6).
 *
 * When the instance has `ingestion_enabled`, every rule-matched NEW message
 * ALSO fires the ingest engine's `onEvent` port (mailbox-imap.md → "Event
 * trigger"): boot wires the shared workflow event dispatcher there, so an
 * `event`-triggered workflow subscribed to the imap connector instance runs
 * with an addressable payload (`message_id`, recipients as `mentions`, the
 * folder as `channel_id`) and can read + reply in-thread. Self / alias /
 * bulk / machine senders carry `is_bot: true` so the assistant's own replies
 * (APPENDed to Sent, re-synced next tick) never re-fire (D3).
 *
 * Sync state is an OPAQUE per-provider cursor on `connector_instance.config`
 * (D13): `config.mailboxSync = { folders: { [path]: { uidvalidity, lastUid,
 * backfillLow?, backfillDone?, retryUids? } }, folderDiscoveryMisses?,
 * backfill? }`. Nothing above the seam is IMAP-shaped.
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
  isMachineSenderAddress,
  type AnalyticsLogger,
  type CrmStore,
  type EntityLinksStore,
  type EntityStore,
  type IngestEngine,
  type IngestEngineDeps,
  type IngestRule,
  type LLMProvider,
  type MailboxIngestMessage,
  type MemoryStore,
  type PipelineBEpisode,
  type PlaceholderResolver,
  type SourceKind,
  type TaskAdmissionPort,
  type TaskStore,
  type UsageStore,
} from '@use-brian/core'
import type { ConnectorInstance, ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { DbEpisodesStore } from '../db/episodes-store.js'
import type { IngestRuleRow, IngestRulesStore } from '../db/ingest-rules-store.js'
import { appendBatchEvent } from '../db/pending-ingest-batches-store.js'
import {
  countEmailArchiveMessages,
  deleteEmailArchiveFolder,
  findArchivedEmailUids,
  insertEmailArchiveMessage,
  type EmailArchiveMessageInput,
} from '../db/email-archive-store.js'
import {
  createMailboxSessionCache,
  createSocketKeepWarm,
  syncableFolders,
  type ImapClientLike,
  type ImapFetchedMessage,
  type MailboxSessionCache,
  type SocketKeepWarm,
} from './imap-session.js'
import { htmlToText, messageRef, parseReferencesHeader } from './mailbox-api.js'
import { bareEmailAddress, readSendAsAliases } from './send-as.js'
import type { MailboxAccountSettings } from './types.js'

// ── Sync-state (the opaque cursor, D13) ─────────────────────────

export type MailboxFolderCursor = {
  uidvalidity: string
  /** Highest UID already delta-synced. */
  lastUid: number
  /** Most recent server STATUS count; refreshed by every successful pass. */
  serverMessages?: number
  /** Backfill checkpoint — lowest UID already reconciled (descending walk). */
  backfillLow?: number
  backfillDone?: boolean
  /** Sparse durable retry ledger for UIDs that are still absent from the archive. */
  retryUids?: Record<string, MailboxUidRetry>
  /** Consecutive successful LIST passes that omitted this previously seen path. */
  consecutiveListMisses?: number
}

export type MailboxUidRetry = {
  attempts: number
  lastError: string
  lastAttemptAt: string
}

export type MailboxBackfillScope = '12m' | '2y' | 'all'

export type MailboxBackfillState = {
  scope: MailboxBackfillScope
  requestedAt: string
  /** Algorithm marker; older cursors are reopened once for gap reconciliation. */
  reconcileVersion?: number
  /**
   * `stalled` remains readable for cursors written by older releases. The
   * worker automatically resumes it as `running`; current releases never park
   * a mailbox permanently because transient failures must self-heal.
   */
  status: 'running' | 'done' | 'stalled'
  /** Current sum of per-folder STATUS counts, only present when complete. */
  totalEstimate?: number
  /** False means one or more folder STATUS calls failed; total is unknown. */
  estimateComplete?: boolean
  /** Consecutive failed backfill passes; reset by any successful pass. */
  consecutiveFailures?: number
  /** Most recent pass failure, surfaced to the user and cleared on recovery. */
  lastError?: string | null
  /** Last time a checkpoint advanced or a missing UID was successfully stored. */
  lastProgressAt?: string
}

/** A message the backfill permanently quarantined (un-fetchable / un-insertable). */
export type MailboxSkip = {
  folder: string
  uid: number
  /** `fetch: …` or `insert: …` — which stage rejected it, and why. */
  reason: string
  at: string
}

export type MailboxSyncState = {
  folders: Record<string, MailboxFolderCursor>
  /**
   * Consecutive direct-open failures for archive-known paths that have no
   * cursor yet. They cannot use `MailboxFolderCursor.consecutiveListMisses`:
   * fabricating UIDVALIDITY before STATUS succeeds could later make the
   * worker delete valid archive rows as if the provider had reassigned UIDs.
   */
  folderDiscoveryMisses?: Record<string, number>
  backfill?: MailboxBackfillState
  lastSyncAt?: string
  lastError?: string | null
  /**
   * When the last FAILED pass ran. Paired with `lastSyncAt` this is what makes
   * a stall legible: `lastError` alone cannot distinguish "failed once an hour
   * ago and recovered" from "has failed every five minutes for twelve days".
   */
  lastFailedSyncAt?: string | null
  /** Total messages quarantined so one bad message can't wedge the walk. */
  skippedCount?: number
  /** Bounded tail of recent quarantines for diagnosis (last MAX_RECENT_SKIPS). */
  recentSkips?: MailboxSkip[]
}

export function readMailboxSyncState(config: Record<string, unknown> | null | undefined): MailboxSyncState {
  const raw = (config?.mailboxSync ?? {}) as Partial<MailboxSyncState>
  return {
    folders: (raw.folders ?? {}) as Record<string, MailboxFolderCursor>,
    ...(raw.folderDiscoveryMisses ? { folderDiscoveryMisses: raw.folderDiscoveryMisses } : {}),
    ...(raw.backfill ? { backfill: raw.backfill } : {}),
    ...(raw.lastSyncAt ? { lastSyncAt: raw.lastSyncAt } : {}),
    ...(raw.lastError !== undefined ? { lastError: raw.lastError } : {}),
    ...(raw.lastFailedSyncAt !== undefined ? { lastFailedSyncAt: raw.lastFailedSyncAt } : {}),
    ...(raw.skippedCount !== undefined ? { skippedCount: raw.skippedCount } : {}),
    ...(raw.recentSkips ? { recentSkips: raw.recentSkips } : {}),
  }
}

/** Bound on the legacy diagnostic `recentSkips` tail — new backfills use `retryUids`. */
const MAX_RECENT_SKIPS = 25

/**
 * ImapFlow puts the useful half of a failure on properties, not on `message`:
 * a rejected command is the bare string `Command failed`, while the server's
 * actual words live on `responseText` and the machine-readable reason on
 * `serverResponseCode` / `code`. Keeping only `message` is why three wedged
 * mailboxes produced twelve days of `Command failed` with nothing to diagnose
 * from (2026-08-08). Append whatever detail is present, de-duplicated.
 */
function errText(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err)
  if (!err || typeof err !== 'object') return base
  const e = err as { responseText?: unknown; serverResponseCode?: unknown; code?: unknown }
  const parts = [base]
  for (const extra of [e.responseText, e.serverResponseCode, e.code]) {
    if (typeof extra !== 'string' || !extra.trim()) continue
    if (parts.some((p) => p.includes(extra))) continue
    parts.push(extra)
  }
  return parts.join(' — ')
}

/** Record one quarantined message on the sync state (count + bounded recent tail). */
function recordSkip(state: MailboxSyncState, skip: MailboxSkip): void {
  state.skippedCount = (state.skippedCount ?? 0) + 1
  const recent = state.recentSkips ?? []
  recent.push(skip)
  state.recentSkips = recent.length > MAX_RECENT_SKIPS ? recent.slice(-MAX_RECENT_SKIPS) : recent
}

function recordUidRetry(cursor: MailboxFolderCursor, uid: number, error: string, at: string): void {
  const key = String(uid)
  const previous = cursor.retryUids?.[key]
  cursor.retryUids ??= {}
  cursor.retryUids[key] = {
    attempts: (previous?.attempts ?? 0) + 1,
    lastError: error,
    lastAttemptAt: at,
  }
}

function clearUidRetry(cursor: MailboxFolderCursor, uid: number): void {
  if (!cursor.retryUids?.[String(uid)]) return
  delete cursor.retryUids[String(uid)]
  if (Object.keys(cursor.retryUids).length === 0) delete cursor.retryUids
}

function retryUidNumbers(cursor: MailboxFolderCursor): number[] {
  return Object.keys(cursor.retryUids ?? {})
    .map(Number)
    .filter((uid) => Number.isSafeInteger(uid) && uid > 0)
    .sort((a, b) => b - a)
}

export function backfillFloorDate(scope: MailboxBackfillScope, now: Date): Date | null {
  if (scope === 'all') return null
  const months = scope === '12m' ? 12 : 24
  const d = new Date(now)
  d.setMonth(d.getMonth() - months)
  return d
}


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
    return null // delta skips it; backfill retains its UID for durable retry
  }
  const env = msg.envelope ?? {}
  const from =
    parsed.from?.text ??
    (env.from?.[0] ? `${env.from[0].name ?? ''} <${env.from[0].address ?? ''}>`.trim() : '')
  // One entry PER ADDRESS. mailparser hands back one AddressObject per header
  // whose `.text` joins every recipient with commas, so mapping `.text` gave a
  // single "A <a@x>, b@y" string for a two-recipient To — the archive `to`
  // column is a list, and the event trigger's recipient set (`mentions`) must
  // be able to match one alias among several recipients.
  const toList = parsed.to
    ? addressTexts(Array.isArray(parsed.to) ? parsed.to : [parsed.to])
    : (env.to ?? []).map((a) => a.address ?? '').filter(Boolean)
  const ccList = parsed.cc
    ? addressTexts(Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc])
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
  // Delivered-To / X-Original-To: the address the server delivered INTO. For a
  // Workspace alias delivered into the primary this may be the only header that
  // names the alias when `To` carries a list address. Recipient-set input for
  // the event trigger only (mailbox-imap.md → "Event trigger").
  const deliveredTo = [
    ...headerAddressList(parsed.headers, 'delivered-to'),
    ...headerAddressList(parsed.headers, 'x-original-to'),
  ]
  // mailparser folds every `List-*` header into one structured `list` entry
  // (`headers.get('list') = { unsubscribe: {...} }`), so `has('list-unsubscribe')`
  // is always false — the raw header lines are the reliable check (found
  // 2026-08-19 while wiring the event trigger's `is_bot` guard; before this
  // only `Precedence: bulk` newsletters were detected on the parse path).
  const listHeader = parsed.headers?.get('list') as { unsubscribe?: unknown } | undefined
  const isBulk =
    parsed.headers?.has('list-unsubscribe') === true ||
    Boolean(listHeader && typeof listHeader === 'object' && listHeader.unsubscribe) ||
    headerLines.some((h) => /^(list-unsubscribe:|precedence:\s*(bulk|list))/i.test(h.line ?? ''))
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
      ...(deliveredTo.length ? { delivered_to: deliveredTo } : {}),
      subject,
      text: bodyText,
      timestamp: sentAtValid ? sentAtValid.toISOString() : null,
      references,
      is_bulk: isBulk,
      attachments,
    },
  }
}

/** Flatten mailparser AddressObjects to one `Name <addr>` / `addr` string per address (groups expanded). */
function addressTexts(objects: ReadonlyArray<{ text: string; value: ReadonlyArray<{ address?: string; name?: string; group?: ReadonlyArray<{ address?: string; name?: string }> }> }>): string[] {
  const out: string[] = []
  const push = (v: { address?: string; name?: string }): void => {
    if (!v.address) return
    out.push(v.name ? `${v.name} <${v.address}>` : v.address)
  }
  for (const obj of objects) {
    for (const v of obj.value ?? []) {
      if (v.group) for (const member of v.group) push(member)
      else push(v)
    }
    if ((obj.value ?? []).length === 0 && obj.text) out.push(obj.text)
  }
  return out
}

/**
 * Read one address-bearing header off the mailparser header map. mailparser
 * decodes address headers it knows (`to`/`cc`) into structured objects but
 * leaves `Delivered-To` / `X-Original-To` as raw strings (or a string array
 * when repeated), so both shapes are accepted; unparseable values are dropped.
 */
function headerAddressList(headers: Map<string, unknown> | undefined, name: string): string[] {
  const raw = headers?.get(name)
  const values: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  const out: string[] = []
  for (const v of values) {
    const text = typeof v === 'string'
      ? v
      : v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string'
        ? (v as { text: string }).text
        : null
    if (!text) continue
    for (const part of text.split(',')) {
      const bare = bareEmailAddress(part)
      if (bare && bare.includes('@') && !out.includes(bare)) out.push(bare)
    }
  }
  return out
}

// ── Brain router (rules engine → episode / digest batch / drop) ─────

export type MailboxBrainRouterDeps = {
  provider: LLMProvider
  /** Extraction model id — Standard tier per model-routing.md. */
  model: string
  resolveLlm?: (workspaceId: string) => Promise<{
    provider: LLMProvider
    model: string
    modelTier?: string
    providerKeySource?: 'user' | 'platform'
    inputTokenLimit: number
    maxTokens: number
  } | null>
  crm: CrmStore
  entities: EntityStore
  entityLinks: EntityLinksStore
  memories: MemoryStore
  tasks?: TaskStore
  /**
   * Extracted-task admission is required on this built-in realtime path.
   * `processEpisode` keeps the port optional for legacy callers, but pairing a
   * task store with no gate selects its direct-create fallback.
   */
  taskAdmission: TaskAdmissionPort
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
  /**
   * The ingest engine's event port (mailbox-imap.md → "Event trigger"). Boot
   * passes the shared workflow event dispatcher adapter
   * (`createIngestWorkflowTrigger(dispatcher)`, the same seam every connector
   * poller uses); the engine fires it once per rule-matched message -
   * including `drop` matches - and a workflow's own `match` owns selectivity.
   * Absent = brain routing only, no workflow events (the pre-wire posture).
   */
  onEvent?: IngestEngineDeps['onEvent']
}

export type MailboxBrainContext = {
  workspaceId: string
  connectorInstanceId: string
  userId: string
  assistantId: string | null
  /**
   * The mailbox's configured send-as aliases (`config.sendAsAliases`). Mail
   * FROM the account or one of these is the assistant's / owner's own outbound
   * copy and is flagged `is_bot` for the event trigger (D3). Optional so the
   * archive-only callers and tests need not supply it.
   */
  sendAsAliases?: ReadonlyArray<string>
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
    compartments: row.compartments ?? [],
    project_ids: row.projectIds ?? [],
  }
}

export function buildMailboxIngestEngine(
  rules: IngestRuleRow[],
  resolvePlaceholders: PlaceholderResolver,
  onEvent?: IngestEngineDeps['onEvent'],
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
    // Workflow event port - the router below owns the actual realtime /
    // scheduled work off the decision; the engine's stub pipelineB never runs
    // extraction, but its `onEvent` fires for every matched rule.
    ...(onEvent ? { onEvent } : {}),
  })
}

/**
 * The event-trigger payload for one synced message - what an `event`
 * workflow subscribed to this mailbox receives as `{{input.event.*}}`
 * (mailbox-imap.md → "Event trigger"). Every field the run needs to READ and
 * REPLY is here: `message_id` (`folder:uid`, the id `imapGetMessage` /
 * `imapSendMessage.inReplyTo` take), the recipients as `mentions` (so
 * `match.mentions: ['bd@…']` scopes a workflow to one alias - D2, no new
 * `EventMatch` field), the folder as `channel_id` (`match.inChannels:
 * ['INBOX']`), and the structural self-loop guard `is_bot` (D3): the sender is
 * the account or a configured send-as alias (the assistant's own reply,
 * APPENDed to Sent and re-synced), a bulk sender, or a machine local-part -
 * the dispatcher's default `fromBots: false` then never fires it.
 */
export function mailboxEventPayload(
  message: MailboxIngestMessage,
  sendAsAliases: ReadonlyArray<string> = [],
): Record<string, unknown> {
  const sender = bareEmailAddress(message.from ?? '')
  const bare = (list: ReadonlyArray<string> | undefined): string[] => {
    const out: string[] = []
    for (const v of list ?? []) {
      const b = bareEmailAddress(v)
      if (b && !out.includes(b)) out.push(b)
    }
    return out
  }
  const to = bare(message.to)
  const cc = bare(message.cc)
  const deliveredTo = bare(message.delivered_to)
  const mentions = [...new Set([...to, ...cc, ...deliveredTo])]
  const own = new Set([bareEmailAddress(message.account_email), ...sendAsAliases.map(bareEmailAddress)])
  const isBot =
    (sender !== '' && own.has(sender)) ||
    message.is_bulk === true ||
    isMachineSenderAddress(sender)
  return {
    sender,
    actor_id: sender,
    subject: (message.subject ?? '').trim(),
    text: (message.text ?? '').trim(),
    is_bulk: message.is_bulk === true,
    message_id: message.provider_message_id,
    rfc_message_id: message.rfc_message_id ?? null,
    to,
    cc,
    account_email: bareEmailAddress(message.account_email),
    folder: message.folder,
    channel_id: message.folder,
    timestamp: message.timestamp ?? null,
    mentions,
    is_bot: isBot,
    user_flags: [],
  }
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
    ruleId: string,
    compartments: string[],
    projectIds: string[],
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
      sourceRef: {
        ...envelope.source_ref,
        connector: 'imap',
        channel_ref: ctx.connectorInstanceId,
        rule_id: ruleId,
      },
      occurredAt: envelope.occurred_at,
      workspaceId: envelope.workspace_id,
      userId: envelope.user_id,
      assistantId: envelope.assistant_id,
      createdByUserId: envelope.created_by_user_id,
      createdByAssistantId: envelope.created_by_assistant_id,
      sensitivity: episodeRowSensitivity,
      compartments,
      projectIds,
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
      channelRef: ctx.connectorInstanceId,
      compartments: episode.compartments,
      projectIds: episode.projectIds,
    }
    const runtime = await deps.resolveLlm?.(ctx.workspaceId)
    await runExtraction(pipelineEpisode, content, {
      provider: runtime?.provider ?? deps.provider,
      model: runtime?.model ?? deps.model,
      modelTier: runtime?.modelTier,
      providerKeySource: runtime?.providerKeySource,
      inputTokenLimit: runtime?.inputTokenLimit,
      maxTokens: runtime?.maxTokens,
      crm: deps.crm,
      entities: deps.entities,
      entityLinks: deps.entityLinks,
      memories: deps.memories,
      tasks: deps.tasks,
      taskAdmission: deps.taskAdmission,
      episodes: deps.episodes,
      classifierModel: runtime?.model ?? deps.classifierModel,
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

      const engine = buildMailboxIngestEngine(rules, deps.resolvePlaceholders, deps.onEvent)
      const sender = message.from ? message.from.toLowerCase() : ''
      const decision = await engine.ingest(
        {
          source: 'imap',
          normalized: mailboxEventPayload(message, ctx.sendAsAliases ?? []),
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
            source: 'imap',
            normalized: {
              sender: bareEmailAddress(sender),
              subject,
              text: mailboxEpisodeText(message),
              timestamp: message.timestamp ?? null,
              message_id_chain: [
                ...(message.references ?? []),
                message.rfc_message_id ?? message.provider_message_id,
              ],
              channel_ref: ctx.connectorInstanceId,
            },
          },
          episodeSensitivity: decision.episode_sensitivity,
          compartments: decision.compartments,
          projectIds: decision.project_ids,
        })
        return null
      }

      // Realtime — also the scheduled fallback when no batch drain exists
      // (the WhatsApp OSS posture: better realtime than never-drained).
      return runRealtime(
        message,
        ctx,
        ruleSensitivity,
        decision.rule_id,
        decision.compartments,
        decision.project_ids,
      )
    },
  }
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
  findArchivedUids?: typeof findArchivedEmailUids
  countArchive?: typeof countEmailArchiveMessages
  intervalMs?: number
  /** Max NEW (delta) messages fetched per folder per tick. */
  deltaChunk?: number
  /** Max backfill messages fetched per folder per tick. */
  backfillChunk?: number
  /** Max backfill UIDs checked against the archive per folder per tick. */
  backfillReconcileWindow?: number
  /**
   * Builds the guard that keeps the IMAP socket from idling past its
   * inactivity timeout during the per-message insert phase. Injectable so
   * tests can drive the NOOP cadence without real clocks.
   */
  keepWarm?: (client: ImapClientLike) => SocketKeepWarm
  now?: () => Date
  /**
   * Workflow event port, threaded into the brain router's ingest engine
   * (see `MailboxBrainRouterDeps.onEvent`). Boot passes
   * `createIngestWorkflowTrigger(workflowEventDispatcher)`. Only reachable
   * when `brain` is wired AND the instance has `ingestion_enabled` (D1: the
   * card's Ingestion toggle is also the "may trigger workflows" switch).
   */
  onEvent?: IngestEngineDeps['onEvent']
}

/** Outcome of an on-demand single-instance sync (`syncInstanceById`). */
export type MailboxSyncSummary = {
  /** True when a sync pass actually ran. */
  synced: boolean
  /** New (delta) messages archived this pass; 0 when already up to date. */
  newMessages: number
  /** Why a sync did not run (only set when `synced` is false). */
  reason?: 'not_found' | 'disconnected' | 'in_progress' | 'error'
  /** Error message when `reason === 'error'`. */
  error?: string
}

export type MailboxSyncWorker = {
  start(): void
  stop(): void
  isRunning(): boolean
  /** One full pass over every connected imap instance (tests call this directly). */
  tick(): Promise<void>
  /**
   * Sync ONE instance right now — the on-demand path behind sync-on-connect
   * (the connect route fire-and-forgets this so the archive is live within
   * seconds, not the next poll interval) and the `syncMailboxNow` tool. Never
   * throws: a disconnected / missing / already-running instance returns a
   * reasoned summary instead. Concurrent calls for the same instance collapse
   * to one (`in_progress`).
   */
  syncInstanceById(instanceId: string): Promise<MailboxSyncSummary>
}

/**
 * Fetch a set of UIDs, isolating any the server errors on. An IMAP `FETCH`
 * over many UIDs dies as a unit — one poison message aborts the whole batch,
 * and because the backfill walks newest-first over a floor checkpoint that
 * same batch is retried first on every tick, stalling forever. On failure we
 * bisect until the offending UID is alone, then report it as `poison` for the
 * caller to retain in the durable retry ledger while the main walk continues.
 *
 * Guarded by `client.usable`: if the session itself dropped (connection lost
 * mid-fetch) we rethrow instead of bisecting, so a transient network failure
 * fails the whole tick (retried later, nothing discarded) rather than falsely
 * condemning every good message in the batch one UID at a time.
 *
 * Must run INSIDE an already-held mailbox lock — it never re-locks (imapflow's
 * lock is a non-reentrant mutex).
 */
async function fetchChunkResilient(
  client: ImapClientLike,
  uids: number[],
  query: Record<string, unknown>,
): Promise<{ fetched: ImapFetchedMessage[]; poison: number[] }> {
  const fetched: ImapFetchedMessage[] = []
  const poison: number[] = []

  async function drain(range: number[]): Promise<ImapFetchedMessage[]> {
    const want = new Set(range)
    const out: ImapFetchedMessage[] = []
    for await (const msg of client.fetch(range.join(','), query, { uid: true })) {
      if (want.has(msg.uid)) out.push(msg)
    }
    return out
  }

  async function recurse(range: number[]): Promise<void> {
    if (range.length === 0) return
    try {
      fetched.push(...(await drain(range)))
    } catch (err) {
      // Dead session, not a poison message — abort the walk, quarantine nothing.
      if (!client.usable) throw err
      if (range.length === 1) {
        poison.push(range[0])
        return
      }
      const mid = Math.ceil(range.length / 2)
      await recurse(range.slice(0, mid))
      await recurse(range.slice(mid))
    }
  }

  await recurse(uids)
  return { fetched, poison }
}

const DEFAULT_INTERVAL_MS = 5 * 60_000
const DEFAULT_DELTA_CHUNK = 100
const DEFAULT_BACKFILL_CHUNK = 200
const DEFAULT_BACKFILL_RECONCILE_WINDOW = 2_000
export const CURRENT_BACKFILL_RECONCILE_VERSION = 3
/** A renamed/deleted folder must not wedge history forever, but one short LIST is not enough to retire it. */
const MAX_CONSECUTIVE_FOLDER_LIST_MISSES = 3

export function createMailboxSyncWorker(deps: MailboxSyncWorkerDeps): MailboxSyncWorker {
  const sessions = deps.sessions ?? createMailboxSessionCache()
  const insertMessage = deps.insertMessage ?? insertEmailArchiveMessage
  const deleteFolder = deps.deleteFolder ?? deleteEmailArchiveFolder
  const findArchivedUids = deps.findArchivedUids ?? findArchivedEmailUids
  const countArchive = deps.countArchive ?? countEmailArchiveMessages
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const deltaChunk = deps.deltaChunk ?? DEFAULT_DELTA_CHUNK
  const backfillChunk = deps.backfillChunk ?? DEFAULT_BACKFILL_CHUNK
  const backfillReconcileWindow = Math.max(
    backfillChunk,
    deps.backfillReconcileWindow ?? DEFAULT_BACKFILL_RECONCILE_WINDOW,
  )
  const keepWarm = deps.keepWarm ?? ((client: ImapClientLike) => createSocketKeepWarm(client))
  const now = deps.now ?? (() => new Date())
  const router = deps.brain
    ? createMailboxBrainRouter(deps.onEvent ? { ...deps.brain, onEvent: deps.onEvent } : deps.brain)
    : null

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  // Instances with a sync in flight. Guards the poll tick and every on-demand
  // trigger against double-fetching the same mailbox (archive inserts are
  // idempotent, so this is a waste-avoider, not a correctness gate).
  const inFlight = new Set<string>()

  /** Run one instance sync under the in-flight guard. `'skipped'` = already running. */
  async function runGuarded(inst: ConnectorInstance): Promise<{ newMessages: number } | 'skipped'> {
    if (inFlight.has(inst.id)) return 'skipped'
    inFlight.add(inst.id)
    try {
      return await syncInstance(inst)
    } finally {
      inFlight.delete(inst.id)
    }
  }

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
  }): Promise<{ deltaInserted: number; backfillFailed: boolean }> {
    const { client, inst, settings, folder, state, workspaceId, assistantId } = params
    const ownerUserId = inst.userId
    if (!ownerUserId) return { deltaInserted: 0, backfillFailed: false }
    // Count of NEW (delta) mail archived this pass — the "N new messages"
    // reported by an on-demand `syncMailboxNow`. Backfill (historical) inserts
    // are archive-only catch-up, not new arrivals, and are not counted.
    let deltaInserted = 0
    let backfillFailed = false

    const status = await client.status(folder, { messages: true, uidNext: true, uidValidity: true })
    const uidvalidity = String(status.uidValidity ?? '')
    const uidNext = status.uidNext ?? 1
    const serverMessages = status.messages ?? 0
    let cursor: MailboxFolderCursor | undefined = state.folders[folder]

    // UIDVALIDITY change: the server reassigned this folder's UIDs — every
    // stored provider id is invalid. Rebuild the folder, touch nothing else.
    if (cursor && cursor.uidvalidity !== uidvalidity) {
      await deleteFolder(inst.id, folder)
      cursor = undefined
    }

    if (!cursor) {
      // First sync: establish the cursor. With `lastUid == uidNext-1` the
      // delta block below skips every pre-existing message (the first-poll
      // posture — history never reaches the brain un-consented). But a
      // backfill the user has ALREADY confirmed must not wait a whole extra
      // poll interval to start: fall through so it runs THIS tick. With no
      // armed backfill we're done — ingest nothing.
      cursor = { uidvalidity, lastUid: Math.max(0, uidNext - 1), serverMessages }
      state.folders[folder] = cursor
      if (!(state.backfill && state.backfill.status !== 'done')) {
        return { deltaInserted: 0, backfillFailed: false }
      }
    } else {
      cursor.serverMessages = serverMessages
      state.folders[folder] = cursor
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
      // The IMAP socket goes silent from here to the end of the loop while we
      // parse, insert and (below) brain-route each message — brain routing is
      // an LLM call, so this stretch is the longest quiet window in the sync.
      // Without the keep-warm the inactivity timeout kills the session
      // mid-walk. See `createSocketKeepWarm`.
      const deltaKeepWarm = keepWarm(client)
      for (const msg of fetched) {
        await deltaKeepWarm.pingIfIdle()
        const parsed = await parseSyncedMessage({ accountEmail: settings.email, folder, msg })
        if (parsed) {
          try {
            const { inserted } = await insertMessage({
              ...parsed.archive,
              instanceId: inst.id,
              workspaceId,
              ownerUserId,
            })
            if (inserted) deltaInserted++
            // Brain flow: NEW mail only, rule-selected, only when ingestion is
            // enabled on the instance (the connected card's toggle).
            if (inserted && router && inst.ingestionEnabled) {
              try {
                await router.route(parsed.brain, {
                  workspaceId,
                  connectorInstanceId: inst.id,
                  userId: ownerUserId,
                  assistantId,
                  sendAsAliases: readSendAsAliases(inst.config),
                })
              } catch (err) {
                console.error('[mailbox-sync] brain route failed (archive kept):', err)
              }
            }
          } catch (err) {
            // One un-insertable message must not wedge the delta cursor — skip
            // it (the advance below always runs). Same posture as an
            // unparseable message; here the archive insert itself rejected.
            recordSkip(state, { folder, uid: msg.uid, reason: `insert: ${errText(err)}`, at: now().toISOString() })
          }
        }
        cursor.lastUid = Math.max(cursor.lastUid, msg.uid)
        state.folders[folder] = cursor
      }
    }

    // ── Backfill: reconcile descending UID windows (archive-only, D6) ──
    //
    // `backfillLow` is a scan checkpoint, not proof that every higher UID was
    // inserted. Each window is compared with the archive first, so re-arming a
    // mailbox skips rows already present and downloads only gaps. A UID that
    // cannot be fetched, parsed, or inserted is recorded in a sparse durable
    // retry ledger; the main walk can continue while that UID is retried on
    // later worker ticks. Whole-pass failures are non-fatal and retry forever
    // at the worker cadence, so a transient provider outage cannot abandon the
    // user's history or block delta sync for this or later folders.
    const backfill = state.backfill
    if (backfill && backfill.status !== 'done') {
      // Cursors written by the former terminal-stall implementation recover
      // automatically after upgrade; new code never writes `stalled`.
      backfill.status = 'running'
      const runBackfillPass = async (): Promise<void> => {
        const passNow = now().toISOString()
        const floor = backfillFloorDate(backfill.scope, now())
        const lock = await client.getMailboxLock(folder)
        let inScope: number[] | false = false
        try {
          inScope = await client.search(floor ? { since: floor } : { all: true }, { uid: true })
        } finally {
          lock.release()
        }

        const inScopeUids = (inScope || []).filter((uid) => uid <= cursor.lastUid)
        const inScopeSet = new Set(inScopeUids)

        // First repair the retry ledger: an idempotent insert may have landed
        // before a crash, and a message may have since been deleted server-side.
        // Neither case needs another body download.
        const retryCandidates = retryUidNumbers(cursor)
        for (const uid of retryCandidates) {
          if (!inScopeSet.has(uid)) clearUidRetry(cursor, uid)
        }
        const remainingRetryCandidates = retryUidNumbers(cursor)
        const archivedRetries = await findArchivedUids(inst.id, folder, remainingRetryCandidates)
        for (const uid of archivedRetries) clearUidRetry(cursor, uid)
        // While the main scan is unfinished, reserve most of the body budget
        // for discovering fresh gaps. A large retry ledger must not starve the
        // rest of the mailbox. Once scanning is done, the full budget drains
        // retries.
        const retryBudget = cursor.backfillDone ? backfillChunk : Math.floor(backfillChunk / 4)
        const retryChunk = retryUidNumbers(cursor).slice(0, retryBudget)

        // Use the rest of the body-fetch budget to scan a much larger UID
        // window. Already-archived rows advance the checkpoint without FETCH.
        const newMissing: number[] = []
        let fullyScannedPending = false
        const remainingFetchBudget = backfillChunk - retryChunk.length
        if (!cursor.backfillDone && remainingFetchBudget > 0) {
          const high = cursor.backfillLow ?? cursor.lastUid + 1
          const pending = inScopeUids.filter((uid) => uid < high).sort((a, b) => b - a)
          if (pending.length === 0) {
            cursor.backfillDone = true
            fullyScannedPending = true
          } else {
            const window = pending.slice(0, backfillReconcileWindow)
            const archived = await findArchivedUids(inst.id, folder, window)
            let examined = 0
            for (const uid of window) {
              if (archived.has(uid)) {
                cursor.backfillLow = Math.min(cursor.backfillLow ?? Number.MAX_SAFE_INTEGER, uid)
                clearUidRetry(cursor, uid)
                backfill.lastProgressAt = passNow
                examined++
                continue
              }
              if (newMissing.length >= remainingFetchBudget) break
              newMissing.push(uid)
              examined++
            }
            fullyScannedPending = examined === pending.length
          }
        }

        const requested = [...retryChunk, ...newMissing]
        const newMissingSet = new Set(newMissing)
        if (requested.length > 0) {
          const query = {
            uid: true,
            envelope: true,
            internalDate: true,
            headers: ['references'],
            source: { start: 0, maxLength: SYNC_SOURCE_BYTES },
          }
          let fetched: ImapFetchedMessage[] = []
          let poison: number[] = []
          const fetchLock = await client.getMailboxLock(folder)
          try {
            const result = await fetchChunkResilient(client, requested, query)
            fetched = result.fetched
            poison = result.poison
          } finally {
            fetchLock.release()
          }

          const fetchedByUid = new Map(fetched.map((message) => [message.uid, message]))
          const poisonSet = new Set(poison)
          const backfillKeepWarm = keepWarm(client)
          for (const uid of requested) {
            const message = fetchedByUid.get(uid)
            let retryError: string | null = null
            if (poisonSet.has(uid)) {
              retryError = 'fetch: server errored on FETCH'
            } else if (!message) {
              retryError = 'fetch: server omitted requested UID'
            } else {
              await backfillKeepWarm.pingIfIdle()
              const parsed = await parseSyncedMessage({ accountEmail: settings.email, folder, msg: message })
              if (!parsed) {
                retryError = 'parse: message body could not be parsed'
              } else {
                try {
                  await insertMessage({
                    ...parsed.archive,
                    instanceId: inst.id,
                    workspaceId,
                    ownerUserId,
                  })
                  clearUidRetry(cursor, uid)
                  backfill.lastProgressAt = passNow
                } catch (err) {
                  retryError = `insert: ${errText(err)}`
                }
              }
            }

            if (retryError) recordUidRetry(cursor, uid, retryError, passNow)
            // Advancing only after the outcome (archive row or durable retry)
            // closes the crash window without letting an old retry skip newer,
            // not-yet-scanned UIDs.
            if (newMissingSet.has(uid)) {
              cursor.backfillLow = Math.min(cursor.backfillLow ?? Number.MAX_SAFE_INTEGER, uid)
              backfill.lastProgressAt = passNow
            }
            state.folders[folder] = cursor
          }
        }

        if (fullyScannedPending) cursor.backfillDone = true
        state.folders[folder] = cursor
      }

      try {
        await runBackfillPass()
      } catch (err) {
        backfillFailed = true
        const failures = (backfill.consecutiveFailures ?? 0) + 1
        backfill.consecutiveFailures = failures
        backfill.lastError = errText(err)
        console.warn(
          `[mailbox-sync] backfill pass failed for instance ${inst.id} (folder ${folder}, consecutive failures ${failures}): ${backfill.lastError}`,
        )
      }
      state.backfill = backfill
    }
    return { deltaInserted, backfillFailed }
  }

  async function syncInstance(inst: ConnectorInstance): Promise<{ newMessages: number }> {
    const creds = await deps.connectorInstanceStore.getAuthCredentialsSystem(inst.id)
    if (!creds || creds.type !== 'imap') return { newMessages: 0 }
    const { type: _t, ...settings } = creds
    const workspaceId = await resolveWorkspaceId(inst)
    if (!workspaceId) {
      console.warn(`[mailbox-sync] instance ${inst.id}: no resolvable workspace; skipped`)
      return { newMessages: 0 }
    }
    const assistantId = deps.resolveAssistantId ? await deps.resolveAssistantId(workspaceId) : null
    const state = readMailboxSyncState(inst.config)
    // This is the generation token for the state this pass may persist. The
    // user can explicitly restart `all` while the pass is in flight; a
    // conditional write below prevents this older cursor from winning that
    // race and erasing the newer request.
    const expectedBackfillRequestedAt = state.backfill?.requestedAt ?? null

    // Older workers treated `backfillLow` / `backfillDone` as proof that every
    // traversed UID landed. Reopen those cursors exactly once after upgrade so
    // an already-affected mailbox self-heals without a manual resync click.
    // Archive reconciliation makes this a metadata scan plus bodies for gaps,
    // not a replay of everything already stored.
    if (state.backfill && state.backfill.reconcileVersion !== CURRENT_BACKFILL_RECONCILE_VERSION) {
      state.backfill.reconcileVersion = CURRENT_BACKFILL_RECONCILE_VERSION
      state.backfill.status = 'running'
      for (const cursor of Object.values(state.folders)) {
        delete cursor.backfillLow
        delete cursor.backfillDone
        delete cursor.consecutiveListMisses
      }
      delete state.folderDiscoveryMisses
    }

    let newMessages = 0
    let activeFolderPaths: string[] = []
    let archiveFolderPaths: string[] = []
    let unresolvedOmittedFolders = 0
    let backfillPassFailed = false
    try {
      // The archive is durable evidence of folders the mutable cursor config
      // may have forgotten. Read it only when history has been armed;
      // delta-only mailboxes need no recovery roster.
      archiveFolderPaths = state.backfill
        ? Object.keys((await countArchive(inst.id)).byFolder)
        : []
      await sessions.withClient(`sync:${inst.id}`, settings, async (client) => {
        const listed = await client.list()
        const syncable = syncableFolders(listed)
        activeFolderPaths = syncable.map((folder) => folder.path)
        // Raw LIST membership matters here: a known path that is present but
        // filtered as Junk/Trash/Drafts/All/non-selectable is intentionally
        // excluded, not transiently omitted and eligible for a direct open.
        const listedPaths = new Set(listed.map((folder) => folder.path))
        for (const path of activeFolderPaths) {
          const cursor = state.folders[path]
          if (cursor) delete cursor.consecutiveListMisses
          if (state.folderDiscoveryMisses) delete state.folderDiscoveryMisses[path]
        }
        if (state.folderDiscoveryMisses && Object.keys(state.folderDiscoveryMisses).length === 0) {
          delete state.folderDiscoveryMisses
        }

        const durableFolderPaths = [...new Set([
          ...Object.keys(state.folders),
          ...archiveFolderPaths,
        ])]

        // A later LIST can reveal a folder that was missing when an earlier
        // pass declared the then-visible roster complete. Reopen the durable
        // request before syncFolder sees it, so the new/reappeared folder is
        // backfilled on this same tick instead of merely establishing a delta
        // cursor and silently skipping its history forever.
        if (state.backfill?.status === 'done') {
          const listedNeedsWork = activeFolderPaths.some((path) => {
            const cursor = state.folders[path]
            return !cursor || !cursor.backfillDone || retryUidNumbers(cursor).length > 0
          })
          const omittedNeedsDiscovery = durableFolderPaths.some((path) => {
            if (listedPaths.has(path)) return false
            const cursor = state.folders[path]
            if (cursor) {
              return (!cursor.backfillDone || retryUidNumbers(cursor).length > 0) &&
                (cursor.consecutiveListMisses ?? 0) < MAX_CONSECUTIVE_FOLDER_LIST_MISSES
            }
            return (state.folderDiscoveryMisses?.[path] ?? 0) < MAX_CONSECUTIVE_FOLDER_LIST_MISSES
          })
          if (listedNeedsWork || omittedNeedsDiscovery) state.backfill.status = 'running'
        }
        // Per-folder isolation: a folder that throws must not deny every LATER
        // folder its turn. Previously the first throw escaped this loop, so on a
        // mailbox whose second folder failed, folders three and four were never
        // synced again — indistinguishable from an empty mailbox. Collect and
        // report at the end instead, so the instance is still marked failing
        // (honest) but every folder got its pass (progress).
        const folderErrors: string[] = []
        for (const f of syncable) {
          try {
            const folderResult = await syncFolder({
              client,
              inst,
              settings,
              folder: f.path,
              state,
              workspaceId,
              assistantId,
            })
            newMessages += folderResult.deltaInserted
            backfillPassFailed ||= folderResult.backfillFailed
          } catch (err) {
            // A DEAD CREDENTIAL aborts the loop and is rethrown UNWRAPPED.
            // Both halves matter: every remaining folder would fail the same
            // way, and — the subtle one — the aggregate below is a fresh
            // `Error`, which does not carry `authenticationFailed`. Wrapping an
            // auth failure would therefore downgrade it to `degraded` and the
            // user would never be told to reconnect. Preserve the original.
            if ((err as { authenticationFailed?: boolean })?.authenticationFailed) throw err
            folderErrors.push(`${f.path}: ${errText(err)}`)
          }
        }

        // A successful LIST response can still be a transiently truncated
        // folder universe. While history is active, use the durable roster to
        // try omitted paths directly. If STATUS/SELECT still works, the path is
        // active and continues normally. Only repeated direct failures retire
        // a genuinely deleted/renamed path; LIST keeps running every later tick
        // and will reopen the walk if that path ever reappears.
        if (state.backfill?.status !== 'done') {
          const omitted = durableFolderPaths.filter((path) => {
            if (listedPaths.has(path)) return false
            const cursor = state.folders[path]
            if (cursor) {
              return (!cursor.backfillDone || retryUidNumbers(cursor).length > 0) &&
                (cursor.consecutiveListMisses ?? 0) < MAX_CONSECUTIVE_FOLDER_LIST_MISSES
            }
            return (state.folderDiscoveryMisses?.[path] ?? 0) < MAX_CONSECUTIVE_FOLDER_LIST_MISSES
          })
          for (const path of omitted) {
            const priorCursor = state.folders[path]
            try {
              const folderResult = await syncFolder({
                client,
                inst,
                settings,
                folder: path,
                state,
                workspaceId,
                assistantId,
              })
              delete state.folders[path]?.consecutiveListMisses
              if (state.folderDiscoveryMisses) delete state.folderDiscoveryMisses[path]
              activeFolderPaths.push(path)
              newMessages += folderResult.deltaInserted
              backfillPassFailed ||= folderResult.backfillFailed
            } catch (err) {
              if ((err as { authenticationFailed?: boolean })?.authenticationFailed) throw err
              const misses = priorCursor
                ? (priorCursor.consecutiveListMisses ?? 0) + 1
                : (state.folderDiscoveryMisses?.[path] ?? 0) + 1
              if (priorCursor) {
                priorCursor.consecutiveListMisses = misses
                state.folders[path] = priorCursor
              } else {
                state.folderDiscoveryMisses = {
                  ...state.folderDiscoveryMisses,
                  [path]: misses,
                }
              }
              if (misses < MAX_CONSECUTIVE_FOLDER_LIST_MISSES) unresolvedOmittedFolders++
            }
          }
        }
        if (folderErrors.length > 0) {
          if (state.backfill) {
            state.backfill.estimateComplete = false
            delete state.backfill.totalEstimate
          }
          throw new Error(
            `${folderErrors.length}/${syncable.length} folder(s) failed — ${folderErrors.join('; ')}`,
          )
        }
      })
      if (state.backfill) {
        if (!backfillPassFailed) {
          // No active folder's pass failed this tick. Clear only pass-level
          // transport/provider errors; per-UID failures stay in `retryUids`.
          state.backfill.consecutiveFailures = 0
          state.backfill.lastError = null
        }
        // Only folders selectable in the current LIST response participate in
        // totals and completion. Persisted cursors for renamed or `\Noselect`
        // containers must not keep an otherwise complete mailbox running.
        const activeCursors = activeFolderPaths
          .map((path) => state.folders[path])
          .filter((cursor): cursor is MailboxFolderCursor => Boolean(cursor))
        const estimateComplete = unresolvedOmittedFolders === 0 &&
          activeCursors.every((cursor) => typeof cursor.serverMessages === 'number')
        state.backfill.estimateComplete = estimateComplete
        if (estimateComplete) {
          state.backfill.totalEstimate = activeCursors.reduce((sum, cursor) => sum + (cursor.serverMessages ?? 0), 0)
        } else {
          delete state.backfill.totalEstimate
        }
        const allDone = unresolvedOmittedFolders === 0 && activeCursors.every(
          (cursor) => cursor.backfillDone && retryUidNumbers(cursor).length === 0,
        )
        state.backfill.status = allDone ? 'done' : 'running'
      }
      state.lastSyncAt = now().toISOString()
      state.lastError = null
      state.lastFailedSyncAt = null
      const persisted = await deps.connectorInstanceStore.setMailboxSyncStateSystem(
        inst.id,
        state,
        expectedBackfillRequestedAt,
      )
      if (!persisted) {
        console.info(`[mailbox-sync] instance ${inst.id}: preserved a newer mailbox history request`)
      }
      await deps.connectorInstanceStore.markHealth?.(inst.id, 'ok', null)
      return { newMessages }
    } catch (err) {
      const message = errText(err)
      state.lastError = message
      state.lastFailedSyncAt = now().toISOString()
      await deps.connectorInstanceStore
        .setMailboxSyncStateSystem(inst.id, state, expectedBackfillRequestedAt)
        .catch(() => false)
      // `auth_failed` stays reserved for a DEAD CREDENTIAL. inject.ts withholds
      // every mailbox tool from an `auth_failed` instance, so marking it on an
      // ordinary sync error would take away search/read/send from a mailbox
      // whose password is perfectly fine — the same over-marking that lost
      // GitHub for a whole workspace in the 2026-07-20 incident (see
      // mcp/connector-health.ts). An ordinary failure is `degraded` (migration
      // 425): the card shows it as failing, the tools keep working, and
      // reconnecting is correctly NOT offered as the remedy. A success resets
      // it to 'ok' on the path above.
      if ((err as { authenticationFailed?: boolean })?.authenticationFailed) {
        await deps.connectorInstanceStore.markHealth?.(inst.id, 'auth_failed', message).catch(() => {})
      } else {
        await deps.connectorInstanceStore.markHealth?.(inst.id, 'degraded', message).catch(() => {})
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
          await runGuarded(inst)
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

  async function syncInstanceById(instanceId: string): Promise<MailboxSyncSummary> {
    let inst: ConnectorInstance | undefined
    try {
      // No targeted system get-by-id on the store; imap instance volume is
      // modest and both callers (connect, on-demand tool) are low-frequency.
      const all = await deps.connectorInstanceStore.listByProviderSystem('imap')
      inst = all.find((i) => i.id === instanceId)
    } catch (err) {
      return { synced: false, newMessages: 0, reason: 'error', error: err instanceof Error ? err.message : String(err) }
    }
    if (!inst) return { synced: false, newMessages: 0, reason: 'not_found' }
    if (!inst.connected) return { synced: false, newMessages: 0, reason: 'disconnected' }
    try {
      const r = await runGuarded(inst)
      if (r === 'skipped') return { synced: false, newMessages: 0, reason: 'in_progress' }
      return { synced: true, newMessages: r.newMessages }
    } catch (err) {
      return { synced: false, newMessages: 0, reason: 'error', error: err instanceof Error ? err.message : String(err) }
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
    syncInstanceById,
  }
}
