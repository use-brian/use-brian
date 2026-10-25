/** App-data key primitives and host-bound authentication proof. [COMP:api/application-auth] */
import { randomBytes, randomUUID } from 'node:crypto'
import { hashSecret, verifySecret } from '../db/api-key-store.js'

const tokenPattern=/^sk_app_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/i
export function parseApplicationCredential(token:string):{id:string;secret:string}|null {
  if(token.length>128)return null
  const match=tokenPattern.exec(token)
  return match?{id:match[1].toLowerCase(),secret:match[2]}:null
}
/** Cryptographic material only. No rights exist until a qualified canonical store commits it. */
export async function mintApplicationCredentialSecret() {
  const id=randomUUID(),secret=randomBytes(32).toString('base64url')
  return {id,token:`sk_app_${id}_${secret}`,secretHash:await hashSecret(secret)}
}
export interface ApplicationCredentialState {
  id:string
  appId:string
  workspaceId:string
  subjectUserId:string
  issuerUserId:string
  credentialKind:'service'|'delegated'
  secretHash:string
  version:string
  clientRevision:string
  expiresAt:string
  /** Canonical loader checks client, subject, parent and current status, without business payloads. */
  admitted:boolean
}
export interface AuthenticatedApplicationCredential {
  credentialId:string
  appId:string
  workspaceId:string
  serviceUserId:string
  issuerUserId:string
  credentialKind:'service'|'delegated'
  credentialVersion:string
  applicationRevision:string
}
type LoadState=(id:string)=>Promise<ApplicationCredentialState|null>
type ApplicationCredentialAuthorityState=Omit<ApplicationCredentialState,'secretHash'>
const proofs=new WeakMap<AuthenticatedApplicationCredential,()=>Promise<ApplicationCredentialAuthorityState|null>>()
function live(state:ApplicationCredentialState|null,appId:string,now:number):state is ApplicationCredentialState {
  return state!==null&&state.admitted&&state.appId===appId&&Number.isFinite(Date.parse(state.expiresAt))&&Date.parse(state.expiresAt)>now
}
function sameCredential(left:ApplicationCredentialState,right:ApplicationCredentialState) {
  return left.id===right.id&&left.appId===right.appId&&left.workspaceId===right.workspaceId
    &&left.subjectUserId===right.subjectUserId&&left.issuerUserId===right.issuerUserId
    &&left.credentialKind===right.credentialKind&&left.secretHash===right.secretHash&&left.version===right.version&&left.expiresAt===right.expiresAt&&left.clientRevision===right.clientRevision
}
export async function authenticateApplicationCredential(token:string,appId:string,load:LoadState,now=()=>Date.now()):Promise<AuthenticatedApplicationCredential|null> {
  const parsed=parseApplicationCredential(token)
  if(!parsed)return null
  const stored=await load(parsed.id)
  if(!live(stored,appId,now())||stored.id!==parsed.id)return null
  const snapshot=structuredClone(stored)
  let verified=false
  try {verified=await verifySecret(parsed.secret,snapshot.secretHash)}catch {return null}
  if(!verified)return null
  const current=await load(parsed.id)
  if(!live(current,appId,now())||!sameCredential(snapshot,current))return null
  const auth:AuthenticatedApplicationCredential=Object.freeze({credentialId:snapshot.id,appId:snapshot.appId,workspaceId:snapshot.workspaceId,
    serviceUserId:snapshot.subjectUserId,issuerUserId:snapshot.issuerUserId,credentialKind:snapshot.credentialKind,credentialVersion:snapshot.version,applicationRevision:snapshot.clientRevision})
  proofs.set(auth,async()=>{
    const fresh=await load(snapshot.id)
    if(!live(fresh,appId,now())||!sameCredential(snapshot,fresh))return null
    const {secretHash:_secretHash,...metadata}=fresh
    return structuredClone(metadata)
  })
  return auth
}
/** JSON, copied metadata and model args cannot manufacture this live proof. */
export function getAuthenticatedApplicationCredentialCurrent(auth:AuthenticatedApplicationCredential) {
  return proofs.get(auth)
}

/** Rehydrate an explicitly reviewed server-owned background reference without storing a bearer secret. */
export async function authenticateBoundApplicationCredential(reference:import('./source-service-binding.js').SourceServiceCredentialReference):Promise<AuthenticatedApplicationCredential|null>{
  const {getSourceServiceCredentialReference}=await import('./source-service-binding.js')
  const {loadApplicationCredentialStateSystem}=await import('./auth-store.js')
  const binding=getSourceServiceCredentialReference(reference)
  if(!binding)return null
  await binding.assertCurrent()
  const initial=await loadApplicationCredentialStateSystem(binding.row.credentialId)
  if(!live(initial,binding.row.appId,Date.now())||initial.credentialKind!=='service'||initial.subjectUserId!==binding.row.serviceUserId)return null
  const snapshot=structuredClone(initial)
  const auth:AuthenticatedApplicationCredential=Object.freeze({credentialId:initial.id,appId:initial.appId,workspaceId:initial.workspaceId,serviceUserId:initial.subjectUserId,
    issuerUserId:initial.issuerUserId,credentialKind:initial.credentialKind,credentialVersion:initial.version,applicationRevision:initial.clientRevision})
  proofs.set(auth,async()=>{
    await binding.assertCurrent()
    const fresh=await loadApplicationCredentialStateSystem(initial.id)
    if(!live(fresh,binding.row.appId,Date.now())||!sameCredential(snapshot,fresh))return null
    const {secretHash:_secretHash,...metadata}=fresh;return structuredClone(metadata)
  })
  await binding.assertCurrent();return auth
}
