import {sessionAuthorityFactsParameters,type SessionAuthorityFactsInput} from '../context-scope/session-authority-facts.js'
/** Canonical conversation evidence. [COMP:api/application-persistence] */
import {z} from 'zod'
import type {PoolClient} from 'pg'
import {ContextScopeAccumulator, type ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import {resourceScopeKey, type ResourceScope, type ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
const scope=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.enum(['application_field','session_context_revision','session_message','memory','workspace_file','private_transcript']),resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
// Canonical media ancestors remain current-scope obligations for every receiver.
// They do not widen accepted roots or become newly declared factual inputs.
export const nativeSessionCurrentScopeSchema=scope.extend({resourceKind:z.enum([...scope.shape.resourceKind.options,'episode','recording'] as const)}).strict()
const labelScope=scope.pick({workspaceId:true,userId:true,assistantId:true,sensitivity:true,compartments:true,projectIds:true}).strict()
const historyResult=z.discriminatedUnion('available',[
 z.object({purpose:z.literal('memory_history'),available:z.literal(false)}).strict(),
 z.object({purpose:z.literal('memory_history'),available:z.literal(true),root:scope,scopes:z.array(labelScope).max(8192)}).strict(),
])
type CompleteNativeEvidence={kind:'complete';evidence:ScopeEvidence;current:ScopeSource[];authority?:unknown}
type NativeEvidence=CompleteNativeEvidence
 |{kind:'memory_history';available:false}|{kind:'memory_history';available:true;root:ScopeSource;scopes:ResourceScope[]}
const result=z.discriminatedUnion('admitted',[
 z.object({admitted:z.literal(false)}).strict(),
 z.object({admitted:z.literal(true),immutable:z.array(scope),current:z.array(nativeSessionCurrentScopeSchema)}).strict(),
])
const cohortProof=z.object({immutable:z.array(scope),current:z.array(nativeSessionCurrentScopeSchema)}).strict()
const publicationResult=z.object({admitted:z.literal(true),cohorts:z.tuple([cohortProof,cohortProof])}).strict()

/** Private host acquisition: the database independently projects each exact
 * original cohort. A union proof cannot stand in for either cohort's floor. */
export async function readConversationPublicationCohorts(client:Pick<PoolClient,'query'>,workspaceId:string,
 rawCohorts:readonly [readonly ScopeSource[],readonly ScopeSource[]]):Promise<[CompleteNativeEvidence,CompleteNativeEvidence]|null>{
 const cohorts=structuredClone(rawCohorts)
 if(cohorts.some(roots=>!roots.length||roots.length>4096||roots.some(root=>root.workspaceId!==workspaceId
  ||!['application_field','session_context_revision','session_message','workspace_file'].includes(root.resourceKind))))return null
 const identities=cohorts.map(roots=>roots.map(source=>({kind:source.resourceKind,id:source.resourceId,version:source.version})))
 const row=(await client.query<{value:unknown}>('SELECT capture_conversation_evidence($1,NULL,NULL,$2) AS value',
  [workspaceId,JSON.stringify(identities)])).rows[0]
 if(!row||!Object.hasOwn(row,'value')||row.value===undefined)throw new Error('Conversation publication cohorts unavailable')
 if(row.value===null)return null
 const parsed=publicationResult.parse(row.value)
 return parsed.cohorts.map((proof,index)=>{
  if([...proof.immutable,...proof.current].some(source=>source.workspaceId!==workspaceId)
   ||cohorts[index].some(root=>!proof.current.some(source=>source.resourceKind===root.resourceKind&&source.resourceId===root.resourceId)
    ||['application_field','session_context_revision'].includes(root.resourceKind)&&!proof.immutable.some(source=>
     source.resourceKind===root.resourceKind&&source.resourceId===root.resourceId&&source.version===root.version)))throw new Error('Native publication cohort unavailable')
  return{kind:'complete',evidence:new ContextScopeAccumulator({sources:[...cohorts[index],...proof.immutable]}).evidence,current:proof.current}
 }) as [CompleteNativeEvidence,CompleteNativeEvidence]
}
/** Null identifies an independently owned source family; it never means admitted. */
export async function readConversationEvidence(client:Pick<PoolClient,'query'>,workspaceId:string,roots:readonly ScopeSource[],settings?:ReadonlyArray<readonly [string,string]>,authority?:SessionAuthorityFactsInput):Promise<NativeEvidence|null>{
 if(!roots.length||roots.length>4096||roots.some(root=>root.workspaceId!==workspaceId
  ||!['application_field','session_context_revision','session_message','memory','workspace_file','private_transcript'].includes(root.resourceKind)))return null
 const identities=roots.map(source=>({kind:source.resourceKind,id:source.resourceId,version:source.version}))
 // MATERIALIZED and the volatile aggregate force every local setting before
 // the protected capture. Autocommit releases both context and source locks.
 const row=(await client.query<{value:unknown}>(settings===undefined
  ?(authority===undefined?'SELECT capture_conversation_evidence($1,$2) AS value':'SELECT capture_conversation_evidence($1,$2,$3) AS value')
  :`WITH context AS MATERIALIZED (
    SELECT count(set_config(setting.name,setting.value,true)) FROM unnest($3::text[],$4::text[]) AS setting(name,value)
   ) SELECT capture_conversation_evidence($1,$2${authority===undefined?'':',$5'}) AS value FROM context`,
  [workspaceId,JSON.stringify(identities),...(settings===undefined?[]:[settings.map(([name])=>name),settings.map(([,value])=>value)]),...(authority===undefined?[]:[JSON.stringify(sessionAuthorityFactsParameters(authority))])])).rows[0]
 if(!row||!Object.hasOwn(row,'value')||row.value===undefined)throw new Error('Conversation evidence unavailable')
 const raw=row.value
 if(raw===null)return null
 if(typeof raw==='object'&&raw!==null&&'purpose'in raw&&raw.purpose==='memory_history'){
  const history=historyResult.parse(raw)
  if(!history.available)return{kind:'memory_history',available:false}
  if(roots.length!==1||history.root.resourceKind!=='application_field'
   ||history.root.resourceId!==roots[0].resourceId||history.root.version!==roots[0].version
   ||resourceScopeKey(history.root)!==resourceScopeKey(roots[0])||history.scopes.some(value=>value.workspaceId!==workspaceId))throw new Error('Native history evidence unavailable')
  return{kind:'memory_history',available:true,root:history.root,scopes:history.scopes}
 }
 const proof=authority===undefined||typeof raw!=='object'||raw===null?raw:Object.fromEntries(Object.entries(raw).filter(([key])=>key!=='authority'))
 const parsed=result.parse(proof)
 if(!parsed.admitted)throw new Error('Native session evidence unavailable')
 if([...parsed.immutable,...parsed.current].some(source=>source.workspaceId!==workspaceId))throw new Error('Native session evidence unavailable')
 const evidence=new ContextScopeAccumulator({sources:[...roots,...parsed.immutable]}).evidence
 if(authority!==undefined&&(typeof raw!=='object'||raw===null||!Object.hasOwn(raw,'authority')))throw new Error('Native authority facts unavailable')
 return{kind:'complete',evidence,current:parsed.current,...(authority===undefined?{}:{authority:(raw as {authority:unknown}).authority})}
}

// Page receipts are current-scope obligations of the Page source family only.
// The ordinary capture schema above never accepts them.
const pageKinds=['page_event_changed','page_event_destination','page_live_changed','page_live_destination'] as const
const nativeEvidenceRoots = new Set(['application_field','session_context_revision','session_message','memory','workspace_file','private_transcript',...pageKinds])

/** Potential native or Page roots still require an admitted app-role transaction. */
export function isConversationEvidenceRoot(source: ScopeSource): boolean {
  return nativeEvidenceRoots.has(source.resourceKind)
}

const pageClosureCurrent=z.union([nativeSessionCurrentScopeSchema,scope.extend({resourceKind:z.enum(pageKinds),assistantId:z.null()}).strict()])
const pageClosureResult=z.object({admitted:z.literal(true),immutable:z.array(scope),current:z.array(pageClosureCurrent)}).strict()
type PageClosureRoot = Pick<ScopeSource, 'resourceKind' | 'resourceId' | 'version'>

async function capturePageClosure(client:Pick<PoolClient,'query'>,workspaceId:string,roots:readonly PageClosureRoot[],actor:string){
 const identities=roots.map(source=>({kind:source.resourceKind,id:source.resourceId,version:source.version}))
 const row=(await client.query<{value:unknown}>('SELECT capture_page_closure_evidence($1,$2,$3) AS value',[workspaceId,JSON.stringify(identities),actor])).rows[0]
 if(!row||!Object.hasOwn(row,'value')||row.value===undefined)throw new Error('Page closure evidence unavailable')
 if(row.value===null)return null
 const parsed=pageClosureResult.parse(row.value)
 if([...parsed.immutable,...parsed.current].some(source=>source.workspaceId!==workspaceId)
  ||!parsed.current.some(source=>(pageKinds as readonly string[]).includes(source.resourceKind)))throw new Error('Page closure evidence unavailable')
 return parsed
}

/** The current Page row supplies its exact receipt identity. The Page owner
 * supplies its labels and required saved/live observations in one proof. */
export async function readCurrentPageReceipt(client:Pick<PoolClient,'query'>,workspaceId:string,revision:string,actor:string):Promise<ScopeEvidence|null>{
 const result=await capturePageClosure(client,workspaceId,[{resourceKind:'page_event_changed',resourceId:revision,version:revision}],actor)
 if(!result)return null
 if(!result.current.some(source=>source.resourceKind==='page_event_changed'&&source.resourceId===revision&&source.version===revision))
  throw new Error('Current Page receipt unavailable')
 return new ContextScopeAccumulator({sources:[...result.immutable,...result.current]}).evidence
}

/** Page source-family adapter of the native capture. [COMP:api/application-persistence]
 * Called only after `readConversationEvidence` declined. The database admits a
 * closure whose only non-native family is Page receipts reached through
 * derivation edges, under the caller's own principal (`actor` must equal the
 * transaction's user): every Page receipt is admitted for that principal now,
 * with its saved and current boundaries as current obligations. Null means the
 * adapter does not own this closure (or could not prove it); the caller's full
 * source validator then decides, including every refusal. Never cached. */
export async function readPageClosureEvidence(client:Pick<PoolClient,'query'>,workspaceId:string,roots:readonly ScopeSource[],actor:string):Promise<CompleteNativeEvidence|null>{
 // Page receipts may be roots (a doc-thread turn reads its current Page directly);
 // the database admits them under the same principal rules as reached receipts.
 if(!actor||!roots.length||roots.length>4096||roots.some(root=>root.workspaceId!==workspaceId
  ||!['application_field','session_context_revision','session_message','memory','workspace_file','private_transcript',...pageKinds].includes(root.resourceKind)))return null
 const parsed=await capturePageClosure(client,workspaceId,roots,actor)
 if(!parsed)return null
 return{kind:'complete',evidence:new ContextScopeAccumulator({sources:[...roots,...parsed.immutable]}).evidence,current:parsed.current}
}

const mixedRoute = z.object({
  actor: z.string().uuid(),
  footprint: z.string().regex(/^[a-f0-9]{64}$/),
  families: z.array(z.enum(['native','page','history','retained','record','hybrid','independent'])).max(4096),
}).strict()

const mixedPorts = {
  conversation_mixed_evidence_route: {
    volatility: 's',
    body: '162c4eaf0a3d727d40f6e9ba729bcb1e8190809e89e1b4896e2bef66ed5be768',
  },
  capture_hybrid_conversation_evidence: {
    volatility: 'v',
    body: '6e201360f69999e2144df9c8f705d134905449a9e0959acb6ebc212357079ae3',
  },
} as const

async function readMixedConversationPort(client: Pick<PoolClient, 'query'>, port: keyof typeof mixedPorts,
  workspaceId: string, roots: readonly ScopeSource[]): Promise<unknown> {
  const identities = roots.map(source => ({ kind: source.resourceKind, id: source.resourceId, version: source.version }))
  const row = (await client.query<{ route: unknown }>(
    `SELECT CASE WHEN EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid='public.sessions'::regclass
      WHERE p.oid='public.${port}(uuid,jsonb)'::regprocedure
        AND p.proowner=c.relowner AND p.prosecdef AND p.provolatile=$4::"char"
        AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
        AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$3
    ) THEN public.${port}($1,$2) ELSE '"invalid_definition"'::jsonb END AS route`,
    [workspaceId, JSON.stringify(identities), mixedPorts[port].body, mixedPorts[port].volatility],
  )).rows[0]
  if (!row || !Object.hasOwn(row, 'route')) throw new Error('Mixed conversation source proof unavailable')
  return row.route
}

/** Route the exact original cohort through the transaction's native topology.
 * This receipt contains no admitted data and never proves any source visible. */
export async function readMixedConversationEvidenceRoute(
  client: Pick<PoolClient, 'query'>, workspaceId: string, roots: readonly ScopeSource[],
): Promise<z.infer<typeof mixedRoute> | null> {
  const raw = await readMixedConversationPort(client, 'conversation_mixed_evidence_route', workspaceId, roots)
  if (raw === null) return null
  const parsed = mixedRoute.parse(raw)
  if (parsed.families.length !== roots.length) throw new Error('Mixed conversation source route incomplete')
  return parsed
}

const hybridScope = scope.extend({ resourceKind: z.string().min(1) })
const hybridResult = z.object({
  admitted: z.literal(true),
  immutable: z.array(scope),
  current: z.array(hybridScope),
  independent: z.array(hybridScope.extend({ resourceKind: z.enum(['external_source','office_observation',...pageKinds]) })),
}).strict()

/** Prove canonical native nodes of a cross-family closure, with the exact
 * independently owned Page, connector and Office leaves for the receiver. */
export async function readHybridConversationEvidence(client: Pick<PoolClient, 'query'>, workspaceId: string,
  roots: readonly ScopeSource[]): Promise<{ native: CompleteNativeEvidence; independent: ScopeSource[] }> {
  const raw = await readMixedConversationPort(client, 'capture_hybrid_conversation_evidence', workspaceId, roots)
  const { immutable, current, independent } = hybridResult.parse(raw)
  if ([...immutable,...current,...independent].some(source => source.workspaceId !== workspaceId))
    throw new Error('Mixed conversation proof workspace mismatch')
  return { native: { kind: 'complete', evidence: new ContextScopeAccumulator({ sources: [...roots,...immutable] }).evidence, current }, independent }
}

const preparationCohortKinds=['application_field','session_context_revision','session_message','memory','workspace_file','private_transcript']
const preparationResult=z.object({cohorts:z.array(z.unknown()).max(8),fields:z.array(z.object({ord:z.number().int().positive(),snapshot:z.unknown()}).strict()).max(4096).optional(),
 authority:z.unknown().optional()}).strict()
/** One preparation cohort: complete native evidence, an independently owned
 * family (null), or a fresh refusal that the old reader reported by throwing. */
export type PreparationCohortEvidence=NativeEvidence|null|{kind:'refused'}
export type ConversationPreparation={cohorts:PreparationCohortEvidence[];fields?:Array<{ord:number;snapshot:unknown}>;authority?:unknown}

/** Decode one cohort returned by this boundary's canonical preparation proof. */
export function decodeConversationPreparationCohort(workspaceId:string,roots:readonly ScopeSource[],raw:unknown):PreparationCohortEvidence {
 if(raw===null)return null
 if(typeof raw==='object'&&raw!==null&&'purpose'in raw&&raw.purpose==='memory_history'){
  const history=historyResult.parse(raw)
  if(!history.available)return{kind:'memory_history',available:false}
  if(roots.length!==1||history.root.resourceKind!=='application_field'
   ||history.root.resourceId!==roots[0].resourceId||history.root.version!==roots[0].version
   ||resourceScopeKey(history.root)!==resourceScopeKey(roots[0])||history.scopes.some(value=>value.workspaceId!==workspaceId))throw new Error('Native history evidence unavailable')
  return{kind:'memory_history',available:true,root:history.root,scopes:history.scopes}
 }
 const proof=result.parse(raw)
 if(!proof.admitted)return{kind:'refused'}
 if([...proof.immutable,...proof.current].some(source=>source.workspaceId!==workspaceId))throw new Error('Native session evidence unavailable')
 return{kind:'complete',evidence:new ContextScopeAccumulator({sources:[...roots,...proof.immutable]}).evidence,current:proof.current}
}

/** Joint native preparation acquisition. [COMP:api/native-turn-frame]
 * One statement, one admitted frame, one boundary: the database validates the
 * executable registry once and projects every original cohort exactly as an
 * independent `readConversationEvidence` would. The result is never reused by
 * another boundary; later dispatch, output and publication remain fresh. */
export async function readConversationPreparation(client:Pick<PoolClient,'query'>,workspaceId:string,input:{
 cohorts:ReadonlyArray<readonly ScopeSource[]>;fields?:ReadonlyArray<{resourceId:string;version:string}>
 settings?:ReadonlyArray<readonly [string,string]>;authority?:SessionAuthorityFactsInput}):Promise<ConversationPreparation>{
 if(input.cohorts.length>8||input.fields!==undefined&&(input.fields.length<1||input.fields.length>4096))throw new Error('Conversation preparation request invalid')
 const cohorts=input.cohorts.map(roots=>structuredClone(roots))
 // The same caller-side family filter as readConversationEvidence: these
 // cohorts are independently owned and never reach the joint frame.
 const sent=cohorts.map((roots,index)=>({roots,index})).filter(({roots})=>roots.length>0&&roots.length<=4096
  &&roots.every(root=>root.workspaceId===workspaceId&&preparationCohortKinds.includes(root.resourceKind)))
 const output:PreparationCohortEvidence[]=cohorts.map(()=>null)
 if(!sent.length&&input.fields===undefined&&input.authority===undefined)return{cohorts:output}
 const identities=sent.map(({roots})=>roots.map(source=>({kind:source.resourceKind,id:source.resourceId,version:source.version})))
 const fields=input.fields===undefined?null:JSON.stringify({ids:input.fields.map(field=>field.resourceId),versions:input.fields.map(field=>field.version)})
 const authority=input.authority===undefined?null:JSON.stringify(sessionAuthorityFactsParameters(input.authority))
 const row=(await client.query<{value:unknown}>(input.settings===undefined
  ?'SELECT capture_conversation_preparation($1,$2,$3,$4) AS value'
  :`WITH context AS MATERIALIZED (
    SELECT count(set_config(setting.name,setting.value,true)) FROM unnest($5::text[],$6::text[]) AS setting(name,value)
   ) SELECT capture_conversation_preparation($1,$2,$3,$4) AS value FROM context`,
  [workspaceId,JSON.stringify(identities),fields,authority,...(input.settings===undefined?[]:[input.settings.map(([name])=>name),input.settings.map(([,value])=>value)])])).rows[0]
 if(!row||!Object.hasOwn(row,'value')||row.value===undefined||row.value===null)throw new Error('Conversation preparation unavailable')
 const parsed=preparationResult.parse(row.value)
 if(parsed.cohorts.length!==sent.length||(input.fields===undefined)!==(parsed.fields===undefined)||(input.authority===undefined)!==!Object.hasOwn(parsed,'authority'))
  throw new Error('Conversation preparation unavailable')
 parsed.cohorts.forEach((raw,position)=>{
  const {roots,index}=sent[position]
  output[index]=decodeConversationPreparationCohort(workspaceId,roots,raw)
 })
 if(parsed.fields!==undefined&&(parsed.fields.length!==input.fields!.length
  ||parsed.fields.some((field,position)=>field.ord!==position+1||!Object.hasOwn(field,'snapshot'))))throw new Error('Conversation preparation unavailable')
 return{cohorts:output,...(parsed.fields===undefined?{}:{fields:parsed.fields.map(field=>({ord:field.ord,snapshot:field.snapshot as unknown}))}),
  ...(input.authority===undefined?{}:{authority:parsed.authority})}
}
