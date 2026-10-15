/** Documented source fields only. [COMP:engineering-capture/collector] */
export type Provider='codex'|'claude-code'
export type SelectedEvent={provider:Provider;sessionId:string;role:'user'|'assistant';content:string;turnId?:string;sourceIdentity?:string;cwd:string;attributionQuality:'reported_unverified'}
export type Observation={event?:SelectedEvent;diagnostic?:'missing_final_output'|'interrupted'|'unsupported_event'|'unsupported_schema'|'source_identity_unavailable';sessionId?:string;wake?:boolean}
export function projectHook(provider:Provider,input:unknown):Observation{
 if(!input||typeof input!=='object'||Array.isArray(input))return {diagnostic:'unsupported_schema'}
 const x=input as Record<string,unknown>
 if(x.schema_version!==undefined&&x.schema_version!==1)return {diagnostic:'unsupported_schema'}
 if(typeof x.session_id!=='string'||!x.session_id||x.session_id.length>200||typeof x.cwd!=='string')return {diagnostic:'unsupported_schema'}
 const sessionId=x.session_id
 if(x.hook_event_name==='SessionStart')return {wake:true,sessionId}
 if(x.hook_event_name==='Interrupt'||x.hook_event_name==='StopFailure'||x.hook_event_name==='SessionEnd')return {diagnostic:'interrupted',sessionId}
 if(x.hook_event_name!=='UserPromptSubmit'&&x.hook_event_name!=='Stop')return {diagnostic:'unsupported_event',sessionId}
 const role=x.hook_event_name==='UserPromptSubmit'?'user':'assistant',content=role==='user'?x.prompt:x.last_assistant_message
 if(typeof content!=='string'||!content.trim())return {diagnostic:role==='assistant'?'missing_final_output':'unsupported_schema',sessionId}
 // Codex documents turn_id. Claude's documented envelopes supply no immutable
 // prompt/message identity, so replay cannot be inferred from text or logs.
 const turnId=provider==='codex'&&typeof x.turn_id==='string'&&x.turn_id.length<=200?x.turn_id:undefined
 const event:SelectedEvent={provider,sessionId,role,content,cwd:x.cwd,attributionQuality:'reported_unverified',
  ...(turnId?{turnId,sourceIdentity:`${turnId}:${role}`}:{})}
 return {event,sessionId,...(!turnId?{diagnostic:'source_identity_unavailable' as const}:{})}
}
