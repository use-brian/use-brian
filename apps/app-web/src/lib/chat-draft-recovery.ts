import type { Attachment } from './use-file-attachments'
import type { StagedRecording } from './recordings/use-recording-upload'

export type RecoverableChatDraft = {
  id:string; text:string; sessionId:string|null; assistantId:string|null; view:'personal'|'workspace';
  attachments:Attachment[]; recordings:StagedRecording[]; researchMode:boolean;
}
const memory=new Map<string,RecoverableChatDraft[]>()
const key=(workspaceId:string,userId:string)=>`sidan:chat-drafts:${workspaceId}:${userId}`
/** Unsent work only, scoped to this tab, workspace and signed-in person. */
export function readChatDrafts(workspaceId:string,userId:string):RecoverableChatDraft[] {
  const id=key(workspaceId,userId)
  if(memory.has(id))return memory.get(id)!
  try{const value=JSON.parse(sessionStorage.getItem(id)??'[]');if(Array.isArray(value))return value.filter(row=>row&&typeof row.id==='string'&&typeof row.text==='string'&&Array.isArray(row.attachments)&&Array.isArray(row.recordings))}catch{}
  return []
}
export function writeChatDrafts(workspaceId:string,userId:string,drafts:RecoverableChatDraft[]):void {
  const safe=drafts.map(draft=>({...draft,attachments:draft.attachments.map(({previewUrl:_preview,...attachment})=>attachment)}))
  memory.set(key(workspaceId,userId),safe)
  try{sessionStorage.setItem(key(workspaceId,userId),JSON.stringify(safe))}catch{}
}
