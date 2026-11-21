/** [COMP:api/native-chat-read-cost] Compiled metadata adjacency agrees with the original canonical readers. */
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {publishNativeSessionMessageBatch} from '../../db/conversation-store.js'
import {updateSessionMessageText} from '../../db/sessions.js'
import {createWorkspaceFile,supersedeWorkspaceFile} from '../../db/workspace-files.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Node={tag:'source';kind:string;id:string;version:string}|{tag:'point';kind:string;id:string;fields:string[]}
type PrivacyNode={kind:string;id:string}
type Edge={parent:Node|PrivacyNode;child:Node|PrivacyNode;edge_kind?:string}
let f:Awaited<ReturnType<typeof persistentContextFixture>>
let currentNodes:Node[]
let annotationResource:string,oldRevision:string,newRevision:string,missingHead:string,editedReply:string,currentReplyVersion:string
let files:string[]
let domainField:{id:string;resourceId:string}
const source=(kind:string,id:string,version:string):Node=>({tag:'source',kind,id,version})
const point=(kind:string,id:string,fields:string[]):Node=>({tag:'point',kind,id,fields})
const sorted=(edges:Edge[])=>edges.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
async function authority(){return{execution:await f.execution(),accumulator:new ContextScopeAccumulator()}}
async function query(through=3,topics=3){
 const current=await authority()
 const value=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:through,topicThroughSequence:topics,authority:current})
 return{current,sources:boundScopeSources(value)}
}
async function equalEdges(nodes:(Node|PrivacyNode)[],privacy=false):Promise<Edge[]>{
 const unique=[...new Map(nodes.map(node=>[JSON.stringify(node),node])).values()]
 const sql=privacy?'SELECT to_jsonb(e) edge FROM native_turn_privacy_edges($1,$2::jsonb) e'
  :`SELECT jsonb_build_object('parent',n,'child',e) edge FROM jsonb_array_elements($2::jsonb) n CROSS JOIN LATERAL conversation_dag_edges($1,n) e`
 return sorted((await f.pool.query<{edge:Edge}>(sql,[f.workspaceId,JSON.stringify(unique)])).rows.map(row=>row.edge))
}

describe.sequential('[COMP:api/native-chat-read-cost] canonical conversation adjacency',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture()
  const messages=await f.history();missingHead=messages[0].id
  async function annotate(label:string,expectedRevision?:string){
   const before=await query(3,0)
   return writeSessionContextRevision({sessionId:f.session.id,parentId:messages[2].id,kind:'message_annotation',expectedRevision,
    content:{topicLabel:label,topicConfidence:1,replyToText:null},authority:before.current,
    derivation:{producer:'fixture:compiled-edge-annotation',sources:before.sources}})
  }
  const first=await annotate('Fictional earlier topic');expect(first).not.toBeNull();oldRevision=first!.id
  await query()
  const second=await annotate('Fictional revised topic',oldRevision);expect(second).not.toBeNull();newRevision=second!.id
  const retained=await query()
  const [reply]=await publishNativeSessionMessageBatch({sessionId:f.session.id,
   messages:[{role:'assistant',senderAssistantId:f.assistantId,content:[{type:'text',text:'Fictional original edge reply.'}]}],
   authority:retained.current,derivationTarget:f.envelope,derivation:{producer:'fixture:compiled-edge-reply',sources:retained.sources}})
  editedReply=reply.id
  expect(await updateSessionMessageText({messageId:reply.id,sessionId:f.session.id,text:'Fictional edited edge reply.'})).not.toBeNull()
  currentReplyVersion=(await f.pool.query('SELECT scope_version::text version FROM session_messages WHERE id=$1',[reply.id])).rows[0].version
  expect(currentReplyVersion).not.toBe('1')
  const field=(await f.pool.query(`SELECT r.id FROM application_field_resources r WHERE r.workspace_id=$1
   AND r.type_key='session_message_annotation' AND r.resource_id=$2 AND r.selection='query'`,[f.workspaceId,messages[2].id])).rows
  expect(field).toHaveLength(1);annotationResource=field[0].id
  const roots=(await f.pool.query(`SELECT 'application_field' kind,o.resource_id id,o.version FROM application_field_observations o
   WHERE o.workspace_id=$1 UNION SELECT 'application_query_domain',d.id,d.identity FROM application_query_domains d WHERE d.workspace_id=$1
   UNION SELECT 'session_context_revision',r.id,r.scope_version::text FROM session_context_scope_revisions r WHERE r.workspace_id=$1`,[f.workspaceId])).rows
  domainField=(await f.pool.query(`SELECT id,resource_id AS "resourceId" FROM application_field_resources
   WHERE workspace_id=$1 AND type_key='session_message' AND selection='query_domain' LIMIT 1`,[f.workspaceId])).rows[0]
  expect(domainField).toBeDefined()
  currentNodes=roots.map(row=>source(row.kind,row.id,row.version))
  currentNodes.push(source('session_message',reply.id,currentReplyVersion),
   point('session_message_annotation',missingHead,['id','topicLabel']),
   point('session_message_annotation',messages[2].id,['id','topicLabel']),
   point('session_message',messages[1].id,['id','content']))
  const initial=await createWorkspaceFile(f.ownerId,{workspaceId:f.workspaceId,path:`/uploads/fictional-edge-${randomUUID()}.txt`,
   parentPath:'/uploads',name:'Fictional edge document',mime:'text/plain',sizeBytes:1,storageUri:'fixture://compiled-edge-v1',createdByUserId:f.ownerId,source:'user'})
  const next=await supersedeWorkspaceFile(f.ownerId,f.workspaceId,initial.id,{editorUserId:f.ownerId,sizeBytes:2,storageUri:'fixture://compiled-edge-v2'})
  expect(next).not.toBeNull()
  const latest=await supersedeWorkspaceFile(f.ownerId,f.workspaceId,next!.id,{editorUserId:f.ownerId,sizeBytes:3,storageUri:'fixture://compiled-edge-v3'})
  expect(latest).not.toBeNull();files=[initial.id,next!.id,latest!.id]
 },120_000)
 afterAll(async()=>{
  try{await f?.cleanup()}finally{await getAppPool().end();await getPool().end()}
 })

 it('retains all semantic kinds, absent heads, ordered masks and original derivation versions',async()=>{
  const edges=await equalEdges(currentNodes)
  const absent=edges.filter(edge=>edge.parent.id===missingHead)
  expect(absent.some(edge=>edge.child.kind==='session_message')).toBe(true)
  expect(absent.some(edge=>edge.child.kind==='session_context_revision')).toBe(false)
  expect(edges.some(edge=>'tag' in edge.parent&&edge.parent.kind==='application_query_domain'&&edge.child.id===missingHead)).toBe(true)
  expect(edges.some(edge=>edge.child.kind==='session_context_revision'&&edge.child.id===newRevision)).toBe(true)
  const derivations=(await f.pool.query(`SELECT resource_version FROM scope_derivations
   WHERE workspace_id=$1 AND resource_kind='session_message' AND resource_id=$2`,[f.workspaceId,editedReply])).rows
  expect(derivations.some(row=>row.resource_version!==currentReplyVersion)).toBe(true)
  // The canonical helper intentionally includes the old derivation even when
  // the requested root has advanced. Filtering by root version would lose it.
  expect(edges.some(edge=>edge.parent.id===editedReply)).toBe(true)
 })

 it('uses all observation versions for privacy while semantic observations use the exact version',async()=>{
  const observations=(await f.pool.query(`SELECT version,source_id FROM application_field_observations
   WHERE workspace_id=$1 AND resource_id=$2 ORDER BY version`,[f.workspaceId,annotationResource])).rows
  expect(new Set(observations.map(row=>row.source_id))).toEqual(new Set([oldRevision,newRevision]))
  const privacy=await equalEdges([{kind:'application_field',id:annotationResource}],true)
  expect(new Set(privacy.filter(edge=>edge.child.kind==='session_context_revision').map(edge=>edge.child.id)))
   .toEqual(new Set([oldRevision,newRevision]))
  for(const observation of observations){
   const semantic=await equalEdges([source('application_field',annotationResource,observation.version)])
   expect(semantic.filter(edge=>edge.child.kind==='session_context_revision').map(edge=>edge.child.id)).toEqual([observation.source_id])
  }
  // Query-domain resources also retain the canonical versionless metadata edge.
  const domainPrivacy=await equalEdges([{kind:'application_field',id:domainField.id}],true)
  expect(domainPrivacy.some(edge=>edge.child.kind==='session_message'&&edge.child.id===domainField.resourceId)).toBe(true)
  await equalEdges(currentNodes.filter(node=>node.tag==='source').map(node=>({kind:node.kind,id:node.id})),true)
 })

 it('preserves the complete recording privacy closure and its limit',async()=>{
  const [predecessor,fused]=await Promise.all([
   readFile(new URL('../../../scripts/conversation-store/privacy.sql',import.meta.url),'utf8'),
   readFile(new URL('../../../scripts/conversation-store/fused-admission.sql',import.meta.url),'utf8'),
  ])
  const body=predecessor.split('$body$')[1]
  const fusedBody=fused.split('CREATE FUNCTION fused_f_privacy(')[1].split('$fa$')[1]
  const client=await f.pool.connect()
  try{
   await client.query('BEGIN')
   await client.query(`CREATE FUNCTION pg_temp.original_capture_privacy(w uuid,nodes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$${body}$body$`)
   await client.query(`CREATE FUNCTION pg_temp.original_fused_privacy(w uuid,nodes jsonb)
    RETURNS TABLE(node_count bigint,denied jsonb,session_ids jsonb,archive_count bigint,archive_denied jsonb)
    LANGUAGE sql STABLE AS $body$${fusedBody}$body$`)
   async function compare(nodes:Node[]){
    const {rows:[{original,current,originalFused,currentFused}]}=await client.query(`
     SELECT pg_temp.original_capture_privacy($1,$2) original,public.conversation_capture_privacy($1,$2) current,
      (SELECT to_jsonb(p) FROM pg_temp.original_fused_privacy($1,$2) p) AS "originalFused",
      (SELECT to_jsonb(p) FROM public.fused_f_privacy($1,$2) p) AS "currentFused"`,[f.workspaceId,JSON.stringify(nodes)])
    expect(current).toEqual(original)
    expect(currentFused).toEqual(originalFused)
    return current
   }
   expect((await compare(currentNodes)).denied).toEqual({})
   await client.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[f.session.id])
   expect((await compare(currentNodes)).denied).toHaveProperty(`session_message:${editedReply}`,true)
   const {rows:[{version}]}=await client.query<{version:string}>(`SELECT version FROM application_field_observations
    WHERE workspace_id=$1 AND resource_id=$2 AND source_id=$3`,[f.workspaceId,annotationResource,newRevision])
   const {denied}=await compare([source('application_field',annotationResource,version)])
   expect(denied).toMatchObject({
    [`application_field:${annotationResource}`]:true,
    [`session_context_revision:${oldRevision}`]:true,
    [`session_context_revision:${newRevision}`]:true,
   })
   const {rows:[{allowed}]}=await client.query<{allowed:boolean}>(`SELECT
    public.recording_source_read_allowed($1,'application_field',$2) allowed`,[f.workspaceId,annotationResource])
   expect(allowed).toBe(false)
   const roots=Array.from({length:4097},()=>source('memory',randomUUID(),'1'))
   expect((await compare(roots.slice(1))).denied).toEqual({})
   await expect(client.query('SELECT public.conversation_capture_privacy($1,$2)',[f.workspaceId,JSON.stringify(roots)]))
    .rejects.toMatchObject({code:'42501',message:'scope_ancestry_unavailable'})
  }finally{await client.query('ROLLBACK');client.release()}
 })

 it('keeps both predecessor hops and the root requested version independently of stored predecessor versions',async()=>{
  const requested='fictional-root-version'
  const edges=await equalEdges([source('workspace_file',files[2],requested)])
  const predecessors=edges.filter(edge=>edge.child.kind==='workspace_file')
  expect(new Set(predecessors.map(edge=>edge.child.id))).toEqual(new Set(files.slice(0,2)))
  expect(predecessors.every(edge=>'version'in edge.child&&edge.child.version===requested)).toBe(true)
 })
})
