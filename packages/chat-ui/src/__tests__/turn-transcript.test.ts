import { describe, expect, it } from 'vitest'
import {
  DOCK_TURN_TRANSCRIPT,
  FULL_PAGE_TURN_TRANSCRIPT,
  buildTurnTranscriptMessage,
  initialTurnTranscript,
  reduceTurnTranscriptFrame,
  turnTranscriptReducer,
  armsAnswerReset,
  type TurnFrameAdapter,
  type TurnTranscriptProfile,
  type TurnTranscriptState,
} from '../turn-transcript.js'
import type { ActivityNote, ChatFileAttachment, CitationSource, DocumentAttachment, ToolUsed } from '../types.js'

/**
 * The oracles below transcribe the per-turn ref handling and the
 * `buildStreamedTurnMessage` bodies of `apps/app-web/.../chat-surface.tsx`
 * (full page) and `.../floating-chat.tsx` (dock) as they stand before M5.
 * The shared reducer must reproduce both outputs on the same recorded frames.
 */
type Frame = [event: string, payload: Record<string, unknown>]

const PAGE_WRITING_TOOLS = new Set(['delegateDocEdit', 'renderPage'])
const describeTool = (name: string, input: Record<string, unknown>) => ({
  description: typeof input.query === 'string' ? `Searching ${input.query}` : `Running ${name}`,
  ...(typeof input.url === 'string' ? { url: input.url } : {}),
  ...(typeof input.query === 'string' ? { detail: `query: ${input.query}` } : {}),
  ...(name === 'patchPage' && Object.keys(input).length > 0 ? { opLines: ['Writing heading', 'Writing table'] } : {}),
})
const pageIdsFromToolResult = (output: string, isError: boolean): string[] => {
  if (isError) return []
  try {
    const parsed = JSON.parse(output) as { pageIds?: unknown }
    return Array.isArray(parsed.pageIds) ? parsed.pageIds.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}
const parseDocument = (payload: Record<string, unknown>): DocumentAttachment | null =>
  typeof payload.id === 'string' && typeof payload.content === 'string'
    ? { id: payload.id, title: String(payload.title ?? ''), content: payload.content, format: 'markdown' }
    : null
const stripFollowUps = (text: string) => text
  .replace(/<followup>\s*\[[\s\S]*?\]\s*<\/followup>/g, '')
  .replace(/<followup[\s\S]*$/, '')
  .trimEnd()
function finalizeActivityNotes(notes: ActivityNote[], finalText: string) {
  if (!notes.length) return undefined
  const answer = finalText.trim()
  const kept = notes.filter((note) => !!note.beforeToolId && note.text.trim().length > 0 && note.text.trim() !== answer)
  return kept.length > 0 ? kept : undefined
}

class Clock { epoch = 1_700_000_000_000; perf = 500; tick(ms: number) { this.epoch += ms; this.perf += ms } }

/** Transcription of chat-surface.tsx's turn refs, handlers and builder. */
class FullPageOracle {
  turnText = ''; tools: ToolUsed[] = []; notes: ActivityNote[] = []; documents: DocumentAttachment[] = []
  pageLinks: string[] = []; research: { activityId: string; status: string } | null = null
  citations: CitationSource[] = []; files: ChatFileAttachment[] = []; workers = new Map<string, string>()
  starts = new Map<string, number>(); startedAt: number | null = null; reasoning = ''; pendingReset = false
  constructor(private clock: Clock) {}
  resetTurnActivity() {
    this.tools = []; this.notes = []; this.documents = []; this.pageLinks = []; this.research = null
    this.citations = []; this.files = []; this.workers = new Map(); this.starts.clear(); this.pendingReset = false
    this.reasoning = ''; this.startedAt = null
  }
  begin() { this.turnText = ''; this.resetTurnActivity(); this.startedAt = this.clock.epoch }
  frame([event, payload]: Frame) {
    switch (event) {
      case 'text_delta': {
        const delta = typeof payload.text === 'string' ? payload.text : ''
        if (delta) { if (this.pendingReset) { this.pendingReset = false; this.turnText = '' } this.turnText += delta }
        break
      }
      case 'reasoning': { const delta = typeof payload.text === 'string' ? payload.text : ''; if (delta) this.reasoning += delta; break }
      case 'worker_start': {
        const workerId = typeof payload.workerId === 'string' ? payload.workerId : ''
        const description = typeof payload.description === 'string' ? payload.description : undefined
        if (workerId && description) this.workers.set(workerId, description)
        break
      }
      case 'tool_start': {
        const id = typeof payload.id === 'string' ? payload.id : ''
        const name = typeof payload.name === 'string' ? payload.name : ''
        if (!id || !name) break
        if (this.tools.some((tool) => tool.id === id)) break
        if (!this.pendingReset) {
          this.pendingReset = true
          const segment = this.turnText.trim()
          if (segment) this.notes = [...this.notes, { id: `note-${id}`, text: segment, beforeToolId: id }]
        }
        this.starts.set(id, this.clock.perf)
        const seeded = describeTool(name, {})
        const workerId = typeof payload.workerId === 'string' ? payload.workerId : undefined
        const workerDescription = workerId ? this.workers.get(workerId) : undefined
        this.tools = [...this.tools, { id, name, status: 'running', description: seeded.description,
          ...(workerId ? { workerId } : {}), ...(workerDescription ? { workerDescription } : {}) }]
        break
      }
      case 'tool_dropped': {
        const id = typeof payload.id === 'string' ? payload.id : ''
        if (!id) break
        this.tools = this.tools.filter((tool) => tool.id !== id); this.starts.delete(id)
        break
      }
      case 'tool_input': {
        const id = typeof payload.id === 'string' ? payload.id : ''
        const name = typeof payload.name === 'string' ? payload.name : ''
        if (!id) break
        const input = payload.input && typeof payload.input === 'object' ? payload.input as Record<string, unknown> : {}
        const narration = describeTool(name, input)
        this.tools = this.tools.map((tool) => tool.id === id ? { ...tool, description: narration.description,
          ...(narration.url ? { url: narration.url } : {}), ...(narration.detail ? { detail: narration.detail } : {}),
          ...(Object.keys(input).length > 0 ? { input } : {}) } : tool)
        break
      }
      case 'tool_result': {
        const id = typeof payload.id === 'string' ? payload.id : ''
        if (!id) break
        const isError = payload.isError === true
        const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined
        const startedAtMs = this.starts.get(id)
        const output = typeof payload.output === 'string' && payload.output ? payload.output : undefined
        const durationMs = startedAtMs != null ? Math.max(0, Math.round(this.clock.perf - startedAtMs)) : undefined
        const finished = this.tools.find((tool) => tool.id === id)
        if (finished && PAGE_WRITING_TOOLS.has(finished.name) && output) {
          for (const pageId of pageIdsFromToolResult(output, isError)) if (!this.pageLinks.includes(pageId)) this.pageLinks.push(pageId)
        }
        this.tools = this.tools.map((tool) => tool.id === id ? { ...tool, status: isError ? 'retried' as const : 'done' as const,
          ...(durationMs != null ? { durationMs } : {}), ...(isError && errorMessage ? { errorMessage } : {}),
          ...(output ? { output } : {}) } : tool)
        break
      }
      case 'research_saved': {
        const activityId = typeof payload.activityId === 'string' ? payload.activityId : ''
        const status = payload.status
        if (activityId && (status === 'saved' || status === 'partial' || status === 'failed')) this.research = { activityId, status }
        break
      }
      case 'page_created': {
        const pageId = typeof payload.pageId === 'string' ? payload.pageId : ''
        if (pageId && !this.pageLinks.includes(pageId)) this.pageLinks = [...this.pageLinks, pageId]
        break
      }
      case 'document_payload': {
        const document = parseDocument(payload)
        if (document) this.documents = [...this.documents.filter((item) => item.id !== document.id), document]
        break
      }
      case 'citation': {
        if (!Array.isArray(payload.sources)) break
        for (const source of payload.sources as Array<{ url?: unknown; title?: unknown }>) {
          if (typeof source.url !== 'string' || typeof source.title !== 'string' || this.citations.some((item) => item.url === source.url)) continue
          this.citations = [...this.citations, { url: source.url, title: source.title }]
        }
        break
      }
      case 'attachments': if (Array.isArray(payload.attachments)) this.files = payload.attachments as ChatFileAttachment[]; break
    }
  }
  build(assistantId: string | null) {
    const finalText = this.turnText.trim()
    const tools = this.tools.map((tool) => tool.status === 'running' ? { ...tool, status: 'done' as const } : tool)
    if (!finalText && tools.length === 0 && this.documents.length === 0 && this.pageLinks.length === 0 && this.files.length === 0) return null
    const activityDurationMs = this.startedAt != null ? this.clock.epoch - this.startedAt : undefined
    const activityNotes = tools.length > 0 ? finalizeActivityNotes(this.notes, finalText) : undefined
    const activityReasoning = tools.length > 0 ? this.reasoning.trim() || undefined : undefined
    return {
      id: `assistant-${this.clock.epoch}`, role: 'assistant', text: finalText, timestamp: new Date(this.clock.epoch),
      ...(assistantId ? { senderAssistantId: assistantId } : {}),
      ...(tools.length > 0 ? { toolsUsed: tools } : {}), ...(activityNotes ? { activityNotes } : {}),
      ...(activityReasoning ? { activityReasoning } : {}), ...(this.documents.length > 0 ? { documents: this.documents } : {}),
      ...(this.pageLinks.length > 0 ? { pageLinks: this.pageLinks } : {}), ...(this.research ? { research: this.research } : {}),
      ...(activityDurationMs != null ? { activityDurationMs } : {}), ...(this.citations.length > 0 ? { citations: this.citations } : {}),
      ...(this.files.length > 0 ? { fileAttachments: this.files } : {}),
    }
  }
}

type DockView = { toolUseId: string; payload: unknown; entity?: string; viewType?: string; viewId?: string; action?: 'appended' | 'created' }
/** Transcription of floating-chat.tsx's turn buffers, handlers and builder. */
class DockOracle {
  views: DockView[] = []; turnText = ''; pendingReset = false; citations: CitationSource[] = []; files: ChatFileAttachment[] = []
  tools: Array<ToolUsed & { opLines?: string[] }> = []; notes: ActivityNote[] = []; workers = new Map<string, string>()
  reasoning = ''; starts = new Map<string, number>(); startedAt: number | null = null; assistantId: string | null = null
  constructor(private clock: Clock, private voice: string | null) {}
  resetTurnBuffers() {
    this.views = []; this.turnText = ''; this.pendingReset = false; this.citations = []; this.files = []; this.tools = []
    this.notes = []; this.workers = new Map(); this.reasoning = ''; this.starts = new Map(); this.startedAt = this.clock.epoch
    this.assistantId = null
  }
  frame([event, payload]: Frame) {
    switch (event) {
      case 'text_delta': {
        const delta = typeof payload.text === 'string' ? payload.text : ''
        if (delta) { if (this.pendingReset) { this.pendingReset = false; this.turnText = '' } this.turnText += delta }
        break
      }
      case 'reasoning': { const delta = typeof payload.text === 'string' ? payload.text : ''; if (delta) this.reasoning += delta; break }
      case 'worker_start': {
        const workerId = typeof payload.workerId === 'string' ? payload.workerId : ''
        const description = typeof payload.description === 'string' ? payload.description : undefined
        if (workerId && description) this.workers.set(workerId, description)
        break
      }
      case 'tool_start': {
        const id = typeof payload.id === 'string' ? payload.id : ''
        const name = typeof payload.name === 'string' ? payload.name : ''
        if (!id || !name) break
        if (this.tools.some((t) => t.id === id)) break
        if (!this.pendingReset) {
          this.pendingReset = true
          const segment = stripFollowUps(this.turnText).trim()
          if (segment) this.notes = [...this.notes, { id: `note-${id}`, text: segment, beforeToolId: id }]
        }
        this.starts.set(id, this.clock.perf)
        const workerId = typeof payload.workerId === 'string' ? payload.workerId : undefined
        const workerDescription = workerId ? this.workers.get(workerId) : undefined
        const seeded = describeTool(name, {})
        this.tools = [...this.tools, { id, name, status: 'running', description: seeded.description,
          ...(workerId ? { workerId } : {}), ...(workerDescription ? { workerDescription } : {}) }]
        break
      }
      case 'tool_dropped': {
        const id = typeof payload.id === 'string' ? payload.id : ''
        if (!id) break
        this.tools = this.tools.filter((tool) => tool.id !== id); this.starts.delete(id)
        break
      }
      case 'tool_input': {
        const id = typeof payload.id === 'string' ? payload.id : ''
        const name = typeof payload.name === 'string' ? payload.name : ''
        if (!id) break
        const input = payload.input && typeof payload.input === 'object' ? payload.input as Record<string, unknown> : {}
        const narration = describeTool(name, input)
        this.tools = this.tools.map((tool) => tool.id === id ? { ...tool, description: narration.description,
          ...(narration.url ? { url: narration.url } : {}), ...(narration.detail ? { detail: narration.detail } : {}),
          ...(Object.keys(input).length > 0 ? { input } : {}), ...(narration.opLines ? { opLines: narration.opLines } : {}) } : tool)
        break
      }
      case 'tool_result': {
        const id = typeof payload.id === 'string' ? payload.id : ''
        if (!id) break
        const isError = payload.isError === true
        const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined
        const startedAtMs = this.starts.get(id)
        const output = typeof payload.output === 'string' && payload.output ? payload.output : undefined
        const durationMs = startedAtMs != null ? Math.max(0, Math.round(this.clock.perf - startedAtMs)) : undefined
        this.tools = this.tools.map((tool) => tool.id === id ? { ...tool, status: isError ? 'retried' as const : 'done' as const,
          ...(durationMs != null ? { durationMs } : {}), ...(isError && errorMessage ? { errorMessage } : {}),
          ...(output ? { output } : {}) } : tool)
        break
      }
      case 'citation': {
        if (!Array.isArray(payload.sources)) break
        for (const s of payload.sources as Array<{ url?: unknown; title?: unknown }>) {
          if (typeof s.url !== 'string' || typeof s.title !== 'string') continue
          if (this.citations.some((c) => c.url === s.url)) continue
          this.citations = [...this.citations, { url: s.url, title: s.title }]
        }
        break
      }
      case 'view_payload': {
        const toolUseId = typeof payload.toolUseId === 'string' ? payload.toolUseId : ''
        const action = payload.action === 'appended' || payload.action === 'created' ? payload.action : undefined
        const incoming: DockView = { toolUseId, payload: undefined,
          entity: typeof payload.entity === 'string' ? payload.entity : undefined,
          viewType: typeof payload.viewType === 'string' ? payload.viewType : undefined,
          viewId: typeof payload.viewId === 'string' && payload.viewId.length > 0 ? payload.viewId : undefined, action }
        this.views = [...this.views.filter((v) => v.toolUseId !== incoming.toolUseId), incoming]
        break
      }
      case 'assistant_message_saved': { const id = typeof payload.id === 'string' ? payload.id : null; if (id) this.assistantId = id; break }
      case 'attachments': if (Array.isArray(payload.attachments)) this.files = payload.attachments as ChatFileAttachment[]; break
    }
  }
  build() {
    const finalText = stripFollowUps(this.turnText)
    const { views, tools, citations, files } = this
    if (finalText.length === 0 && views.length === 0 && tools.length === 0 && files.length === 0) return null
    const activityDurationMs = tools.length > 0 && this.startedAt != null ? Math.max(0, this.clock.epoch - this.startedAt) : undefined
    const activityNotes = tools.length > 0 ? finalizeActivityNotes(this.notes, finalText) : undefined
    const activityReasoning = tools.length > 0 ? this.reasoning.trim() || undefined : undefined
    return {
      id: this.assistantId ?? `assistant-${this.clock.epoch}`, role: 'assistant', text: finalText, timestamp: new Date(this.clock.epoch),
      ...(this.voice ? { senderAssistantId: this.voice } : {}), ...(views.length > 0 ? { views } : {}),
      ...(tools.length > 0 ? { toolsUsed: tools } : {}), ...(activityNotes ? { activityNotes } : {}),
      ...(activityReasoning ? { activityReasoning } : {}), ...(activityDurationMs != null ? { activityDurationMs } : {}),
      ...(citations.length > 0 ? { citations } : {}), ...(files.length > 0 ? { fileAttachments: files } : {}),
    }
  }
}

function adapterFor(profile: TurnTranscriptProfile, clock: Clock): TurnFrameAdapter {
  return {
    collect: profile.collect,
    now: () => clock.perf,
    describeTool,
    pageIdsFromToolResult: (toolName, output, isError) => PAGE_WRITING_TOOLS.has(toolName) ? pageIdsFromToolResult(output, isError) : [],
    parseDocument,
  }
}

/** Replay one recorded sequence through both the oracle and the reducer. */
function replay(host: 'page' | 'dock', frames: Array<Frame | number>, assistantId: string | null = 'assistant-1') {
  const clock = new Clock()
  const profile = host === 'page' ? FULL_PAGE_TURN_TRANSCRIPT : DOCK_TURN_TRANSCRIPT
  const adapter = adapterFor(profile, clock)
  const oracle = host === 'page' ? new FullPageOracle(clock) : new DockOracle(clock, assistantId)
  if (oracle instanceof FullPageOracle) oracle.begin(); else oracle.resetTurnBuffers()
  let state: TurnTranscriptState = turnTranscriptReducer(initialTurnTranscript, { type: 'reset', startedAt: clock.epoch })
  for (const step of frames) {
    if (typeof step === 'number') { clock.tick(step); continue }
    oracle.frame(step)
    state = reduceTurnTranscriptFrame(state, step[0], step[1], adapter, profile)
  }
  const expected = oracle instanceof FullPageOracle ? oracle.build(assistantId) : oracle.build()
  const actual = buildTurnTranscriptMessage(state, { ...profile, assistantId }, clock.epoch)
  return { expected, actual, state }
}

const MULTI_STEP: Array<Frame | number> = [
  ['reasoning', { text: 'Thinking about ' }],
  ['reasoning', { text: 'orders' }],
  ['text_delta', { text: '20' }],
  ['worker_start', { workerId: 'w1', description: 'Order researcher' }],
  ['tool_start', { id: 't1', name: 'shopifyListOrders', workerId: 'w1' }],
  30,
  ['tool_input', { id: 't1', name: 'shopifyListOrders', input: { query: 'name:#1042' } }],
  120,
  ['tool_result', { id: 't1', isError: false, output: '{"orders":1}' }],
  ['tool_start', { id: 't1', name: 'shopifyListOrders' }],
  ['text_delta', { text: 'Order #1042 shipped.' }],
  ['text_delta', { text: ' <followup>["Track it?"]</followup>' }],
  ['citation', { sources: [{ url: 'https://shop.example/1042', title: 'Order 1042' }, { url: 7 }] }],
  ['citation', { sources: [{ url: 'https://shop.example/1042', title: 'Duplicate' }] }],
  ['attachments', { attachments: [{ fileId: 'f1', workspaceId: 'w', path: '/a.pdf', name: 'a.pdf', mime: 'application/pdf', sizeBytes: 3 }] }],
  ['assistant_message_saved', { id: 'row-assistant-9' }],
  ['unknown_future_frame', { text: 'ignored' }],
  2500,
]

const ANSWER_THEN_BOOKKEEPING: Array<Frame | number> = [
  ['text_delta', { text: 'Saved your preference.' }],
  ['tool_start', { id: 'm1', name: 'saveMemory' }],
  40,
  ['tool_result', { id: 'm1', isError: true, errorMessage: 'quota' }],
  900,
]

const PAGE_FAMILIES: Array<Frame | number> = [
  ['text_delta', { text: 'Drafting the brief.' }],
  ['tool_start', { id: 'r1', name: 'renderPage' }],
  ['tool_input', { id: 'r1', name: 'renderPage', input: { url: 'https://docs.example/brief' } }],
  60,
  ['tool_result', { id: 'r1', isError: false, output: '{"pageIds":["page-a","page-b"]}' }],
  ['page_created', { pageId: 'page-b' }],
  ['page_created', { pageId: 'page-c' }],
  ['document_payload', { id: 'doc-1', title: 'Source', content: 'v1' }],
  ['document_payload', { id: 'doc-1', title: 'Source', content: 'v2' }],
  ['research_saved', { activityId: 'act-1', status: 'partial' }],
  ['research_saved', { activityId: 'act-2', status: 'unknown' }],
  ['tool_start', { id: 'r2', name: 'webSearch' }],
  ['view_payload', { toolUseId: 'v1', viewId: 'view-1', action: 'created' }],
  1200,
]

const DOCK_FAMILIES: Array<Frame | number> = [
  ['text_delta', { text: 'Building the page.' }],
  ['tool_start', { id: 'p1', name: 'patchPage' }],
  ['tool_input', { id: 'p1', name: 'patchPage', input: { ops: [1, 2] } }],
  ['tool_start', { id: 'q1', name: 'askQuestion' }],
  ['tool_dropped', { id: 'q1' }],
  ['view_payload', { toolUseId: 'v1', entity: 'tasks', viewType: 'table', viewId: 'view-1', action: 'appended' }],
  ['view_payload', { toolUseId: 'v1', viewId: 'view-2', action: 'created' }],
  ['view_payload', { toolUseId: 'v2', viewId: '' }],
  ['page_created', { pageId: 'page-x' }],
  ['document_payload', { id: 'doc-1', content: 'ignored by the dock' }],
  80,
  ['tool_result', { id: 'p1', isError: false, output: 'ok' }],
  ['text_delta', { text: 'Done.' }],
  ['text_delta', { text: '<followup>["Unterminated' }],
  700,
]

describe('[COMP:chat-ui/turn-transcript] reproduces both host builders on recorded frames', () => {
  for (const host of ['page', 'dock'] as const) {
    it.each([
      ['multi-step answer segmentation', MULTI_STEP],
      ['answer then bookkeeping tool', ANSWER_THEN_BOOKKEEPING],
      ['page frame families', PAGE_FAMILIES],
      ['dock frame families', DOCK_FAMILIES],
    ])(`${host}: %s`, (_name, frames) => {
      const { expected, actual } = replay(host, frames)
      expect(actual).toEqual(expected)
    })

    it(`${host}: an empty segment builds no bubble`, () => {
      const { expected, actual } = replay(host, [['reasoning', { text: 'only thinking' }], ['citation', { sources: [{ url: 'u', title: 't' }] }]])
      expect(expected).toBeNull()
      expect(actual).toBeNull()
    })

    it(`${host}: without an assistant voice no sender is stamped`, () => {
      const { expected, actual } = replay(host, [['text_delta', { text: 'Hi' }]], null)
      expect(actual).toEqual(expected)
      expect(actual).not.toHaveProperty('senderAssistantId')
    })
  }

  it('keeps the last text segment as the answer and the narration as a note', () => {
    const { actual } = replay('page', MULTI_STEP)
    expect(actual?.text).toBe('Order #1042 shipped. <followup>["Track it?"]</followup>')
    expect(actual?.activityNotes).toEqual([{ id: 'note-t1', text: '20', beforeToolId: 't1' }])
    const dock = replay('dock', MULTI_STEP).actual
    expect(dock?.text).toBe('Order #1042 shipped.')
    expect(dock?.id).toBe('row-assistant-9')
    expect(dock?.activityReasoning).toBe('Thinking about orders')
  })

  it('arms the live-buffer reset exactly once per segment', () => {
    const profile = FULL_PAGE_TURN_TRANSCRIPT
    let state = turnTranscriptReducer(initialTurnTranscript, { type: 'text', delta: 'narration' }, profile)
    const first = turnTranscriptReducer(state, { type: 'tool-start', id: 'a', name: 'x', at: 1 }, profile)
    expect(armsAnswerReset(state, first)).toBe(true)
    const second = turnTranscriptReducer(first, { type: 'tool-start', id: 'b', name: 'y', at: 2 }, profile)
    expect(armsAnswerReset(first, second)).toBe(false)
    state = turnTranscriptReducer(second, { type: 'text', delta: 'answer' }, profile)
    expect(state.text).toBe('answer')
    expect(state.notes).toHaveLength(1)
  })

  it('splits a mid-turn segment and restarts with each host reset rule', () => {
    const clock = new Clock()
    for (const [profile, startedAt] of [[FULL_PAGE_TURN_TRANSCRIPT, null], [DOCK_TURN_TRANSCRIPT, clock.epoch + 5]] as const) {
      let state = turnTranscriptReducer(initialTurnTranscript, { type: 'reset', startedAt: clock.epoch })
      state = turnTranscriptReducer(state, { type: 'text', delta: 'Before the queued input.' }, profile)
      const segment = buildTurnTranscriptMessage(state, { ...profile, assistantId: null }, clock.epoch + 5)
      expect(segment?.text).toBe('Before the queued input.')
      state = turnTranscriptReducer(state, { type: 'reset', startedAt })
      expect(state).toEqual({ ...initialTurnTranscript, startedAt })
    }
  })
})
