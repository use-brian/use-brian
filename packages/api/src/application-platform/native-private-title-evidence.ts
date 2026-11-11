/** Optional identity-only private title proof. [COMP:api/application-persistence] */
import {z} from 'zod'
import type {PoolClient} from 'pg'
import {ContextScopeAccumulator,resourceScopeKey,type ScopeSource} from '@use-brian/core'
import type {readNativeSessionEvidence} from './native-session-evidence.js'
import type {NativeTitleHead} from './native-title-group-evidence.js'

const source=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.enum(['private_transcript','application_field','session_context_revision','session_message','memory']),
 resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
const proof=z.discriminatedUnion('admitted',[
 z.object({admitted:z.literal(false)}).strict(),
 z.object({admitted:z.literal(true),immutable:z.array(source),current:z.array(source)}).strict(),
])
const title=z.object({sessionId:z.string().uuid(),revisionId:z.string().uuid(),content:z.record(z.unknown())}).strict()
const packet=z.union([
 z.object({title:z.null(),proof:z.object({admitted:z.literal(false)}).strict()}).strict(),
 z.object({title,proof:z.object({admitted:z.literal(true),immutable:z.array(source),current:z.array(source)}).strict()}).strict(),
])
const headSchema=z.object({sessionId:z.string().uuid(),revisionId:z.string().uuid()}).strict()
type CompleteNativeEvidence=Extract<Awaited<ReturnType<typeof readNativeSessionEvidence>>,{kind:'complete'}>

function singleton(workspaceId:string,roots:readonly ScopeSource[]):ScopeSource|null{
 if(roots.length!==1)return null
 const parsed=source.safeParse(roots[0])
 return parsed.success&&parsed.data.workspaceId===workspaceId&&parsed.data.resourceKind==='session_context_revision'
  &&parsed.data.version==='1'?parsed.data:null
}
function complete(workspaceId:string,root:ScopeSource,parsed:Extract<z.infer<typeof proof>,{admitted:true}>):CompleteNativeEvidence{
 const same=(a:ScopeSource,b:ScopeSource)=>a.resourceKind===b.resourceKind&&a.resourceId===b.resourceId
  &&a.version===b.version&&resourceScopeKey(a)===resourceScopeKey(b)
 const privateLeaves=parsed.immutable.filter(value=>value.resourceKind==='private_transcript')
 if([...parsed.immutable,...parsed.current].some(value=>value.workspaceId!==workspaceId
    ||value.resourceKind==='private_transcript'&&value.version!=='1')
  ||!parsed.immutable.some(value=>same(value,root))||!parsed.current.some(value=>same(value,root))
  ||!privateLeaves.length||privateLeaves.some(leaf=>!parsed.current.some(value=>same(value,leaf))))throw new Error('Native private title evidence unavailable')
 return{kind:'complete',evidence:new ContextScopeAccumulator({sources:[root,...parsed.immutable]}).evidence,current:parsed.current}
}

/** Unsupported is distinct from a denial. Missing optional APIs are probed fresh,
 * without catching SQL failures (in particular cancellation and lock timeouts). */
export async function readNativePrivateTitleEvidence(client:Pick<PoolClient,'query'>,workspaceId:string,
 roots:readonly ScopeSource[]):Promise<CompleteNativeEvidence|null>{
 const root=singleton(workspaceId,structuredClone(roots))
 if(!root)return null
 const installed=(await client.query<{available:boolean}>(
  "SELECT to_regprocedure('public.read_native_private_title_evidence(uuid,uuid)') IS NOT NULL AS available")).rows[0]?.available===true
 if(!installed)return null
 const raw=(await client.query<{value:unknown}>('SELECT read_native_private_title_evidence($1,$2) AS value',
  [workspaceId,root.resourceId])).rows[0]?.value
 if(raw===null)return null
 const parsed=proof.parse(raw)
 if(!parsed.admitted)throw new Error('Native private title evidence unavailable')
 return complete(workspaceId,root,parsed)
}

/** SQL independently admits the exact head before selecting payload. No caller
 * packet or reusable proof carrier enters this operation. */
export async function readNativePrivateTitleAcquisition(client:Pick<PoolClient,'query'>,workspaceId:string,
 head:NativeTitleHead,roots:readonly ScopeSource[]):Promise<{title:z.infer<typeof title>;native:CompleteNativeEvidence}|null>{
 const identity=headSchema.parse(structuredClone(head)),root=singleton(workspaceId,structuredClone(roots))
 if(!root||root.resourceId!==identity.revisionId)return null
 const installed=(await client.query<{available:boolean}>(
  "SELECT to_regprocedure('public.read_native_private_title_acquisition(uuid,uuid,uuid)') IS NOT NULL AS available")).rows[0]?.available===true
 if(!installed)return null
 const raw=(await client.query<{value:unknown}>('SELECT read_native_private_title_acquisition($1,$2,$3) AS value',
  [workspaceId,identity.sessionId,identity.revisionId])).rows[0]?.value
 if(raw===null)return null
 const parsed=packet.parse(raw)
 if(!parsed.title||!parsed.proof.admitted)throw new Error('Native private title evidence unavailable')
 if(parsed.title.sessionId!==identity.sessionId||parsed.title.revisionId!==identity.revisionId)throw new Error('Native private title identity unavailable')
 return{title:parsed.title,native:complete(workspaceId,root,parsed.proof)}
}
