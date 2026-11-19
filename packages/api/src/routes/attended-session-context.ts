/** Protected attended history for transcript and title consumers. [COMP:api/application-persistence] */
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { DerivedScopeError } from '@use-brian/agent-runtime/security/derived-scope.js'
import { executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { bindScopeSources, boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { admitModelInput } from '../context-scope/admission.js'
import { getPool } from '../db/client.js'
import { readAdmittedSessionQuery, type ConversationFrame } from '../db/conversation-store.js'
import type { SessionMessage } from '../db/sessions.js'

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
