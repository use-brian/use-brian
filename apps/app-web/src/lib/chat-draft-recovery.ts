import { publicRuntimeConfig } from "./runtime-public-config"
import type { Attachment } from './use-file-attachments'
import type { StagedRecording } from './recordings/use-recording-upload'

export type RecoverableChatDraft = {
  id:string; text:string; sessionId:string|null; assistantId:string|null; view:'personal'|'workspace';
  contextProjectId?:string|null; contextGroupId?:string|null;
  attachments:Attachment[]; recordings:StagedRecording[]; researchMode:boolean;
}
const memory=new Map<string,RecoverableChatDraft[]>()
if (typeof window !== 'undefined') window.addEventListener('brian:local-data-cleared', () => memory.clear())
const key=(workspaceId:string,userId:string)=>`brian:unsent:v1:chat-recovery:${encodeURIComponent(publicRuntimeConfig().apiUrl ?? "")}:${workspaceId}:${userId}`
/** Unsent work only, scoped to this deployment, workspace and signed-in person. */
export function readChatDrafts(workspaceId:string,userId:string):RecoverableChatDraft[] {
  const id=key(workspaceId,userId)
  if(memory.has(id))return memory.get(id)!
  try{const value=JSON.parse(localStorage.getItem(id)??'[]');if(Array.isArray(value))return value.filter(row=>row&&typeof row.id==='string'&&typeof row.text==='string'&&Array.isArray(row.attachments)&&Array.isArray(row.recordings))}catch{}
  return []
}
export function writeChatDrafts(workspaceId:string,userId:string,drafts:RecoverableChatDraft[]):void {
  const safe=drafts.map(draft=>({...draft,attachments:draft.attachments.map(({previewUrl:_preview,...attachment})=>attachment)}))
  memory.set(key(workspaceId,userId),safe)
  try{localStorage.setItem(key(workspaceId,userId),JSON.stringify(safe))}catch{}
}
