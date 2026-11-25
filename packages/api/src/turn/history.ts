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
import { getSessionMessages, type SessionMessage } from '../db/sessions.js'
import type { ConversationFrame } from '../db/conversation-store.js'
import { readAttendedSessionHistory, type PreparedAttendedSessionHistory } from '../routes/attended-session-context.js'
import { noteAutomaticScopeEvidence } from '../context-scope/resolve-turn-scope.js'
import {tryReadTurnConversationRecord} from '../context-scope/conversation-record-admission.js'
import {admitModelInput} from '../context-scope/admission.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {ContextScopeAccumulator as EvidenceAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {DerivedScopeError} from '@use-brian/agent-runtime/security/derived-scope.js'
import {conversationRecordSelectedRow} from '../db/conversation-record.js'
import type { PublicTurnConversationBinding } from '../db/public-conversation.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {readRetainedContextFrame} from '../db/session-context-revisions.js'
import {privateHistoryText} from '../db/session-legacy-history.js'
import {recentTextDigest,selectVerifiedChannelRecentText} from '../db/verified-channel-record.js'

/** The swappable readers underneath the owner port. */
export type TurnHistoryReaders = {
  /** Canonical native admitted transcript read. */
  native(authority: SessionContextAuthority, sessionId: string, fromSequence?: number | null, throughSequence?: number): Promise<PreparedAttendedSessionHistory>
  /** Stored transcript read for non-native lanes; held rows are always excluded. */
  stored(sessionId: string, options: { fromSequence?: number | null; publicConversation?: PublicTurnConversationBinding }): Promise<SessionMessage[]>
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

/** Positive dialogue excerpts from the exact verified pre-input window. The
 * selector witness is local to the original invocation. Each model/reply
 * boundary independently checks the same slice and its retained source roots. */
export async function readRecentChannelText(authority: SessionContextAuthority, beforeSequence: number, signal: AbortSignal) {
  const {execution} = authority
  const select = () => selectVerifiedChannelRecentText(execution, beforeSequence)
  signal.throwIfAborted()
  await execution.security.authority.assertCurrent()
  const candidates = await select()
  const witness = JSON.stringify(candidates)
  const isCurrent = async () => JSON.stringify(await select()) === witness
  const sources = candidates.map(candidate => candidate.source)
  const messages = !sources.length ? [] : await readRetainedContextFrame(authority, sources, async client => {
    const {rows} = await client.query<{id:string;role:'user'|'assistant';sequence:number;digest:string;content:unknown}>(`SELECT
      m.id,m.role,m.sequence_num AS sequence,${recentTextDigest} AS digest,m.content
      FROM session_messages m WHERE m.workspace_id=$1 AND m.session_id=$2 AND m.id=ANY($3::uuid[])
        AND m.scope_held IS NOT TRUE ORDER BY m.sequence_num`,
    [execution.security.access.workspaceId,execution.lifecycle.sessionId,sources.map(source=>source.resourceId)])
    if (rows.length !== candidates.length) throw new DerivedScopeError('scope_source_changed')
    return rows.flatMap((row,index) => {
      const candidate = candidates[index]
      if (row.id !== candidate.source.resourceId || row.sequence !== candidate.sequence || row.role !== candidate.role
        || row.digest !== candidate.digest) throw new DerivedScopeError('scope_source_changed')
      const text = privateHistoryText(row.content,row.role)
      if (!text) return []
      return [{role:row.role,text:text.length>1000?Array.from(text).slice(0,1000).join('')+'…':text}]
    })
  })
  if (!await isCurrent()) throw new DerivedScopeError('scope_source_changed')
  signal.throwIfAborted()
  return {messages,sources,isCurrent}
}
