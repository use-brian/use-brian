import { z } from 'zod'
import { DerivedScopeError, bindScopeSources, boundScopeSources,
  type SessionStateSource, type SessionStateStatus, type SessionStateStore, type SessionContextAuthority } from '@use-brian/core'
import { readSessionContextRevisions, writeSessionContextRevision, mutateSessionContextParents, sessionContextGeneration,
  type SessionContextRevision } from './session-context-revisions.js'

export type SessionStateRow = {
  id: string; sessionId: string; userId: string; assistantId: string; key: string; status: SessionStateStatus
  summary: string; detail: string | null; source: SessionStateSource; createdAt: Date; updatedAt: Date; resolvedAt: Date | null
}
const payload = z.object({ key: z.string().min(1).max(200),status: z.enum(['open','resolved','cancelled']),summary: z.string().min(1).max(400),
  detail: z.string().max(8000).nullable(),source: z.enum(['tool','diff-pass','scheduler']),createdAt: z.number(),updatedAt: z.number(),resolvedAt: z.number().nullable() }).strict()
function record(row: SessionContextRevision): SessionStateRow {
  const value=payload.parse(row.content)
  return bindScopeSources({ ...value,id: row.parentId,sessionId: row.sessionId,userId: row.userId,assistantId: row.assistantId,
    createdAt: new Date(value.createdAt),updatedAt: new Date(value.updatedAt),resolvedAt: value.resolvedAt===null?null:new Date(value.resolvedAt) },boundScopeSources(row))
}
function writeProof(params: { authority?: SessionContextAuthority; derivation?: unknown }) {
  if (!params.authority || !params.derivation) throw new DerivedScopeError('scope_evidence_missing')
}
export async function upsertSessionState(params: Parameters<SessionStateStore['upsert']>[0]): Promise<SessionStateRow> {
  writeProof(params)
  const expectedGeneration=await sessionContextGeneration(params.sessionId)
  const existing=(await readSessionContextRevisions(params.sessionId,'session_state',params.authority)).find(row=>record(row).key===params.key)
  const old=existing?record(existing):undefined,now=Date.now()
  // Preserve tool-authored content only for the established tool -> diff rule.
  // Reopening still depends on both the old key/content and the new inputs.
  const keep=old?.source==='tool' && params.source==='diff-pass'
  const content={ key: params.key,status: 'open',summary: keep?old.summary:params.summary,
    detail: keep?old.detail:params.detail??null,source: params.source,createdAt: old?.createdAt.getTime()??now,updatedAt: now,resolvedAt: null }
  payload.parse(content)
  const row=await writeSessionContextRevision({ sessionId: params.sessionId,kind: 'session_state',content,expectedGeneration,authority: params.authority,
    derivation: { ...params.derivation!,sources: [...params.derivation!.sources,...(existing?boundScopeSources(existing):[])] },
    ...(existing?{parentId: existing.parentId,expectedRevision: existing.id}:{}) })
  if (!row) throw new DerivedScopeError('scope_source_changed')
  return record(row)
}
export async function resolveSessionState(params: Parameters<SessionStateStore['resolve']>[0]): Promise<SessionStateRow | null> {
  writeProof(params)
  const expectedGeneration=await sessionContextGeneration(params.sessionId)
  const existing=(await readSessionContextRevisions(params.sessionId,'session_state',params.authority)).find(row=>{
    const old=record(row);return old.key===params.key && old.status==='open'
  })
  if (!existing) return null
  const now=Date.now(),content={ ...existing.content,status: 'resolved',source: params.source,updatedAt: now,resolvedAt: now }
  const row=await writeSessionContextRevision({ sessionId: params.sessionId,kind: 'session_state',parentId: existing.parentId,
    expectedRevision: existing.id,content,expectedGeneration,authority: params.authority,
    derivation: { ...params.derivation!,sources: [...params.derivation!.sources,...boundScopeSources(existing)] } })
  if (!row) throw new DerivedScopeError('scope_source_changed')
  return record(row)
}
export async function listOpenSessionState(sessionId: string, authority?: SessionContextAuthority): Promise<SessionStateRow[]> {
  return (await readSessionContextRevisions(sessionId,'session_state',authority)).map(record).filter(row=>row.status==='open')
    .sort((a,b)=>b.updatedAt.getTime()-a.updatedAt.getTime())
}
export async function listRecentSessionState(sessionId: string, limit=50, authority?: SessionContextAuthority): Promise<SessionStateRow[]> {
  return (await readSessionContextRevisions(sessionId,'session_state',authority)).map(record)
    .sort((a,b)=>Number(b.status==='open')-Number(a.status==='open') || b.updatedAt.getTime()-a.updatedAt.getTime()).slice(0,Math.max(0,limit))
}
export async function purgeResolvedSessionState(sessionId: string, olderThan: Date, authority?: SessionContextAuthority): Promise<number> {
  const rows=(await readSessionContextRevisions(sessionId,'session_state',authority)).filter(row=>{
    const value=record(row);return value.status!=='open' && value.resolvedAt!==null && value.resolvedAt<olderThan
  })
  return mutateSessionContextParents(authority,'session_state',rows,'delete')
}
