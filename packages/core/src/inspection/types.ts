/**
 * Inspection store interface — backs the read-only introspection
 * toolkit exposed to the workspace's primary assistant during a
 * Brain inbox "Ask about this" deliberation.
 *
 * Pure orchestration in `tools.ts` consumes this; the DB-backed
 * adapter lives in `packages/api/src/db/inspection-store.ts`.
 *
 * Every method is read-only and assistant-self-scoped — the route
 * layer passes the inspection-session assistant id, and the store
 * implementation guards reads to that assistant + its workspace.
 *
 * Spec: docs/architecture/brain/corrections.md.
 */

export type InspectionMessage = {
  id: string
  role: string
  content: unknown
  createdAt: Date
}

export type ActivityEvent = {
  id: string
  eventName: string
  occurredAt: Date
  /** Compact one-line summary the model can read directly. */
  summary: string
}

export type RecallEvent = {
  id: string
  recalledAt: Date
  sessionId: string
  recallKind: 'index_inject' | 'tool_call' | 'consolidation' | string
  /** Did downstream user feedback rate the response positively / negatively / mark it as a correction? */
  outcome: 'positive' | 'negative' | 'correction' | null
}

export type MistakeEvent = {
  id: string
  action: 'retract' | 'adjust_scope' | 'adjust_sensitivity' | 'edit_summary' | 'delete' | string
  primitive: 'memory' | 'entity' | 'entity_link' | 'task' | 'contact' | 'company' | 'deal' | 'workspace_file' | string
  rowId: string
  reason: string | null
  at: Date
}

export type ProvenanceWalk = {
  /** The source episode id, if any. */
  sourceEpisodeId: string | null
  /** A short description of where the row came from (source kind, occurred_at). */
  origin: string | null
  /** Supersession chain — newest first. Each entry is one prior version. */
  history: Array<{ id: string; validFrom: Date; validTo: Date | null; reason?: string | null }>
}

export interface InspectionStore {
  /**
   * Pull the session-message window around when a memory was saved.
   * Returns up to ~6 messages centred on the save time. Limited to
   * memories where the saving assistant matches the inspection
   * session's assistant id, OR where the memory belongs to the same
   * workspace (so a user reviewing their own workspace's memories
   * via the primary assistant can see anyone's saves).
   */
  getMemoryProvenance(params: {
    assistantId: string
    workspaceId: string
    memoryId: string
  }): Promise<{
    savedAt: Date
    sourceSessionId: string | null
    savingAssistantName: string | null
    messages: InspectionMessage[]
  } | null>

  /**
   * Recall events for a brain row, with outcome derived from
   * `analytics_events` feedback rows joined on `assistant_message_id`.
   */
  getRecallHistory(params: {
    workspaceId: string
    rowId: string
    primitive?: string
    limit?: number
  }): Promise<RecallEvent[]>

  /**
   * Universal provenance walker — wraps the existing `provenance()`
   * read for brain rows. Returns the source episode (if any) + a
   * shallow supersession chain.
   */
  getRowProvenance(params: {
    workspaceId: string
    primitive: string
    rowId: string
  }): Promise<ProvenanceWalk | null>

  /**
   * Recent activity — turns, tool calls, errors. Default scope is the
   * calling assistant's own activity; pass `workspaceWide: true` to
   * see every assistant in the workspace (primary assistants asking
   * "what's been happening across the workspace?"). Capped at `limit`
   * (default 20) so the model can read the result without a
   * compaction round.
   */
  getRecentActivity(params: {
    assistantId: string
    workspaceId: string
    sinceMinutes?: number
    limit?: number
    workspaceWide?: boolean
  }): Promise<ActivityEvent[]>

  /**
   * Recent user corrections + retractions. Default scope is rows the
   * calling assistant authored; pass `workspaceWide: true` for every
   * assistant in the workspace. Reads `correction_audit` joined with
   * the primitive tables for the row's short summary.
   */
  getRecentMistakes(params: {
    assistantId: string
    workspaceId: string
    sinceDays?: number
    limit?: number
    workspaceWide?: boolean
  }): Promise<MistakeEvent[]>
}
