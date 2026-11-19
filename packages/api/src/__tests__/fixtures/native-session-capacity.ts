/** [COMP:api/native-chat-read-cost] Capture capacity and atomic rollback at the canonical SQL boundary. */
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import { expect } from 'vitest'
import { query } from '../../db/client.js'
import { captureConversationQuery,conversationCaptureSources } from '../../db/conversation-store.js'
import { withSessionMessagePublication } from '../../db/session-context-revisions.js'

/** Execute the installed reader as app_user, then prove every staged observation
 * rolled back. No historical reader clone or synthetic allow proof is installed. */
export async function assertRetainedNativeQueryCapacity(authority: SessionContextAuthority,
 expectedStatementTimeout: '15s' | '1min' = '15s') {
 const workspace=authority.execution.security.access.workspaceId,session=authority.execution.lifecycle.sessionId!
 const tables=['application_query_domains','application_field_resources','application_field_observations',
  'application_field_observation_sources','session_messages','session_context_scope_revisions',
  'session_context_revision_contents','scope_derivations','scope_derivation_sources','native_turn_frames']
 async function snapshot(){
  const state:Record<string,unknown>={}
  for(const table of tables)state[table]=(await query(`SELECT count(*)::int count,
   md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) digest
   FROM ${table} t WHERE workspace_id=$1`,[workspace])).rows[0]
  return state
 }
 const before=await snapshot()
 const through=(await query<{through:number}>('SELECT max(sequence_num)::int through FROM session_messages WHERE session_id=$1',[session])).rows[0].through
 const result=await withSessionMessagePublication(authority,[],async client=>{
  expect((await client.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
   .toEqual({current_user:'app_user',rolsuper:false,rolbypassrls:false})
  expect((await client.query("SELECT current_setting('statement_timeout') value")).rows[0].value).toBe(expectedStatementTimeout)
  await client.query('SAVEPOINT capacity_oracle')
  try{
   const captured=await captureConversationQuery(client,workspace,{sessionId:session,throughSequence:through,topicThroughSequence:through})
   expect(captured.history.slice(1).map(row=>row.row!.sequenceNum)).toEqual(Array.from({length:through},(_,i)=>i+1))
   expect(captured.annotations.length).toBeGreaterThan(8)
   const sourceCount=conversationCaptureSources(captured,workspace).length
   expect(sourceCount).toBeGreaterThan(255)
   return{historyRows:captured.history.length-1,annotationRows:captured.annotations.length-1,sourceCount}
  }finally{await client.query('ROLLBACK TO SAVEPOINT capacity_oracle')}
 })
 expect(await snapshot()).toEqual(before)
 return result
}

/** Count the installed canonical graph from genuine admitted sources. This is
 * metadata only; the caller separately proves admission through app_user.
 * The retired native_turn_edges reader must not survive as a test oracle.
 * Include every physical query-domain candidate through the canonical edge owner. */
export async function countConversationExpandedGraph(authority:SessionContextAuthority):Promise<{nodes:number;edges:number}>{
 const sources=authority.accumulator.evidence.sources??[]
 expect(sources.length).toBeGreaterThan(0)
 const roots=sources.map(source=>({tag:'source',kind:source.resourceKind,id:source.resourceId,version:source.version}))
 const row=(await query<{nodes:number;edges:number}>(`WITH RECURSIVE nodes(n) AS(
  SELECT value FROM jsonb_array_elements($2::jsonb)
  UNION
  SELECT child FROM nodes CROSS JOIN LATERAL conversation_dag_edges($1::uuid,n) child
 ), expanded AS MATERIALIZED(SELECT count(*)::integer nodes FROM nodes),
 edges AS(SELECT DISTINCT n parent,child FROM nodes
  CROSS JOIN LATERAL conversation_dag_edges($1::uuid,n) child)
 SELECT expanded.nodes,(SELECT count(*)::integer FROM edges) edges FROM expanded`,
 [authority.execution.security.access.workspaceId,JSON.stringify(roots)])).rows[0]
 expect(row.nodes).toBeGreaterThan(0);expect(row.edges).toBeGreaterThan(0)
 return row
}
