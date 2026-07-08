/**
 * NOTIFY emitter for brain change events.
 *
 * Called from brain write surfaces (chat brain-write `tool_result` sites,
 * MCP `bridgeCoreTool`) right after the row has been committed. Fire-and-
 * forget: failures are logged and swallowed because the write itself
 * already succeeded — a missed NOTIFY just means the open brain page
 * doesn't redraw until the next event or refocus.
 *
 * Spec: docs/architecture/platform/realtime-sync.md.
 *
 * [COMP:api/brain-stream-fanout]
 */
import { query } from '../db/client.js'
import {
  BRAIN_CHANNEL,
  dispatchBrainChangeLocal,
  isSingleProcessBrainStream,
  type BrainChangeAction,
  type BrainChangePayload,
  type BrainPrimitive,
} from './sse-fanout.js'

/**
 * Per-(workspaceId, primitive) burst coalescer. The first emit for a key
 * passes through immediately (leading edge — the common single-write case
 * pays zero latency); further emits inside the window collapse into ONE
 * trailing emit carrying the LAST payload. Payloads are refetch signals, not
 * data, so collapsing loses nothing — the refetch reads current truth. This
 * is the burst guard that lets bounded-but-chatty writers (a 20-step
 * workflow run, an approvals batch) share the channel safely.
 */
const COALESCE_WINDOW_MS = 2_000

type CoalesceSlot = {
  timer: NodeJS.Timeout
  /** Set when at least one emit arrived during the window. */
  pending: BrainChangePayload | null
}

const coalesceSlots = new Map<string, CoalesceSlot>()

function emitCoalesced(payload: BrainChangePayload): void {
  const key = `${payload.workspaceId}:${payload.primitive}`
  const slot = coalesceSlots.get(key)
  if (slot) {
    slot.pending = payload
    return
  }
  const timer = setTimeout(() => {
    const s = coalesceSlots.get(key)
    coalesceSlots.delete(key)
    if (s?.pending) void sendNotify(s.pending)
  }, COALESCE_WINDOW_MS)
  // Don't hold the process open for a trailing window.
  timer.unref?.()
  coalesceSlots.set(key, { timer, pending: null })
  void sendNotify(payload)
}

/** Test helper — flush and clear all coalescer slots. */
export function _resetCoalescerForTests(): void {
  for (const slot of coalesceSlots.values()) clearTimeout(slot.timer)
  coalesceSlots.clear()
}

async function sendNotify(payload: BrainChangePayload): Promise<void> {
  // Single-process (OSS local boot): the PGLite socket server does not propagate
  // LISTEN/NOTIFY, so dispatch straight into the same-process subscribers. The
  // writer and the SSE subscribers share one api process locally.
  if (isSingleProcessBrainStream()) {
    dispatchBrainChangeLocal(payload)
    return
  }
  try {
    await query('SELECT pg_notify($1, $2)', [BRAIN_CHANNEL, JSON.stringify(payload)])
  } catch (err) {
    console.warn('[brain-stream] notify failed (non-fatal):', err)
  }
}

export async function notifyBrainChange(payload: BrainChangePayload): Promise<void> {
  if (!payload.workspaceId) return
  emitCoalesced(payload)
}

/**
 * Store-seam emitter for the workspace-scoped primitives (workflow,
 * workflow_run, approval, skill, scheduled_job — see the WorkspacePrimitive
 * union). Same fire-and-forget semantics as the brain-write emitters: never
 * awaited by callers, failures swallowed, bursts coalesced. Kept as a named
 * export so store code reads as intent ("workspace change") rather than
 * brain-specific plumbing.
 */
export function notifyWorkspaceChange(
  workspaceId: string | null | undefined,
  primitive: BrainChangePayload['primitive'],
  action: BrainChangeAction,
  rowId?: string,
): void {
  if (!workspaceId) return
  void notifyBrainChange({ workspaceId, primitive, action, rowId })
}

/**
 * Single source of truth for "this tool changes a brain row → emit this
 * signal". The set deliberately covers every chat-side brain-write tool. The
 * MCP bridge is a subset — `createEntity` / `updateSelfProfile` aren't exposed
 * via MCP — but the file tools, including the byte-preserving saves
 * (`saveFileToBrain` by reference, `saveFileBytes` by value), are bridged and
 * reuse these same signals (see programmatic-access.md). Any tool absent from
 * the map is a no-op when looked up.
 *
 * Spec: docs/architecture/platform/realtime-sync.md.
 */
export const BRAIN_WRITE_TOOL_SIGNALS: Record<string, { primitive: BrainPrimitive; action: BrainChangeAction }> = {
  // Memory
  saveMemory: { primitive: 'memory', action: 'update' },
  deleteMemory: { primitive: 'memory', action: 'delete' },
  // Tasks
  saveTask: { primitive: 'task', action: 'update' },
  updateTask: { primitive: 'task', action: 'update' },
  closeTask: { primitive: 'task', action: 'update' },
  reopenTask: { primitive: 'task', action: 'update' },
  // CRM
  saveContact: { primitive: 'contact', action: 'update' },
  updateContact: { primitive: 'contact', action: 'update' },
  saveCompany: { primitive: 'company', action: 'update' },
  updateCompany: { primitive: 'company', action: 'update' },
  saveDeal: { primitive: 'deal', action: 'update' },
  updateDeal: { primitive: 'deal', action: 'update' },
  advanceDealStage: { primitive: 'deal', action: 'update' },
  // Entities + self profile (chat-only — not bridged via MCP v1)
  updateSelfProfile: { primitive: 'entity', action: 'update' },
  createEntity: { primitive: 'entity', action: 'create' },
  // Workflow-run brain-write tools (core/src/workflows/tools.ts) — resolved
  // from the per-run registry; they fire on the callee lane, which emits via
  // this same map (realtime-sync-audit §9.8).
  createEdge: { primitive: 'edge', action: 'create' },
  supersedeMemory: { primitive: 'memory', action: 'update' },
  // Files — all the writes bridge to MCP. saveFileToBrain promotes a cached
  // upload by id; saveFileBytes persists base64 bytes the caller supplies.
  fileWrite: { primitive: 'file', action: 'update' },
  fileAppend: { primitive: 'file', action: 'update' },
  fileSetMeta: { primitive: 'file', action: 'update' },
  fileDelete: { primitive: 'file', action: 'delete' },
  saveFileToBrain: { primitive: 'file', action: 'create' },
  saveFileBytes: { primitive: 'file', action: 'create' },
}

/**
 * Fire-and-forget NOTIFY for a tool result. No-ops on lookup miss (the tool
 * isn't a brain write), on `isError`, or on a missing `workspaceId`. The
 * caller never awaits the result — a NOTIFY hiccup must not break a
 * successful write.
 */
export function notifyBrainWriteIfMatch(
  workspaceId: string | null | undefined,
  toolName: string,
  isError: boolean,
  rowId?: string,
): void {
  if (isError || !workspaceId) return
  const signal = BRAIN_WRITE_TOOL_SIGNALS[toolName]
  if (!signal) return
  void notifyBrainChange({
    workspaceId,
    primitive: signal.primitive,
    action: signal.action,
    rowId,
  })
}

/**
 * The brain-inbox primitive vocabulary (`db/brain-inbox-store.ts`) is wider
 * than the realtime `BrainPrimitive` set: it carries `entity_link` (the edge
 * table) and `workspace_file` (the file table) under their store-side names.
 * This maps those two onto the stream's `edge` / `file` primitives; every
 * other value is identical in both vocabularies and passes through unchanged.
 */
type BrainInboxPrimitive =
  | 'memory'
  | 'entity'
  | 'entity_link'
  | 'task'
  | 'contact'
  | 'company'
  | 'deal'
  | 'workspace_file'

const INBOX_PRIMITIVE_TO_STREAM: Record<BrainInboxPrimitive, BrainPrimitive> = {
  memory: 'memory',
  entity: 'entity',
  entity_link: 'edge',
  task: 'task',
  contact: 'contact',
  company: 'company',
  deal: 'deal',
  workspace_file: 'file',
}

/**
 * Fire-and-forget NOTIFY for a web REST brain write (the brain inbox /
 * detail-drawer surfaces in `routes/brain-inbox.ts` + `routes/memories.ts`).
 * These routes write directly through the stores instead of the chat tool
 * loop, so they bypass `notifyBrainWriteIfMatch` — without this, cross-tab /
 * cross-device `/brain` pages never repaint on a web edit. Translates the
 * brain-inbox primitive name to the stream primitive and forwards to
 * `notifyBrainChange`. Same fire-and-forget/void semantics: the caller never
 * awaits and failures are swallowed because the write already committed.
 */
export function notifyBrainInboxChange(
  workspaceId: string | null | undefined,
  inboxPrimitive: BrainInboxPrimitive,
  rowId: string | undefined,
  action: BrainChangeAction,
): void {
  if (!workspaceId) return
  void notifyBrainChange({
    workspaceId,
    primitive: INBOX_PRIMITIVE_TO_STREAM[inboxPrimitive],
    action,
    rowId,
  })
}
