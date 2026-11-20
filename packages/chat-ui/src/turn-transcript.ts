/**
 * Framework-neutral per-turn accumulation for chat hosts.
 *
 * One pure reducer replaces the full page's and the dock's turn-ref sets and
 * their two `buildStreamedTurnMessage` copies. It owns the answer-reset
 * segmentation (a tool start arms a LAZY reset; the next text delta discards
 * the narration segment, kept as a receipt note), tools, notes, reasoning,
 * citations, documents, page links, outbound file attachments and views.
 *
 * Host differences that exist today are explicit options, not forks; the two
 * presets reproduce the current builders exactly. Localized narration and
 * page-link parsing stay with the host through `TurnFrameAdapter`.
 *
 * See docs/architecture/engine/live-streaming.md → "Shared client run
 * controller". [COMP:chat-ui/turn-transcript]
 */
import type {
  ActivityNote,
  ChatFileAttachment,
  CitationSource,
  DocumentAttachment,
  Message,
  ToolUsed,
} from './types.js'

export type TurnView = {
  toolUseId: string
  payload: unknown
  entity?: string
  viewType?: string
  viewId?: string
  /** Whether the call appended to an existing draft or created a new one. */
  action?: 'appended' | 'created'
}

export type TurnResearch = {
  activityId: string
  status: 'saved' | 'partial' | 'failed'
}

export type TurnTool = ToolUsed & {
  /** Per-op narration lines (`patchPage`), kept only when the host collects them. */
  opLines?: string[]
}

export type TurnTranscriptState = {
  /** The finalized-answer buffer (the hosts' `turnTextRef`). */
  text: string
  /** Armed by a tool start; the next text delta discards the prior segment. */
  pendingAnswerReset: boolean
  tools: TurnTool[]
  notes: ActivityNote[]
  reasoning: string
  citations: CitationSource[]
  documents: DocumentAttachment[]
  pageLinks: string[]
  fileAttachments: ChatFileAttachment[]
  views: TurnView[]
  research: TurnResearch | null
  workerDescriptions: Readonly<Record<string, string>>
  /** Host clock readings at `tool_start`, for per-step durations. */
  toolStartedAt: Readonly<Record<string, number>>
  /** Turn t0 (epoch ms) for the "Worked for" receipt; null when unknown. */
  startedAt: number | null
  /** Server row id from `assistant_message_saved`. */
  savedMessageId: string | null
}

export const initialTurnTranscript: TurnTranscriptState = {
  text: '',
  pendingAnswerReset: false,
  tools: [],
  notes: [],
  reasoning: '',
  citations: [],
  documents: [],
  pageLinks: [],
  fileAttachments: [],
  views: [],
  research: null,
  workerDescriptions: {},
  toolStartedAt: {},
  startedAt: null,
  savedMessageId: null,
}

export type TurnTranscriptAction =
  /** Clear every buffer. `startedAt` is the new segment's t0 (or null). */
  | { type: 'reset'; startedAt: number | null }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'worker'; workerId: string; description: string }
  | { type: 'tool-start'; id: string; name: string; description?: string; workerId?: string; at: number }
  | {
      type: 'tool-input'
      id: string
      description: string
      url?: string
      detail?: string
      input?: Record<string, unknown>
      opLines?: string[]
    }
  | { type: 'tool-dropped'; id: string }
  | {
      type: 'tool-result'
      id: string
      isError: boolean
      errorMessage?: string
      output?: string
      at: number
      /** Page ids the result wrote (page-writing tools only). */
      pageIds?: string[]
    }
  | { type: 'citations'; sources: CitationSource[] }
  | { type: 'document'; document: DocumentAttachment }
  | { type: 'page-links'; pageIds: string[] }
  | { type: 'file-attachments'; attachments: ChatFileAttachment[] }
  | { type: 'view'; view: TurnView }
  | { type: 'research'; research: TurnResearch }
  | { type: 'saved'; messageId: string }

/** Frame families a host collects into the turn. */
export type TurnTranscriptCollect = {
  documents: boolean
  pageLinks: boolean
  research: boolean
  views: boolean
  opLines: boolean
}

export type TurnTranscriptProfile = {
  /** Dock: strip `<followup>` blocks (trim end only) instead of trimming. */
  stripFollowUps: boolean
  /** Page: close a step the server never resolved as `done`. */
  settleRunningTools: boolean
  /** Dock: report "Worked for" only when the segment ran tools, clamped at 0. */
  durationRequiresTools: boolean
  /** Dock: use the `assistant_message_saved` id as the message id. */
  preferSavedMessageId: boolean
  collect: TurnTranscriptCollect
}

export type TurnTranscriptOptions = TurnTranscriptProfile & {
  /** The assistant answering the turn, stamped as `senderAssistantId`. */
  assistantId: string | null
}

/** Today's `/chat` builder (`chat-surface.tsx`). */
export const FULL_PAGE_TURN_TRANSCRIPT: TurnTranscriptProfile = {
  stripFollowUps: false,
  settleRunningTools: true,
  durationRequiresTools: false,
  preferSavedMessageId: false,
  collect: { documents: true, pageLinks: true, research: true, views: false, opLines: false },
}

/** Today's dock builder (`floating-chat.tsx`). */
export const DOCK_TURN_TRANSCRIPT: TurnTranscriptProfile = {
  stripFollowUps: true,
  settleRunningTools: false,
  durationRequiresTools: true,
  preferSavedMessageId: true,
  collect: { documents: false, pageLinks: false, research: false, views: true, opLines: true },
}

/** Drop `<followup>[...]</followup>` blocks and a trailing unterminated one. */
export function stripFollowUpBlocks(text: string): string {
  return text
    .replace(/<followup>\s*\[[\s\S]*?\]\s*<\/followup>/g, '')
    .replace(/<followup[\s\S]*$/, '')
    .trimEnd()
}

/** Receipt notes that precede a tool and are not the answer itself. */
export function finalizeTurnActivityNotes(
  notes: ReadonlyArray<ActivityNote> | undefined,
  finalText: string,
): ActivityNote[] | undefined {
  if (!notes?.length) return undefined
  const answer = finalText.trim()
  const kept = notes.filter(
    (note) => !!note.beforeToolId && note.text.trim().length > 0 && note.text.trim() !== answer,
  )
  return kept.length > 0 ? kept : undefined
}

function answerText(text: string, stripFollowUps: boolean): string {
  return stripFollowUps ? stripFollowUpBlocks(text) : text.trim()
}

function addUnique(current: readonly string[], ids: readonly string[]): string[] {
  const out = [...current]
  for (const id of ids) if (id && !out.includes(id)) out.push(id)
  return out
}

/**
 * Whether `action` armed a new answer segment. The host clears its live
 * stream buffer (`stream/reset`) exactly then.
 */
export function armsAnswerReset(before: TurnTranscriptState, after: TurnTranscriptState): boolean {
  return !before.pendingAnswerReset && after.pendingAnswerReset
}

export function turnTranscriptReducer(
  state: TurnTranscriptState,
  action: TurnTranscriptAction,
  options: Pick<TurnTranscriptProfile, 'stripFollowUps'> = { stripFollowUps: false },
): TurnTranscriptState {
  switch (action.type) {
    case 'reset':
      return { ...initialTurnTranscript, startedAt: action.startedAt }
    case 'text': {
      if (!action.delta) return state
      const base = state.pendingAnswerReset ? '' : state.text
      return { ...state, pendingAnswerReset: false, text: base + action.delta }
    }
    case 'reasoning':
      return action.delta ? { ...state, reasoning: state.reasoning + action.delta } : state
    case 'worker':
      if (!action.workerId || !action.description) return state
      return {
        ...state,
        workerDescriptions: { ...state.workerDescriptions, [action.workerId]: action.description },
      }
    case 'tool-start': {
      if (!action.id || !action.name) return state
      // Re-emits keep the existing row.
      if (state.tools.some((tool) => tool.id === action.id)) return state
      let next = state
      if (!state.pendingAnswerReset) {
        const segment = answerText(state.text, options.stripFollowUps).trim()
        next = {
          ...state,
          pendingAnswerReset: true,
          notes: segment
            ? [...state.notes, { id: `note-${action.id}`, text: segment, beforeToolId: action.id }]
            : state.notes,
        }
      }
      const workerDescription = action.workerId ? next.workerDescriptions[action.workerId] : undefined
      const tool: TurnTool = {
        id: action.id,
        name: action.name,
        status: 'running',
        description: action.description,
        ...(action.workerId ? { workerId: action.workerId } : {}),
        ...(workerDescription ? { workerDescription } : {}),
      }
      return {
        ...next,
        tools: [...next.tools, tool],
        toolStartedAt: { ...next.toolStartedAt, [action.id]: action.at },
      }
    }
    case 'tool-input': {
      if (!action.id || !state.tools.some((tool) => tool.id === action.id)) return state
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.id === action.id
            ? {
                ...tool,
                description: action.description,
                ...(action.url ? { url: action.url } : {}),
                ...(action.detail ? { detail: action.detail } : {}),
                ...(action.input && Object.keys(action.input).length > 0 ? { input: action.input } : {}),
                ...(action.opLines ? { opLines: action.opLines } : {}),
              }
            : tool,
        ),
      }
    }
    case 'tool-dropped': {
      if (!action.id) return state
      const { [action.id]: _dropped, ...toolStartedAt } = state.toolStartedAt
      return { ...state, tools: state.tools.filter((tool) => tool.id !== action.id), toolStartedAt }
    }
    case 'tool-result': {
      if (!action.id) return state
      const startedAt = state.toolStartedAt[action.id]
      const durationMs = startedAt != null ? Math.max(0, Math.round(action.at - startedAt)) : undefined
      return {
        ...state,
        pageLinks: action.pageIds?.length ? addUnique(state.pageLinks, action.pageIds) : state.pageLinks,
        tools: state.tools.map((tool) =>
          tool.id === action.id
            ? {
                ...tool,
                status: action.isError ? 'retried' : 'done',
                ...(durationMs != null ? { durationMs } : {}),
                ...(action.isError && action.errorMessage ? { errorMessage: action.errorMessage } : {}),
                ...(action.output ? { output: action.output } : {}),
              }
            : tool,
        ),
      }
    }
    case 'citations': {
      let citations = state.citations
      for (const source of action.sources) {
        if (citations.some((item) => item.url === source.url)) continue
        citations = [...citations, { url: source.url, title: source.title }]
      }
      return citations === state.citations ? state : { ...state, citations }
    }
    case 'document':
      return {
        ...state,
        documents: [...state.documents.filter((item) => item.id !== action.document.id), action.document],
      }
    case 'page-links':
      return action.pageIds.length ? { ...state, pageLinks: addUnique(state.pageLinks, action.pageIds) } : state
    case 'file-attachments':
      return { ...state, fileAttachments: action.attachments }
    case 'view':
      return {
        ...state,
        views: [...state.views.filter((view) => view.toolUseId !== action.view.toolUseId), action.view],
      }
    case 'research':
      return { ...state, research: action.research }
    case 'saved':
      return action.messageId ? { ...state, savedMessageId: action.messageId } : state
  }
}

export type TurnTranscriptMessage = Message & {
  senderAssistantId?: string
  pageLinks?: string[]
  research?: TurnResearch
  views?: TurnView[]
  toolsUsed?: TurnTool[]
}

/**
 * Freeze what the turn has streamed so far into a message, or null when the
 * segment carried nothing worth a bubble. `now` is the host's epoch clock.
 */
export function buildTurnTranscriptMessage(
  state: TurnTranscriptState,
  options: TurnTranscriptOptions,
  now: number,
): TurnTranscriptMessage | null {
  const finalText = answerText(state.text, options.stripFollowUps)
  const tools = options.settleRunningTools
    ? state.tools.map((tool) => (tool.status === 'running' ? { ...tool, status: 'done' as const } : tool))
    : state.tools
  if (
    !finalText &&
    tools.length === 0 &&
    state.documents.length === 0 &&
    state.pageLinks.length === 0 &&
    state.fileAttachments.length === 0 &&
    state.views.length === 0
  ) {
    return null
  }
  const activityDurationMs = options.durationRequiresTools
    ? tools.length > 0 && state.startedAt != null ? Math.max(0, now - state.startedAt) : undefined
    : state.startedAt != null ? now - state.startedAt : undefined
  const activityNotes = tools.length > 0 ? finalizeTurnActivityNotes(state.notes, finalText) : undefined
  const activityReasoning = tools.length > 0 ? state.reasoning.trim() || undefined : undefined
  return {
    id: (options.preferSavedMessageId ? state.savedMessageId : null) ?? `assistant-${now}`,
    role: 'assistant',
    text: finalText,
    timestamp: new Date(now),
    ...(options.assistantId ? { senderAssistantId: options.assistantId } : {}),
    ...(state.views.length > 0 ? { views: state.views } : {}),
    ...(tools.length > 0 ? { toolsUsed: tools } : {}),
    ...(activityNotes ? { activityNotes } : {}),
    ...(activityReasoning ? { activityReasoning } : {}),
    ...(state.documents.length > 0 ? { documents: state.documents } : {}),
    ...(state.pageLinks.length > 0 ? { pageLinks: state.pageLinks } : {}),
    ...(state.research ? { research: state.research } : {}),
    ...(activityDurationMs != null ? { activityDurationMs } : {}),
    ...(state.citations.length > 0 ? { citations: state.citations } : {}),
    ...(state.fileAttachments.length > 0 ? { fileAttachments: state.fileAttachments } : {}),
  }
}

export type ToolNarration = {
  description: string
  url?: string
  detail?: string
  opLines?: string[]
}

/** Host hooks for frame interpretation; localized copy stays with the host. */
export type TurnFrameAdapter = {
  collect: TurnTranscriptCollect
  /** Monotonic clock for step durations (the hosts use `performance.now`). */
  now: () => number
  describeTool?: (name: string, input: Record<string, unknown>) => ToolNarration | null | undefined
  /** Page ids written by a page-writing tool's successful result. */
  pageIdsFromToolResult?: (toolName: string, output: string, isError: boolean) => string[]
  parseDocument?: (payload: Record<string, unknown>) => DocumentAttachment | null
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/**
 * Map one stream frame to the turn actions it implies, given the current
 * state (needed for tool names on results). Frames that do not touch the
 * turn's accumulation return []. Validation of the outer frame shape is the
 * host boundary's job; this keeps the hosts' field-level tolerance.
 */
export function turnTranscriptActionsFromFrame(
  state: TurnTranscriptState,
  event: string,
  payload: Record<string, unknown>,
  adapter: TurnFrameAdapter,
): TurnTranscriptAction[] {
  switch (event) {
    case 'text_delta': {
      const delta = str(payload.text) ?? ''
      return delta ? [{ type: 'text', delta }] : []
    }
    case 'reasoning': {
      const delta = str(payload.text) ?? ''
      return delta ? [{ type: 'reasoning', delta }] : []
    }
    case 'worker_start': {
      const workerId = str(payload.workerId) ?? ''
      const description = str(payload.description)
      return workerId && description ? [{ type: 'worker', workerId, description }] : []
    }
    case 'tool_start': {
      const id = str(payload.id) ?? ''
      const name = str(payload.name) ?? ''
      if (!id || !name) return []
      const seeded = adapter.describeTool?.(name, {})
      const workerId = str(payload.workerId)
      return [{
        type: 'tool-start', id, name, at: adapter.now(),
        ...(seeded?.description !== undefined ? { description: seeded.description } : {}),
        ...(workerId ? { workerId } : {}),
      }]
    }
    case 'tool_dropped': {
      const id = str(payload.id) ?? ''
      return id ? [{ type: 'tool-dropped', id }] : []
    }
    case 'tool_input': {
      const id = str(payload.id) ?? ''
      const name = str(payload.name) ?? ''
      if (!id) return []
      const input = record(payload.input)
      const narration = adapter.describeTool?.(name, input)
      if (!narration) return []
      return [{
        type: 'tool-input', id, description: narration.description,
        ...(narration.url ? { url: narration.url } : {}),
        ...(narration.detail ? { detail: narration.detail } : {}),
        ...(Object.keys(input).length > 0 ? { input } : {}),
        ...(adapter.collect.opLines && narration.opLines ? { opLines: narration.opLines } : {}),
      }]
    }
    case 'tool_result': {
      const id = str(payload.id) ?? ''
      if (!id) return []
      const isError = payload.isError === true
      const errorMessage = str(payload.errorMessage)
      const output = typeof payload.output === 'string' && payload.output ? payload.output : undefined
      const tool = state.tools.find((item) => item.id === id)
      const pageIds = adapter.collect.pageLinks && tool && output && adapter.pageIdsFromToolResult
        ? adapter.pageIdsFromToolResult(tool.name, output, isError)
        : undefined
      return [{
        type: 'tool-result', id, isError, at: adapter.now(),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        ...(output ? { output } : {}),
        ...(pageIds?.length ? { pageIds } : {}),
      }]
    }
    case 'citation': {
      if (!Array.isArray(payload.sources)) return []
      const sources = (payload.sources as unknown[]).flatMap((source) => {
        const row = record(source)
        return typeof row.url === 'string' && typeof row.title === 'string' ? [{ url: row.url, title: row.title }] : []
      })
      return [{ type: 'citations', sources }]
    }
    case 'attachments':
      return Array.isArray(payload.attachments)
        ? [{ type: 'file-attachments', attachments: payload.attachments as ChatFileAttachment[] }]
        : []
    case 'document_payload': {
      if (!adapter.collect.documents) return []
      const document = adapter.parseDocument?.(payload) ?? null
      return document ? [{ type: 'document', document }] : []
    }
    case 'page_created': {
      if (!adapter.collect.pageLinks) return []
      const pageId = str(payload.pageId) ?? ''
      return pageId ? [{ type: 'page-links', pageIds: [pageId] }] : []
    }
    case 'research_saved': {
      if (!adapter.collect.research) return []
      const activityId = str(payload.activityId) ?? ''
      const status = payload.status
      return activityId && (status === 'saved' || status === 'partial' || status === 'failed')
        ? [{ type: 'research', research: { activityId, status } }]
        : []
    }
    case 'view_payload': {
      if (!adapter.collect.views) return []
      const action = payload.action === 'appended' || payload.action === 'created' ? payload.action : undefined
      const viewId = typeof payload.viewId === 'string' && payload.viewId.length > 0 ? payload.viewId : undefined
      return [{
        type: 'view',
        view: {
          toolUseId: str(payload.toolUseId) ?? '',
          payload: undefined,
          entity: str(payload.entity),
          viewType: str(payload.viewType),
          viewId,
          action,
        },
      }]
    }
    case 'assistant_message_saved': {
      const messageId = str(payload.id)
      return messageId ? [{ type: 'saved', messageId }] : []
    }
    default:
      return []
  }
}

/** Apply every action a frame implies. */
export function reduceTurnTranscriptFrame(
  state: TurnTranscriptState,
  event: string,
  payload: Record<string, unknown>,
  adapter: TurnFrameAdapter,
  profile: Pick<TurnTranscriptProfile, 'stripFollowUps'>,
): TurnTranscriptState {
  let next = state
  for (const action of turnTranscriptActionsFromFrame(next, event, payload, adapter)) {
    next = turnTranscriptReducer(next, action, profile)
  }
  return next
}
