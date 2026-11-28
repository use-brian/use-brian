/**
 * Turn history acquisition under the original turn owner (D9). The owner, not
 * the adapter, selects and calls the main-turn history reader and returns one
 * captured admitted history frame. The readers are a port so the bounded
 * joint-acquisition reader can replace them without changing any adapter.
 *
 * This is data ownership, never authorization: the reader's own admitted query
 * decides what is visible, and every later dispatch, publication and completion
 * check stays an independent fresh operation. No allow result is cached.
 *
 * Spec: docs/architecture/engine/turn-kernel.md "Turn history acquisition";
 * docs/architecture/context-engine/session-messages.md "Turn history
 * acquisition belongs to the turn owner". [COMP:api/turn-kernel]
 */
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import type { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { getSessionMessages, isExactTelegramHistoryQuote, type SessionMessage } from '../db/sessions.js'
import type { ConversationFrame } from '../db/conversation-store.js'
import { readAttendedSessionHistory, type PreparedAttendedSessionHistory } from '../routes/attended-session-context.js'
import { noteAutomaticScopeEvidence } from '../context-scope/resolve-turn-scope.js'
import {tryReadTurnConversationRecord} from '../context-scope/conversation-record-admission.js'
import {telegramKnowledgeGroup} from '../context-scope/telegram-knowledge-audience.js'
import {admitModelInput} from '../context-scope/admission.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {ContextScopeAccumulator as EvidenceAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {DerivedScopeError} from '@use-brian/agent-runtime/security/derived-scope.js'
import {conversationRecordSelectedRow} from '../db/conversation-record.js'
import type { PublicTurnConversationBinding } from '../db/public-conversation.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {readRetainedContextFrame} from '../db/session-context-revisions.js'
import {privateHistoryText} from '../db/session-legacy-history.js'
import {previousRecentTextBoundary,recentTextDigest,selectVerifiedChannelRecentText,selectVerifiedChannelRecentTextWindows,type TelegramTextWindow} from '../db/verified-channel-record.js'
import {assertScopeEvidenceFitsCeiling,scopeEvidenceFailureOf} from '../context-scope/caller-evidence.js'
import {isAudienceScopeRestriction} from '../context-scope/delivery-failure.js'

/** The swappable readers underneath the owner port. */
export type TurnHistoryReaders = {
  /** Canonical native admitted transcript read. */
  native(authority: SessionContextAuthority, sessionId: string, fromSequence?: number | null, throughSequence?: number): Promise<PreparedAttendedSessionHistory>
  /** Stored transcript read for non-native lanes; held rows are always excluded. */
  stored(sessionId: string, options: {
    fromSequence?: number | null
    publicConversation?: PublicTurnConversationBinding
    telegramTextWindow?: TelegramTextWindow & { firstSequence: number }
  }): Promise<SessionMessage[]>
}

const defaultReaders: TurnHistoryReaders = {
  // Exactly the arguments each adapter passed before the transfer.
  native: (authority, sessionId, fromSequence, throughSequence) => throughSequence === undefined
    ? readAttendedSessionHistory(authority, sessionId, fromSequence)
    : readAttendedSessionHistory(authority, sessionId, fromSequence, throughSequence),
  stored: (sessionId, options) => getSessionMessages(sessionId, { ...options, excludeHeld: true }),
}
let readers: TurnHistoryReaders = defaultReaders

/** Composition/test seam: replace the readers (`null` restores the defaults). */
export function configureTurnHistoryReaders(next: TurnHistoryReaders | null): void {
  readers = next ?? defaultReaders
}

export type TurnHistoryRequest = {
  /** The adapter's native transcript authority; `null` selects the stored reader. */
  native: SessionContextAuthority | null
  /** First retained sequence (compaction boundary); `null` reads the whole transcript. */
  fromSequence?: number | null
  /** Native only: the highest sequence to read. */
  throughSequence?: number
  /** Native only: the topic classifier's captured read continuation. */
  classified?: { readHistory(authority: SessionContextAuthority, fromSequence?: number | null): Promise<PreparedAttendedSessionHistory> }
  /** Stored only (channel): the adapter's declared audience projection. */
  projectStored?: (rows: SessionMessage[]) => Promise<SessionMessage[]>
  /** Stored public lane with its original credential and canonical generation. */
  publicConversation?: PublicTurnConversationBinding
  /** Note automatic scope evidence from the admitted rows on this accumulator. */
  evidence?: ContextScopeAccumulator
}

/** One captured admitted history frame. Data only; never a permission. */
export type CapturedTurnHistory = Readonly<{
  messages: SessionMessage[]
  frame?: ConversationFrame
  readCompleteRecord?: (authority: SessionContextAuthority) => Promise<SessionMessage[]>
  sourceForCurrentInput?: (message: SessionMessage) => ScopeSource | undefined
  readTurnCount?: PreparedAttendedSessionHistory['readTurnCount']
  source: 'native' | 'stored' | 'record'
}>

/** Captures the request synchronously, then reads through the current port. */
export function captureTurnHistory(sessionId: string, input: TurnHistoryRequest): () => Promise<CapturedTurnHistory> {
  const request = { ...input }
  const port = readers
  return async () => {
    if (request.native) {
      const authority=request.native
      const record=await tryReadTurnConversationRecord(authority.execution,request.fromSequence,request.throughSequence)
      if(record){
        request.evidence?.noteSource(record.source)
        const count=record.rows.filter(row=>row.role==='user').length
        const assertBound=(current:SessionContextAuthority)=>{
          if(current.execution!==authority.execution||current.accumulator!==authority.accumulator)
            throw new DerivedScopeError('scope_evidence_missing')
        }
        return Object.freeze({messages:record.rows,source:'record' as const,sourceForCurrentInput(message:SessionMessage){
          return message.sessionId===sessionId&&conversationRecordSelectedRow(record,message.id,message.sequenceNum,'user')
            ? record.source : undefined
        },async readCompleteRecord(current:SessionContextAuthority){
          assertBound(current)
          if((request.fromSequence??1)<=1)return record.rows
          const complete=await tryReadTurnConversationRecord(current.execution,null,request.throughSequence)
          if(!complete)throw new DerivedScopeError('scope_source_changed')
          return complete.rows
        },async readTurnCount(current:SessionContextAuthority){
          assertBound(current)
          const scopeAccumulator=new EvidenceAccumulator({sources:[record.source]})
          await admitModelInput({...executionToolContext(current.execution,{appId:'native-session-title-count'}),scopeAccumulator})
          return count
        }})
      }
      const prepared = request.classified
        ? await request.classified.readHistory(request.native, request.fromSequence)
        : await port.native(request.native, sessionId, request.fromSequence, request.throughSequence)
      if (request.evidence) noteAutomaticScopeEvidence(request.evidence, prepared.messages)
      return Object.freeze({ messages: prepared.messages, frame: prepared.frame, readTurnCount: prepared.readTurnCount, source: 'native' as const })
    }
    const stored = await port.stored(sessionId, {
      ...('fromSequence' in request ? { fromSequence: request.fromSequence } : {}),
      ...(request.publicConversation ? { publicConversation: request.publicConversation } : {}),
    })
    const messages = request.projectStored ? await request.projectStored(stored) : stored
    if (request.evidence) noteAutomaticScopeEvidence(request.evidence, messages)
    return Object.freeze({ messages, source: 'stored' as const })
  }
}

type StoredTelegramHistorySource = {
  kind: 'stored'
  sessionId: string
  assertCurrent(): Promise<void>
  project(rows: SessionMessage[]): Promise<SessionMessage[]>
  sources(rows: SessionMessage[]): ScopeSource[]
}

export type TelegramHistorySource =
  | { kind: 'native'; authority: SessionContextAuthority; verifyGroupContinuation: boolean }
  | StoredTelegramHistorySource
  | { kind: 'unavailable' }

export type RecentChannelTextWitness = Readonly<{ window: TelegramTextWindow; fingerprint: string }>
type TranscriptText = { role: 'user' | 'assistant'; text: string }
type TranscriptQuote = ({ status: 'available' } & TranscriptText) | { status: 'unavailable' }

const unavailableQuote = { status: 'unavailable' } as const

function clipRecent(text: string): string {
  if (text.length <= 1000) return text
  const characters = Array.from(text)
  return characters.length > 1000 ? characters.slice(0, 1000).join('') + '…' : text
}

async function readStoredTelegramText(source: StoredTelegramHistorySource, window: TelegramTextWindow) {
  const firstSequence = previousRecentTextBoundary(window.beforeSequence) ?? 1
  const rows = await readers.stored(source.sessionId, {
    telegramTextWindow: { ...window, firstSequence },
  })
  const visibleRows = await source.project(rows)
  const dialogue = visibleRows.flatMap<TranscriptText & { row: SessionMessage }>(row => {
    if (row.sessionId !== source.sessionId || row.sequenceNum >= window.beforeSequence
      || (!row.channelMessageId && !window.includeUnaddressedDialogue)
      || (row.sequenceNum < firstSequence && !isExactTelegramHistoryQuote(row))
      || (row.role !== 'user' && row.role !== 'assistant')) return []
    const text = privateHistoryText(row.content, row.role)
    return text ? [{ row, role: row.role, text }] : []
  })
  const matchedQuote = dialogue.find(({ row }) => isExactTelegramHistoryQuote(row))
  const quote = buildTranscriptQuote(window, matchedQuote)
  const messages = dialogue.filter(({ row }) => row.sequenceNum >= firstSequence)
    .map(({ role, text }) => ({ role, text: clipRecent(text) }))
  const roots = dialogue.map(({ row }) => row)
  const fingerprint = JSON.stringify(dialogue.map(({ row, role, text }) =>
    [row.id, row.channelMessageId, row.sequenceNum, role, text, row === matchedQuote?.row, boundScopeSources(row)]))
  return { messages, quote, sources: source.sources(roots), fingerprint }
}

function buildTranscriptQuote(window: TelegramTextWindow, entry?: TranscriptText): TranscriptQuote | undefined {
  if (!window.quoteId) return undefined
  return entry ? { status: 'available', role: entry.role, text: entry.text } : unavailableQuote
}

type NativeTelegramTextSelection = Awaited<ReturnType<typeof selectVerifiedChannelRecentText>>
function projectNativeTelegramText(authority: SessionContextAuthority, selection: NativeTelegramTextSelection): NativeTelegramTextSelection {
  const fitsOriginalCeiling = (candidate: NativeTelegramTextSelection['messages'][number]) => {
    try {
      assertScopeEvidenceFitsCeiling({ sources: [candidate.source] }, authority.execution.security.ceiling, 'caller')
      return true
    } catch (error) {
      if (isAudienceScopeRestriction(scopeEvidenceFailureOf(error))) return false
      throw error
    }
  }
  return {
    messages: selection.messages.filter(fitsOriginalCeiling),
    quote: selection.quote && fitsOriginalCeiling(selection.quote) ? selection.quote : null,
  }
}

/** Recheck only the selection. The surrounding lease and retained-source
 * owners perform the independent live and ancestry checks. */
export async function recentChannelTextSelectionsCurrent(source: TelegramHistorySource, witnesses: readonly RecentChannelTextWitness[], continued: boolean) {
  if (source.kind === 'unavailable') return false
  if (source.kind === 'stored') {
    const current = await Promise.all(witnesses.map(async witness => {
      const selection = await readStoredTelegramText(source, witness.window)
      return selection.fingerprint === witness.fingerprint
    }))
    return current.every(Boolean)
  }
  const verifyGroup = continued && source.verifyGroupContinuation
  const continuation = verifyGroup ? telegramKnowledgeGroup(source.authority.execution) : undefined
  if (verifyGroup && !continuation) return false
  const pages = await selectVerifiedChannelRecentTextWindows(source.authority.execution, witnesses.map(witness => witness.window), continuation)
  return pages !== null && witnesses.every((witness, index) =>
    JSON.stringify(projectNativeTelegramText(source.authority, pages[index]!)) === witness.fingerprint)
}

/** Positive dialogue excerpts from the exact verified pre-input window. The
 * selector witness is local to the original invocation. Each model/reply
 * boundary independently checks the same slice and its retained source roots. */
export async function readRecentChannelText(source: TelegramHistorySource, window: TelegramTextWindow, signal: AbortSignal, continued: boolean) {
  signal.throwIfAborted()
  if (source.kind === 'unavailable') return { available: false as const, quote: buildTranscriptQuote(window) }
  const nextBeforeSequence = previousRecentTextBoundary(window.beforeSequence)
  if (source.kind === 'stored') {
    await source.assertCurrent()
    const { messages, quote, sources, fingerprint } = await readStoredTelegramText(source, window)
    await source.assertCurrent()
    signal.throwIfAborted()
    return { available: true as const, messages, quote, sources, witness: { window, fingerprint }, nextBeforeSequence }
  }
  const { authority } = source
  const { execution } = authority
  const verifyGroup = continued && source.verifyGroupContinuation
  const continuation = verifyGroup ? telegramKnowledgeGroup(execution) : undefined
  if (verifyGroup && !continuation) throw new DerivedScopeError('scope_source_changed')
  const select = async () => projectNativeTelegramText(authority, await selectVerifiedChannelRecentText(execution, window, continuation))
  await execution.security.authority.assertCurrent()
  const selection = await select()
  const candidatesById = new Map(selection.messages.map(candidate => [candidate.source.resourceId, candidate]))
  if (selection.quote) candidatesById.set(selection.quote.source.resourceId, selection.quote)
  const witness: RecentChannelTextWitness = { window, fingerprint: JSON.stringify(selection) }
  const sources = [...candidatesById.values()].map(candidate => candidate.source)
  const entries = !sources.length ? new Map<string, TranscriptText>() : await readRetainedContextFrame(authority, sources, async client => {
    const { rows } = await client.query<{ id: string; role: TranscriptText['role']; sequence: number; digest: string; content: unknown }>(`SELECT
      m.id,m.role,m.sequence_num AS sequence,${recentTextDigest} AS digest,m.content
      FROM session_messages m WHERE m.workspace_id=$1 AND m.session_id=$2 AND m.id=ANY($3::uuid[])
        AND m.scope_held IS NOT TRUE ORDER BY m.sequence_num`,
    [execution.security.access.workspaceId, execution.lifecycle.sessionId, sources.map(source => source.resourceId)])
    if (rows.length !== candidatesById.size) throw new DerivedScopeError('scope_source_changed')
    const textById = new Map<string, TranscriptText>()
    for (const row of rows) {
      const candidate = candidatesById.get(row.id)
      if (!candidate || row.sequence !== candidate.sequence || row.role !== candidate.role || row.digest !== candidate.digest) {
        throw new DerivedScopeError('scope_source_changed')
      }
      const text = privateHistoryText(row.content, row.role)
      if (text) textById.set(row.id, { role: row.role, text })
    }
    return textById
  })
  if (JSON.stringify(await select()) !== witness.fingerprint) throw new DerivedScopeError('scope_source_changed')
  signal.throwIfAborted()
  const messages = selection.messages.flatMap(candidate => {
    const entry = entries.get(candidate.source.resourceId)
    return entry ? [{ role: entry.role, text: clipRecent(entry.text) }] : []
  })
  const quoted = selection.quote ? entries.get(selection.quote.source.resourceId) : undefined
  return { available: true as const, messages, quote: buildTranscriptQuote(window, quoted), sources, witness, nextBeforeSequence }
}
