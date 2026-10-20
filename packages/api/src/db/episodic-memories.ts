import { z } from 'zod'
import { DerivedScopeError,bindScopeSources,boundScopeSources,type EpisodicStore,type EpisodicMemoryRecord,type SessionContextAuthority } from '@use-brian/core'
import { readSessionContextRevisions,writeSessionContextRevision,mutateSessionContextParents,type SessionContextRevision } from './session-context-revisions.js'
export type EpisodicMemoryRow = EpisodicMemoryRecord
const payload=z.object({topicLabel:z.string().min(1),summary:z.string().min(1),messageSpan:z.object({
  fromSequence:z.number().int().nonnegative(),toSequence:z.number().int().nonnegative(),turnCount:z.number().int().nonnegative(),fromMsgId:z.string().optional(),toMsgId:z.string().optional()}).strict(),
  entityRefs:z.array(z.unknown()).nullable()}).strict()
function record(row:SessionContextRevision):EpisodicMemoryRow {
  const value=payload.parse(row.content)
  return bindScopeSources({...value,id:row.parentId,sessionId:row.sessionId,userId:row.userId,assistantId:row.assistantId,
    createdAt:row.createdAt,lastAccessedAt:row.lastAccessedAt,accessCount:row.accessCount,survivalCount:row.survivalCount},boundScopeSources(row))
}
export async function createEpisodicMemory(params:Parameters<EpisodicStore['create']>[0]):Promise<EpisodicMemoryRow> {
  const content={topicLabel:params.topicLabel,summary:params.summary,messageSpan:params.messageSpan,entityRefs:params.entityRefs??null}
  payload.parse(content)
  const row=await writeSessionContextRevision({sessionId:params.sessionId,kind:'episodic_memory',content,authority:params.authority,derivation:params.derivation})
  if(!row)throw new DerivedScopeError('scope_source_changed')
  return record(row)
}
export async function fetchEpisodicByTopic(params:Parameters<EpisodicStore['fetchByTopic']>[0]):Promise<EpisodicMemoryRow[]> {
  const rows=(await readSessionContextRevisions(params.sessionId,'episodic_memory',params.authority))
    .filter(row=>record(row).topicLabel===params.topicLabel)
    .sort((a,b)=>b.lastAccessedAt.getTime()-a.lastAccessedAt.getTime()).slice(0,Math.max(0,params.limit??3))
  if(rows.length)await mutateSessionContextParents(params.authority,'episodic_memory',rows,'access')
  return rows.map(row=>{const value=record(row);value.lastAccessedAt=new Date();value.accessCount+=1;return value})
}
export async function fetchEpisodicBySession(params:Parameters<EpisodicStore['fetchBySession']>[0]):Promise<EpisodicMemoryRow[]> {
  return (await readSessionContextRevisions(params.sessionId,'episodic_memory',params.authority)).map(record)
    .sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime()).slice(0,Math.max(0,params.limit??50))
}
export async function listEpisodicTopicsBySession(params:Parameters<EpisodicStore['listTopicsBySession']>[0]):Promise<string[]> {
  const rows=(await readSessionContextRevisions(params.sessionId,'episodic_memory',params.authority)).map(record)
    .sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime())
  return [...new Set(rows.map(row=>row.topicLabel))].slice(0,Math.max(0,params.limit??20))
}
export async function listEpisodicBySession(sessionId:string,authority?:SessionContextAuthority):Promise<EpisodicMemoryRow[]> {
  return (await readSessionContextRevisions(sessionId,'episodic_memory',authority)).map(record).sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime())
}
export async function deleteEpisodicById(id:string,authority?:SessionContextAuthority):Promise<void> {
  const rows=await readSessionContextRevisions(authority?.execution.lifecycle.sessionId??'','episodic_memory',authority)
  await mutateSessionContextParents(authority,'episodic_memory',rows.filter(row=>row.parentId===id),'delete')
}
export async function incrementEpisodicSurvivalCount(ids:string[],authority?:SessionContextAuthority):Promise<void> {
  if(!ids.length)return
  const rows=await readSessionContextRevisions(authority?.execution.lifecycle.sessionId??'','episodic_memory',authority)
  await mutateSessionContextParents(authority,'episodic_memory',rows.filter(row=>ids.includes(row.parentId)),'survive')
}
