import { publicRuntimeConfig } from "./runtime-public-config"
import { currentOfflineWriteAuthority } from "./offline/application-write-authority"
import type { Attachment } from './use-file-attachments'
import type { StagedRecording } from './recordings/use-recording-upload'

export type RecoverableChatDraft = {
  id:string; text:string; sessionId:string|null; assistantId:string|null; view:'personal'|'workspace';
  contextProjectId?:string|null; contextGroupId?:string|null;
  attachments:Attachment[]; recordings:StagedRecording[]; researchMode:boolean;
}
const memory=new Map<string,RecoverableChatDraft[]>()
/** Identity disposal and local-data clearing drop the in-memory copy. */
export function clearChatDraftMemory():void { memory.clear() }
if (typeof window !== 'undefined') window.addEventListener('brian:local-data-cleared', clearChatDraftMemory)

const PREFIX='brian:unsent:v1:chat-recovery:'
/**
 * The deployment part matches `useDurableDraft`: the normalized API origin of
 * the current write authority (`currentOfflineWriteAuthority().apiOrigin`).
 * A known authority for a different viewer has no key, so another person's
 * drafts are never read or written. Before the viewer is hydrated the same
 * normalized origin is derived from the runtime config.
 */
function key(workspaceId:string,userId:string):string|null {
  const owner=currentOfflineWriteAuthority(workspaceId)
  if(owner&&owner.viewerId!==userId)return null
  const origin=owner?.apiOrigin??(publicRuntimeConfig().apiUrl ?? "http://localhost:4000").replace(/\/$/, "")
  return `${PREFIX}${encodeURIComponent(origin)}:${workspaceId}:${userId}`
}
/**
 * Compatibility read for drafts written before M5 under the raw configured
 * `apiUrl` (no default, no trailing-slash normalization). A found legacy value
 * is migrated to the new key and removed.
 * Removal condition: delete this fallback in the first release after the M5
 * WP-F retirement ledger records a shipped release containing this migration
 * (one release cycle of reads), tracked as a D15 migration adapter.
 */
const legacyKey=(workspaceId:string,userId:string)=>`${PREFIX}${encodeURIComponent(publicRuntimeConfig().apiUrl ?? "")}:${workspaceId}:${userId}`
function parse(raw:string|null):RecoverableChatDraft[]|null {
  if(raw==null)return null
  try{const value=JSON.parse(raw);if(Array.isArray(value))return value.filter(row=>row&&typeof row.id==='string'&&typeof row.text==='string'&&Array.isArray(row.attachments)&&Array.isArray(row.recordings))}catch{}
  return []
}
/** Unsent work only, scoped to this deployment, workspace and signed-in person. */
export function readChatDrafts(workspaceId:string,userId:string):RecoverableChatDraft[] {
  const id=key(workspaceId,userId)
  if(!id)return []
  if(memory.has(id))return memory.get(id)!
  try{
    const current=parse(localStorage.getItem(id))
    if(current)return current
    const legacy=legacyKey(workspaceId,userId)
    const migrated=legacy===id?null:parse(localStorage.getItem(legacy))
    if(migrated){
      if(migrated.length)localStorage.setItem(id,JSON.stringify(migrated))
      localStorage.removeItem(legacy)
      return migrated
    }
  }catch{}
  return []
}
export function writeChatDrafts(workspaceId:string,userId:string,drafts:RecoverableChatDraft[]):void {
  const id=key(workspaceId,userId)
  if(!id)return
  const safe=drafts.map(draft=>({...draft,attachments:draft.attachments.map(({previewUrl:_preview,...attachment})=>attachment)}))
  memory.set(id,safe)
  try{localStorage.setItem(id,JSON.stringify(safe));const legacy=legacyKey(workspaceId,userId);if(legacy!==id)localStorage.removeItem(legacy)}catch{}
}
