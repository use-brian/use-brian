/**
 * Session kind: the ONE reader of the session discriminator columns.
 *
 * A conversation is classified once into four orthogonal facts:
 *   - audience  - who the conversation belongs to (`personal` | `workspace`);
 *   - anchor    - what it is attached to (a doc thread, an Office file, a feed
 *                 draft, an external channel, the inbox, a job, or nothing);
 *   - transport - which wire carries it (`web`, `telegram`, `slack`, ...);
 *   - lane      - `conversation` (humans talk here) or `machine` (A2A,
 *                 workflow, public API, inspection, legacy cron).
 *
 * `classifySession` is the only code allowed to compare `visibility`, `mode`,
 * `app_origin`, the session `channel_type` or the `channel_id` sentinels.
 * Every concern (read, admission, attribution, delivery, live follow,
 * confirmations, lifecycle, billing, ...) is answered once by `sessionPolicy`.
 * Tool interactivity is deliberately NOT a session concern (D13): it comes
 * from the principal driving the turn (`ToolContext.attended`, stamped from
 * the execution identity), so a person in a doc thread is attended and a
 * workflow on Telegram is not.
 * Graded by `pnpm check` (`invariants/session-kind-single-source`).
 *
 * Spec: docs/architecture/context-engine/session-messages.md -> "Session kind".
 * Plan: docs/plans/unified-sessions.md section 4.1 / 4.2.
 *
 * [COMP:api/session-kind] [COMP:api/session-policy]
 */

export type Audience = 'personal' | 'workspace'

export type AnchorKind =
  | 'none'
  | 'doc_thread'
  | 'office_file'
  | 'feed_draft'
  | 'feed_thread'
  | 'channel'
  | 'inbox'
  | 'job'

export type Anchor = { kind: AnchorKind; ref: string | null }

export type Transport =
  | 'web'
  | 'telegram'
  | 'slack'
  | 'discord'
  | 'feishu'
  | 'msteams'
  | 'whatsapp'
  | 'wechat'
  | 'email'
  | 'custom'
  | 'imessage'
  | 'api'
  | 'internal'

export type Lane = 'conversation' | 'machine'

/** Which machine lane a `lane='machine'` row is (D17). Null for conversations. */
export type MachineLane = 'a2a' | 'workflow' | 'api' | 'inspection' | 'cron' | 'programmatic' | 'internal'

export type SessionKind = {
  audience: Audience
  anchor: Anchor
  transport: Transport
  lane: Lane
  machine: MachineLane | null
  /**
   * The app surface the row was opened from (`chat`, `doc`, `brain`, ...).
   * A hint for personal-history scoping only; never an authority input.
   */
  surface: string | null
}

/** The row fields the classifier reads. Every session shape satisfies it. */
export type SessionKindRow = {
  visibility?: string | null
  mode?: string | null
  channelType: string
  appOrigin?: string | null
  channelId?: string | null
  transient?: boolean | null
}

// --- Transport -------------------------------------------------------------

/** Provider transports a human talks to the assistant through. */
export const EXTERNAL_TRANSPORTS = [
  'telegram',
  'slack',
  'discord',
  'feishu',
  'msteams',
  'whatsapp',
  'wechat',
  'email',
  'custom',
  'imessage',
] as const satisfies readonly Transport[]

/** Session `channel_type` values that are machine lanes, and which lane. */
const MACHINE_CHANNEL_TYPES: Record<string, MachineLane> = {
  'assistant-call': 'a2a',
  'a2a-external': 'a2a',
  workflow: 'workflow',
  api: 'api',
  brain_inspection: 'inspection',
  brain_edit: 'inspection',
  cron: 'cron',
  programmatic: 'programmatic',
  assistant_mcp: 'programmatic',
  system: 'internal',
  synthesis: 'internal',
  worker: 'internal',
  'skill-draft': 'internal',
  replay: 'internal',
  'home-refresh': 'internal',
  session_resume: 'internal',
  adhoc: 'internal',
}

/** Web-hosted anchored surfaces (pre-S3 they were stored as their own channel_type). */
const WEB_ANCHOR_CHANNEL_TYPES: Record<string, AnchorKind> = {
  doc_thread: 'doc_thread',
  office_thread: 'office_file',
  feed_thread: 'feed_thread',
  notification: 'inbox',
}

/** Storage `channel_type` of an Office file's shared thread. */
export const OFFICE_FILE_THREAD_CHANNEL_TYPE = 'office_thread'

function transportOf(channelType: string): Transport {
  if (channelType === 'web' || channelType === 'doc' || channelType in WEB_ANCHOR_CHANNEL_TYPES) return 'web'
  if (channelType === 'agentmail') return 'email'
  if ((EXTERNAL_TRANSPORTS as readonly string[]).includes(channelType)) return channelType as Transport
  if (channelType === 'api') return 'api'
  return 'internal'
}

/** Is this a provider transport (a human on Telegram, Slack, ...)? */
export function isExternalTransport(transport: Transport): boolean {
  return (EXTERNAL_TRANSPORTS as readonly string[]).includes(transport)
}

// --- Classifier ------------------------------------------------------------

/**
 * Classify a session row. The ONLY reader of the discriminator columns.
 */
export function classifySession(row: SessionKindRow): SessionKind {
  const channelType = row.channelType
  const channelId = row.channelId ?? null
  const machine: MachineLane | null = MACHINE_CHANNEL_TYPES[channelType]
    ?? (row.transient === true ? 'inspection' : null)

  let anchor: Anchor = { kind: 'none', ref: null }
  if (channelType in WEB_ANCHOR_CHANNEL_TYPES) {
    anchor = { kind: WEB_ANCHOR_CHANNEL_TYPES[channelType]!, ref: channelId }
  } else if (channelId === 'notifications') {
    anchor = { kind: 'inbox', ref: null }
  } else if (row.mode === 'draft') {
    anchor = { kind: 'feed_draft', ref: channelId }
  } else if (machine === 'workflow' || machine === 'cron') {
    anchor = { kind: 'job', ref: channelId }
  }

  const audience: Audience = row.visibility === 'workspace' || row.mode === 'draft' ? 'workspace' : 'personal'

  return {
    audience,
    anchor,
    transport: transportOf(channelType),
    lane: machine ? 'machine' : 'conversation',
    machine,
    surface: row.appOrigin ?? null,
  }
}

/** The settings-panel tuning conversation (sentinel `channel_id='tuning'`). */
export function isTuningSession(row: Pick<SessionKindRow, 'channelId'>): boolean {
  return row.channelId === 'tuning'
}

// --- Policy ----------------------------------------------------------------

/**
 * Which anchor-specific gate a workspace read passes through in addition to
 * workspace membership + clearance + compartments.
 */
export type AnchorReadGate = 'none' | 'feed_draft_audience' | 'feed_collaboration' | 'office_file'

export type ReadPolicy =
  | { rule: 'owner' }
  | { rule: 'workspace'; anchorGate: AnchorReadGate }

export type SessionPolicy = {
  /**
   * Read access, ONE rule for open, list, follow and the Live roster (L3,
   * L4): personal rows are owner-only; workspace rows pass the membership
   * decision (`decideSessionRead`) and the anchor's gate
   * (`anchorReadGate`, session-read-authority.ts).
   */
  read: ReadPolicy
  /** Free posting without a turn (`POST /api/sessions/:id/messages`). */
  post: boolean
  /**
   * Turn admission, by audience (D11, L7). `room`: free posting, one queued
   * follow-up turn, folding, an atomic slot claim. `personal`: reject while
   * the lease is live, reclaim a stale one.
   */
  admission: 'personal' | 'room'
  /**
   * Does a message need to address the assistant to run a turn (D12)? Plain
   * and channel rooms are mention-gated; anchored threads and drafts treat
   * every message as addressed.
   */
  addressing: 'mention' | 'every_message'
  /** Sender stamping and whether names / the participants block reach the model (L8). */
  attribution: { stamp: boolean; namesReachModel: boolean }
  /** Memory sources a turn loads (D3, L16). */
  context: { personalMemory: boolean }
  /** Delivery ceiling and recipient type (L9). */
  deliveryCeiling: { ceiling: 'audience' | 'owner'; recipientType: 'group' | 'individual' }
  /**
   * Do other viewers follow this session's turns live (L6)? ONE answer for
   * every bus publisher (rows, tool input, turn start/finish), the stuck-turn
   * sweeper's heal broadcast, and the follow stream: every workspace session.
   * A personal session is followed only by its owner's own tabs.
   */
  liveFollow: boolean
  /**
   * Does the surface keep a live presence roster, so its follow stream stays
   * open for the session's whole life rather than one turn: rooms (typing,
   * who is here) and an Office file's Brian rail.
   */
  presence: boolean
  /**
   * Who may resolve a confirmation raised by a turn (L5): the owner of a
   * personal session; in any workspace session, the member who addressed
   * the turn or a workspace admin.
   */
  confirmations: 'owner' | 'addresser_or_admin'
  /** Rename / delete authority beyond the owner (L11). */
  lifecycle: { adminRename: boolean; adminDelete: boolean }
  /**
   * Counts as human activity, per consumer (L13): the memory "active user"
   * probe, the playbook miner, the Live roster, and workspace search.
   */
  humanActivity: { memory: boolean; playbook: boolean; live: boolean; search: boolean }
  /**
   * Does the turn's `sessionId` name a persisted `sessions` row, per
   * consumer (L14): task provenance and CRM provenance.
   */
  persistedRow: { tasks: boolean; crm: boolean }
  /** Who pays for a turn (D2, L18). */
  billing: 'user' | 'addresser' | 'workspace'
  /** Compaction strategy. */
  compaction: 'context_pressure' | 'idle_tiered'
  /** Creation admission applies to a workspace insert (L12). */
  createAdmission: boolean
  /** Where `effective_clearance` comes from (D10, L10). */
  clearanceSource: 'assistant' | 'anchor'
  /** Does an assistant clearance recompute overwrite this row (L10)? */
  clearanceRecompute: boolean
}

/** Is this the Chat app's workspace room (web, workspace, opened from chat)? */
function isWebRoom(kind: SessionKind): boolean {
  return kind.audience === 'workspace' && kind.anchor.kind === 'none' && kind.transport === 'web' && kind.surface === 'chat'
}

/**
 * Answer every concern for one kind. Pure. Each field's rule is documented in
 * docs/plans/unified-sessions.md section 4.2.
 */
export function sessionPolicy(kind: SessionKind): SessionPolicy {
  const workspace = kind.audience === 'workspace'
  const room = isWebRoom(kind)
  const anchor = kind.anchor.kind
  const draft = anchor === 'feed_draft'
  const conversation = kind.lane === 'conversation'
  // Anchored web threads stored their anchor in channel_type before S3, so a
  // channel-type-keyed set never contained them.
  const plainChannel = anchor === 'none' || anchor === 'feed_draft' || anchor === 'job'

  const anchorGate: AnchorReadGate =
    draft ? 'feed_draft_audience'
      : anchor === 'feed_thread' ? 'feed_collaboration'
        : anchor === 'office_file' ? 'office_file'
          : 'none'

  return {
    read: workspace ? { rule: 'workspace', anchorGate } : { rule: 'owner' },
    post: room,
    admission: workspace ? 'room' : 'personal',
    addressing: workspace && (anchor === 'none' || anchor === 'channel') ? 'mention' : 'every_message',
    attribution: {
      stamp: room || draft || anchor === 'doc_thread' || anchor === 'feed_thread' || anchor === 'office_file',
      namesReachModel: room,
    },
    context: { personalMemory: !workspace },
    deliveryCeiling: {
      ceiling: workspace ? 'audience' : 'owner',
      recipientType: room ? 'group' : 'individual',
    },
    liveFollow: workspace,
    presence: room || anchor === 'office_file',
    confirmations: workspace ? 'addresser_or_admin' : 'owner',
    lifecycle: { adminRename: draft || room, adminDelete: room },
    humanActivity: {
      // memories.ts: channel_type NOT IN ('cron', 'assistant-call', 'notification')
      memory: kind.machine !== 'cron' && kind.machine !== 'a2a' && anchor !== 'inbox',
      // playbook-store.ts: channel_type NOT IN ('cron', 'office_thread')
      playbook: kind.machine !== 'cron' && anchor !== 'office_file',
      // live-work.ts: channel_type NOT IN ('workflow', 'assistant-call', 'office_thread')
      live: kind.machine !== 'workflow' && kind.machine !== 'a2a' && anchor !== 'office_file',
      // workspace-search: channel_type='web' AND NOT transient AND mode IS DISTINCT FROM 'draft'
      search: conversation && kind.transport === 'web' && plainChannel && !draft,
    },
    persistedRow: {
      tasks: kind.machine !== 'programmatic' && kind.machine !== 'workflow',
      crm: kind.machine !== 'programmatic',
    },
    billing: 'user',
    compaction: kind.transport === 'web' ? 'context_pressure' : 'idle_tiered',
    createAdmission: room,
    clearanceSource: anchor === 'office_file' ? 'anchor' : 'assistant',
    clearanceRecompute: workspace,
  }
}

/**
 * Is a read of this session bound to a feed anchor (draft audience or feed
 * collaboration)? Those reads are re-checked per streamed event because feed
 * access can change mid-stream.
 */
export function feedAnchoredRead(policy: SessionPolicy): boolean {
  return policy.read.rule === 'workspace'
    && (policy.read.anchorGate === 'feed_draft_audience' || policy.read.anchorGate === 'feed_collaboration')
}

/** Convenience: classify and answer in one call. */
export function policyFor(row: SessionKindRow): SessionPolicy {
  return sessionPolicy(classifySession(row))
}

// --- Transport policy ------------------------------------------------------

export type TransportPolicy = {
  /**
   * Eligible as a user's preferred proactive delivery channel, per consumer
   * (L15): `getPreferredChannel` / the workflow delivery-target list, and the
   * recent-approval notification resolver.
   */
  delivery: { preferredChannel: boolean; approvalNotify: boolean }
}

const PREFERRED_CHANNEL_TRANSPORTS: readonly Transport[] = ['telegram', 'slack', 'whatsapp', 'custom', 'feishu']
const APPROVAL_NOTIFY_TRANSPORTS: readonly Transport[] = ['telegram', 'slack', 'whatsapp', 'msteams', 'feishu']

/** Answer the transport-level concerns for one transport. Pure. */
export function transportPolicy(transport: Transport): TransportPolicy {
  return {
    delivery: {
      preferredChannel: PREFERRED_CHANNEL_TRANSPORTS.includes(transport),
      approvalNotify: APPROVAL_NOTIFY_TRANSPORTS.includes(transport),
    },
  }
}

// --- SQL -------------------------------------------------------------------

/**
 * SQL predicate fragments for the same kinds `classifySession` derives, for
 * queries that must filter in the database. Each takes the `sessions` table
 * alias. Kept here so the SQL and the TypeScript classifier change together.
 */
export const sessionKindSql = {
  /** The Chat app's workspace room (web, workspace audience, opened from chat). */
  webRoom: (alias: string): string =>
    `${alias}.visibility = 'workspace' AND ${alias}.channel_type = 'web' AND ${alias}.app_origin = 'chat'`,
}
