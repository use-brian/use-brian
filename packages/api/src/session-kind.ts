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
 * Provenance anchoring is not a session-kind concern either: the runner
 * stamps whether its session id is a real row (`sessionPersisted`), and
 * `provenanceSessionId` reads that (L14).
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
export type MachineLane = 'a2a' | 'workflow' | 'api' | 'inspection' | 'brain_edit' | 'cron' | 'programmatic' | 'internal'

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

/**
 * The row fields the classifier reads. `anchorKind` is the stored anchor
 * (migration 741) and is a REQUIRED key: a row source that does not select
 * `anchor_kind` would classify an anchored web thread (now stored as
 * `channel_type='web'`) as a plain chat, so the compiler makes every source
 * say what it has. Pass `null` only for an in-memory row that was never
 * stored; the legacy discriminators then decide.
 */
export type SessionKindRow = {
  visibility?: string | null
  mode?: string | null
  channelType: string
  anchorKind: string | null
  anchorRef?: string | null
  appOrigin?: string | null
  channelId?: string | null
  transient?: boolean | null
}

const ANCHOR_KINDS: readonly AnchorKind[] = ['none', 'doc_thread', 'office_file', 'feed_draft', 'feed_thread', 'channel', 'inbox', 'job']

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
  brain_edit: 'brain_edit',
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

/** Is the inbox (notifications) sentinel this channel id? Its target follows the latest surface. */
export function isInboxSentinel(channelId: string | null | undefined): boolean {
  return channelId === 'notifications'
}

/** Does this channel type ride the web transport (web, doc, an anchored web thread, the inbox)? */
export function isWebTransport(channelType: string): boolean {
  return transportOf(channelType) === 'web'
}

/** Is this a provider transport (a human on Telegram, Slack, ...)? */
export function isExternalTransport(transport: Transport): boolean {
  return (EXTERNAL_TRANSPORTS as readonly string[]).includes(transport)
}

// --- Classifier ------------------------------------------------------------

/**
 * Per-turn facts the row cannot carry. `providerGroup`: this turn arrived in
 * a provider group conversation (a Telegram group, a Slack channel). Until
 * group chats converge into workspace rooms (unified-sessions S4) their
 * sessions are per-sender rows, so the group-ness lives on the turn.
 */
export type SessionTurnFacts = { providerGroup?: boolean }

/**
 * Classify a session row. The ONLY reader of the discriminator columns.
 * A provider-group turn has a shared audience whatever its row says (L16):
 * one audience definition for web rooms and external groups alike.
 */
export function classifySession(row: SessionKindRow, turn: SessionTurnFacts = {}): SessionKind {
  const channelType = row.channelType
  const channelId = row.channelId ?? null
  const machine: MachineLane | null = MACHINE_CHANNEL_TYPES[channelType]
    ?? (row.transient === true ? 'inspection' : null)

  let anchor: Anchor = { kind: 'none', ref: null }
  if (row.anchorKind && (ANCHOR_KINDS as readonly string[]).includes(row.anchorKind)) {
    // The stored anchor (migration 741) is authoritative.
    anchor = { kind: row.anchorKind as AnchorKind, ref: row.anchorRef ?? null }
  } else if (channelType in WEB_ANCHOR_CHANNEL_TYPES) {
    anchor = { kind: WEB_ANCHOR_CHANNEL_TYPES[channelType]!, ref: channelId }
  } else if (channelId === 'notifications') {
    anchor = { kind: 'inbox', ref: null }
  } else if (row.mode === 'draft') {
    anchor = { kind: 'feed_draft', ref: channelId }
  } else if (machine === 'workflow' || machine === 'cron') {
    anchor = { kind: 'job', ref: channelId }
  }

  // A feed draft is a workspace conversation whatever its legacy visibility.
  const audience: Audience = row.visibility === 'workspace' || anchor.kind === 'feed_draft' || turn.providerGroup === true
    ? 'workspace'
    : 'personal'

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
  /**
   * Stamp each human message with its sender AND show the names (and the
   * participants block) to the model (L8). Every workspace session: several
   * people write there, and "the user" is not one person.
   */
  attribution: boolean
  /**
   * Several assistants may answer in this conversation, so foreign assistant
   * turns are labeled at assembly: every workspace session, and the doc
   * dock's per-turn-addressable personal thread.
   */
  multiVoice: boolean
  /** Memory sources a turn loads (D3, L16). */
  context: { personalMemory: boolean }
  /**
   * Delivery ceiling and recipient type, from the audience alone (L9): a
   * workspace session is delivered to its whole audience (a group), a
   * personal session to its owner.
   */
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
  /**
   * Rename / delete authority (L11). Personal: the owner. Workspace: any
   * participant who can read renames; a workspace admin deletes (the
   * starter's `user_id` grants nothing, D9), with the anchor's cascade.
   */
  lifecycle: { rename: 'owner' | 'participants'; delete: 'owner' | 'admin' }
  /**
   * Counts as human activity (L13): `lane='conversation'`. One answer for the
   * memory "active user" probe, the playbook miner, the Live roster and
   * workspace search (`sessionKindSql.conversationLane`).
   */
  humanActivity: boolean
  /**
   * May this conversation's content surface beyond its anchor (playbook,
   * Live roster)? Not an Office file's thread: its audience is the file's.
   */
  surfacesBeyondAnchor: boolean
  /**
   * Who pays for a turn (D2, L18). `workspace`: the workspace billing party,
   * with the addresser recorded as the actor; every workspace session, and
   * every provider transport (a channel bot is a workspace resource and its
   * senders may hold no plan of their own). `user`: a personal web session's
   * own human.
   */
  billing: 'user' | 'workspace'
  /** Compaction strategy. */
  compaction: 'context_pressure' | 'idle_tiered'
  /** Creation admission applies to a workspace insert (L12). */
  createAdmission: boolean
  /**
   * May a turn start from the web composer (`POST /api/chat`)? A converged
   * channel room lives in its provider group (§4.4): a web turn's reply would
   * never reach the group, so the Chat app shows it read-only.
   */
  webTurns: boolean
  /**
   * Is this turn on the Doc surface (the doc dock or a doc comment thread)?
   * Drives doc-skill injection and the doc-only turn behaviours, decoupled
   * from which assistant is talking.
   */
  docSurface: boolean
  /**
   * May a turn be addressed to an assistant other than the session's bound
   * one? `room`: a web room's multi-assistant addressing (T9); `doc`: the doc
   * dock's per-turn-addressable thread; `none`: assistant-bound.
   */
  crossAssistantSend: 'room' | 'doc' | 'none'
  /** Where `effective_clearance` comes from (D10, L10). */
  clearanceSource: 'assistant' | 'anchor'
  /**
   * Does an assistant clearance recompute overwrite this row (L10)? Only
   * assistant-sourced workspace rows (`sessionKindSql.assistantClearanceSourced`;
   * a guest doc thread is anchor-sourced too, which only the SQL can see
   * until the `clearance_source` column lands).
   */
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
    attribution: workspace,
    multiVoice: workspace || kind.surface === 'doc',
    context: { personalMemory: !workspace },
    deliveryCeiling: {
      ceiling: workspace ? 'audience' : 'owner',
      recipientType: workspace ? 'group' : 'individual',
    },
    liveFollow: workspace,
    presence: room || anchor === 'office_file',
    confirmations: workspace ? 'addresser_or_admin' : 'owner',
    lifecycle: workspace ? { rename: 'participants', delete: 'admin' } : { rename: 'owner', delete: 'owner' },
    humanActivity: conversation,
    surfacesBeyondAnchor: anchor !== 'office_file',
    billing: workspace || isExternalTransport(kind.transport) ? 'workspace' : 'user',
    compaction: kind.transport === 'web' ? 'context_pressure' : 'idle_tiered',
    createAdmission: room,
    webTurns: anchor !== 'channel',
    docSurface: kind.surface === 'doc' || anchor === 'doc_thread',
    crossAssistantSend: room ? 'room' : kind.surface === 'doc' || anchor === 'doc_thread' ? 'doc' : 'none',
    clearanceSource: anchor === 'office_file' ? 'anchor' : 'assistant',
    clearanceRecompute: workspace && anchor !== 'office_file',
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
export function policyFor(row: SessionKindRow, turn: SessionTurnFacts = {}): SessionPolicy {
  return sessionPolicy(classifySession(row, turn))
}

// --- Transport policy ------------------------------------------------------

export type TransportPolicy = {
  /**
   * Can Brian push to this transport without an inbound message to answer
   * (L15)? ONE answer for the user's preferred proactive channel, the
   * workflow delivery-target list and the recent-approval notification
   * resolver: exactly the transports the workflow delivery path
   * (`workflow/channel-delivery.ts`) can push to.
   */
  delivery: { proactive: boolean }
  /**
   * Does a group conversation on this transport converge into ONE workspace
   * room (unified-sessions §4.4, D15)? The room needs a channel integration
   * that bound the group to a workspace; an unbound group stays on the legacy
   * per-user path. `privacyLimited` marks a transport whose bots may only see
   * messages that mention them (Telegram privacy mode, §8), so the room's
   * disclosure says capture is mentions-only rather than implying more.
   */
  rooms: { converge: boolean; privacyLimited: boolean }
}

/** Transports whose group conversations converge into workspace rooms (§5 S4 order). */
export const ROOM_TRANSPORTS = [
  'slack', 'telegram', 'discord', 'feishu', 'msteams', 'whatsapp',
] as const satisfies readonly Transport[]

/** Transports with a proactive push in `workflow/channel-delivery.ts`. */
export const PROACTIVE_DELIVERY_TRANSPORTS = [
  'telegram', 'slack', 'whatsapp', 'feishu', 'msteams', 'custom',
] as const satisfies readonly Transport[]

/** Answer the transport-level concerns for one transport. Pure. */
export function transportPolicy(transport: Transport): TransportPolicy {
  return {
    delivery: { proactive: (PROACTIVE_DELIVERY_TRANSPORTS as readonly Transport[]).includes(transport) },
    rooms: {
      converge: (ROOM_TRANSPORTS as readonly Transport[]).includes(transport),
      privacyLimited: transport === 'telegram',
    },
  }
}

// --- SQL -------------------------------------------------------------------

/**
 * SQL predicate fragments for the same kinds `classifySession` derives, for
 * queries that must filter in the database. Each takes the `sessions` table
 * alias. Kept here so the SQL and the TypeScript classifier change together.
 */
const sqlList = (values: readonly string[]): string => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')

export const sessionKindSql = {
  /**
   * A human conversation (`lane='conversation'`): not one of the machine-lane
   * channel types and not transient. The ONE definition of human activity
   * (L13) for the memory activity probe, the playbook miner, the Live roster
   * and workspace search.
   */
  conversationLane: (alias: string): string =>
    `${alias}.channel_type NOT IN (${sqlList(Object.keys(MACHINE_CHANNEL_TYPES))}) AND ${alias}.transient IS NOT TRUE`,
  /**
   * A conversation whose content may surface beyond its anchor (the
   * assistant playbook, the Live roster). An Office file's thread is read by
   * the file's audience only, so it never leaves the file.
   */
  surfacesBeyondAnchor: (alias: string): string =>
    `${alias}.anchor_kind <> 'office_file'`,
  /**
   * A plain web conversation workspace search indexes: web transport, no
   * anchor (doc / Office / feed threads and drafts live in their anchors).
   */
  searchableConversation: (alias: string): string =>
    `${alias}.channel_type = 'web' AND ${alias}.anchor_kind = 'none'`,
  /**
   * Workspace rows whose `effective_clearance` is derived from the ASSISTANT,
   * so an assistant clearance change recomputes them (L10, D10). Excludes the
   * anchor-sourced rows (`clearance_source='anchor'`, D10): an Office file's
   * thread reads at the file's sensitivity, and a guest doc thread on a public
   * page reads at `public`.
   */
  assistantClearanceSourced: (alias: string): string =>
    `${alias}.visibility = 'workspace' AND ${alias}.clearance_source = 'assistant'`,
  /** A session on a transport with a proactive push (`transportPolicy(t).delivery.proactive`). */
  proactiveDeliveryTransport: (alias: string): string =>
    `${alias}.channel_type IN (${sqlList(PROACTIVE_DELIVERY_TRANSPORTS)})`,
  /** A workspace-audience row (rooms, drafts, anchored threads): `classifySession(row).audience`. */
  workspaceAudience: (alias: string): string =>
    `${alias}.visibility = 'workspace'`,
  /** Not the notification inbox (`anchor_kind='inbox'`, the `notifications` sentinel). */
  notInbox: (alias: string): string =>
    `${alias}.anchor_kind <> 'inbox'`,
  /** The Chat app's workspace room (web, workspace audience, opened from chat). */
  webRoom: (alias: string): string =>
    `${alias}.visibility = 'workspace' AND ${alias}.channel_type = 'web' AND ${alias}.anchor_kind = 'none' AND ${alias}.app_origin = 'chat'`,
  /** A personal, unanchored web conversation (the chat history a person owns). */
  personalConversation: (alias: string): string =>
    `${alias}.visibility = 'personal' AND ${alias}.channel_type = 'web' AND ${alias}.anchor_kind = 'none'`,
  /**
   * A personal conversation the owner's history lists: unanchored or the
   * inbox, never the settings-panel tuning thread (hydrated by its own
   * surface). The `draft-iter:` sentinel is retired: nothing writes it.
   */
  personalHistory: (alias: string): string =>
    `${alias}.visibility = 'personal' AND ${alias}.anchor_kind IN ('none', 'inbox')`
    + ` AND ${alias}.channel_id <> 'tuning'`,
  /**
   * The ON CONFLICT target of a personal session's identity: the partial
   * unique index `sessions_personal_identity_key` (D8). A workspace row has no
   * identity-tuple uniqueness, so it never matches and always inserts.
   */
  personalIdentityConflict: (): string =>
    `(assistant_id, user_id, channel_type, channel_id, app_id) WHERE visibility = 'personal'`,
  /** A converged provider group: a workspace room anchored to the channel (§4.4). */
  channelRoom: (alias: string): string =>
    `${alias}.visibility = 'workspace' AND ${alias}.anchor_kind = 'channel'`,
  /**
   * A room the Chat app's Workspace rail lists: the web room, or a converged
   * channel room on any transport (multiplayer-chat T10).
   */
  railRoom: (alias: string): string =>
    `${alias}.visibility = 'workspace' AND (${alias}.anchor_kind = 'channel' OR (${alias}.channel_type = 'web' AND ${alias}.anchor_kind = 'none' AND ${alias}.app_origin = 'chat'))`,
  /**
   * A legacy per-user session of a provider group, the shape a channel room
   * replaces (D16): personal, unanchored, still live.
   */
  legacyGroupRow: (alias: string): string =>
    `${alias}.visibility = 'personal' AND ${alias}.anchor_kind = 'none' AND ${alias}.archived_at IS NULL`,
  /**
   * The surface a personal history is scoped to (`kind.surface`, the
   * `app_origin` hint): exactly this surface, given as a bind parameter.
   */
  surfaceIs: (alias: string, param: string): string =>
    `${alias}.app_origin = ${param}`,
  /**
   * The surface-scoped personal history: rows of the requested surface plus
   * the unscoped rows that predate surfaces; a NULL parameter lists everything.
   */
  surfaceOrUnscoped: (alias: string, param: string): string =>
    `(${param}::text IS NULL OR ${alias}.app_origin = ${param} OR ${alias}.app_origin IS NULL)`,
  /** The ON CONFLICT target of a channel room: `sessions_channel_room_key` (D8). */
  channelRoomConflict: (): string =>
    `(workspace_id, channel_type, channel_id) WHERE visibility = 'workspace' AND anchor_kind = 'channel'`,
  /** A session with this anchor (migration 741). An empty alias leaves the column unqualified. */
  anchored: (alias: string, kind: AnchorKind): string =>
    `${alias ? `${alias}.` : ''}anchor_kind = '${kind}'`,
}
