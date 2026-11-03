/** Identity-only native title acquisition. [COMP:api/application-persistence] */
import {z} from 'zod'
import type {PoolClient} from 'pg'
import {ContextScopeAccumulator,resourceScopeKey,type ScopeSource} from '@use-brian/core'
import type {readNativeSessionEvidence} from './native-session-evidence.js'

export type NativeTitleHead=Readonly<{sessionId:string;revisionId:string}>
const source=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.enum(['application_field','session_context_revision','session_message','memory','workspace_file']),resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
const packet=z.object({titles:z.array(z.unknown()),proof:z.object({admitted:z.literal(true),immutable:z.array(source),current:z.array(source)}).strict()}).strict()
type CompleteNativeEvidence=Extract<Awaited<ReturnType<typeof readNativeSessionEvidence>>,{kind:'complete'}>

/** The SQL call creates the proof here; callers cannot supply a proof carrier. */
export async function readNativeTitleGroupEvidence(client:Pick<PoolClient,'query'>,workspaceId:string,
 heads:readonly NativeTitleHead[],roots:readonly ScopeSource[]):Promise<{titles:unknown[];native:CompleteNativeEvidence}|null>{
 if(heads.length<2||heads.length>50||new Set(heads.map(head=>head.sessionId)).size!==heads.length
  ||roots.length!==heads.length||roots.some(root=>root.workspaceId!==workspaceId||root.resourceKind!=='session_context_revision'
   ||root.version!=='1'||!heads.some(head=>head.revisionId===root.resourceId)))return null
 const raw=(await client.query<{value:unknown}>('SELECT read_native_personal_title_group_evidence($1,$2,$3) AS value',
  [workspaceId,heads.map(head=>head.sessionId),heads.map(head=>head.revisionId)])).rows[0]?.value
 if(raw===null)return null
 const parsed=packet.parse(raw)
 if([...parsed.proof.immutable,...parsed.proof.current].some(value=>value.workspaceId!==workspaceId)
  ||roots.some(root=>!parsed.proof.immutable.some(value=>value.resourceKind===root.resourceKind&&value.resourceId===root.resourceId
   &&value.version===root.version&&resourceScopeKey(value)===resourceScopeKey(root))))throw new Error('Native title evidence unavailable')
 return{titles:parsed.titles,native:{kind:'complete',evidence:new ContextScopeAccumulator({sources:[...roots,...parsed.proof.immutable]}).evidence,current:parsed.proof.current}}
}
