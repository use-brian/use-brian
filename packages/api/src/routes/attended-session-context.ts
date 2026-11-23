/** Protected attended history for transcript and title consumers. [COMP:api/application-persistence] */
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { DerivedScopeError } from '@use-brian/agent-runtime/security/derived-scope.js'
import { executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { bindScopeSources, boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { admitModelInput } from '../context-scope/admission.js'
import { getPool } from '../db/client.js'
import { readAdmittedSessionQuery, type ConversationFrame } from '../db/conversation-store.js'
import { readSessionMessageScopeSource, type SessionMessage } from '../db/sessions.js'
import { selectVerifiedChannelHistory } from '../db/verified-channel-record.js'
import { conversationRecordSelectedRow } from '../db/conversation-record.js'
import { tryReadTurnConversationRecord } from '../context-scope/conversation-record-admission.js'

/** Admit the current append receipt and its original request bytes. Older
 * rows, topic annotations and stored attachment bodies belong to discovery. */
export async function admitCurrentAuthoredInput(
  authority: SessionContextAuthority, sessionId: string, row: SessionMessage,
) {
  const { execution, accumulator } = authority
  if (execution.lifecycle.sessionId !== sessionId || row.sessionId !== sessionId ||
      row.role !== 'user' || !Number.isSafeInteger(row.sequenceNum) || row.sequenceNum < 1) {
    throw new DerivedScopeError('scope_evidence_missing')
  }
  await execution.security.authority.assertCurrent()
  const record = await tryReadTurnConversationRecord(execution, row.sequenceNum, row.sequenceNum, 0)
  if (record) {
    if (!conversationRecordSelectedRow(record, row.id, row.sequenceNum, 'user')) {
      throw new DerivedScopeError('scope_source_changed')
    }
    accumulator.noteSource(record.source)
    return record.source
  }
  const selected = await selectVerifiedChannelHistory(execution, [row.id])
  if (selected && !selected.has(row.id)) throw new DerivedScopeError('scope_source_changed')
  const source = await readSessionMessageScopeSource(execution.security.access.workspaceId, row.id, undefined,
    { sessionId, sequenceNum: row.sequenceNum })
  if (!source) throw new DerivedScopeError('scope_source_changed')
  accumulator.noteSource(source)
  return source
}

/** Explicit preparation data; count consumption still performs fresh admission. */
export type PreparedAttendedSessionHistory={
 messages:SessionMessage[]
 frame:ConversationFrame
 readTurnCount:(authority:SessionContextAuthority)=>Promise<number>
}
export function prepareAdmittedSessionHistory(authority:SessionContextAuthority,sessionId:string,frame:ConversationFrame,fromSequence?:number|null):PreparedAttendedSessionHistory{
 const rows=frame.assemble(authority),sources=boundScopeSources(frame)
 const workspaceId=authority.execution.security.access.workspaceId
 const originalSources=structuredClone(sources)
 const count=rows.filter(row=>row.role==='user'&&!(Array.isArray(row.content)&&row.content.some(block=>
  typeof block==='object'&&block!==null&&'type' in block&&block.type==='tool_result'))).length
 return Object.freeze({
  frame,
  messages:bindScopeSources(rows.filter(row=>fromSequence==null||row.sequenceNum>=fromSequence),sources),
  async readTurnCount(current:SessionContextAuthority){
   const {execution}=current
   if(workspaceId!==execution.security.access.workspaceId||sessionId!==execution.lifecycle.sessionId)throw new DerivedScopeError('scope_evidence_missing')
   const accumulator=new ContextScopeAccumulator(execution.security.provenance)
   accumulator.note({sources:[...originalSources]})
   await admitModelInput({...executionToolContext(execution,{appId:'native-session-title-count'}),scopeAccumulator:accumulator})
   return count
  },
 })
}

/** Capture before filtering/formatting, retaining complete query obligations even for an empty window. */
export async function readAttendedSessionHistory(authority:SessionContextAuthority,sessionId:string,fromSequence?:number|null,throughSequence?:number,currentInput?:{id:string;sequence:number},topicThroughSequence?:number):Promise<PreparedAttendedSessionHistory> {
 const high=throughSequence??(await getPool().query<{sequence:number}>(
  'SELECT coalesce(max(sequence_num),0)::int AS sequence FROM session_messages WHERE (workspace_id=$1 OR workspace_id IS NULL) AND session_id=$2',
  [authority.execution.security.access.workspaceId,sessionId])).rows[0].sequence
 const query=await readAdmittedSessionQuery({sessionId,throughSequence:high,topicThroughSequence,authority,
  ...(currentInput?{currentMessageId:currentInput.id,currentMessageSequence:currentInput.sequence}:{})})
 return prepareAdmittedSessionHistory(authority,sessionId,query,fromSequence)
}
