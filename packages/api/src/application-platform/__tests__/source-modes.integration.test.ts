import { afterAll, describe, expect, it } from 'vitest'
import { applyRLSGucs, getAppPool, getPool } from '../../db/client.js'
import { bindSessionContextRetainedAuthority, writeSessionContextRevision, readSessionContextRevisions } from '../../db/session-context-revisions.js'
import { pinPreparedExternalSourceAuthority } from '../retained-source-authority.js'
import { sourceModeFixture as fixture } from './fixtures/source-modes.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/external-source-access] explicit independent release admission',()=>{
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it('retains exact released ancestry under nonowner RLS, survives ordinary grant loss, and refuses another audience or revoked release',async()=>{
  const x=await fixture()
  try{
   const actor=await x.runtime(),read=await actor.runtime.read!('readRecord',{id:'record-1',fields:['description'],retentionMode:'released_snapshot',releaseId:x.releaseId},'released_snapshot')
   expect(read.result).not.toHaveProperty('_meta');expect(JSON.stringify(read.result)).toContain('Fictional released fact');expect(read.sources).toHaveLength(1)
   const proof=await x.coordinator.prepare(actor.execution,read.sources,'retain'),tx=await getAppPool().connect()
   try{
    await tx.query('BEGIN');await applyRLSGucs(tx,x.f.ownerId);await pinPreparedExternalSourceAuthority(tx,actor.execution,proof)
    expect((await tx.query('SELECT external_source_retention_allowed($1,$2,$3) AS allowed',[x.f.workspaceId,read.sources[0].resourceId,read.sources[0].version])).rows[0].allowed).toBe(true)
    await tx.query('COMMIT')
   }finally{await tx.query('ROLLBACK');tx.release()}
   const authority={execution:actor.execution,accumulator:actor.accumulator}
   bindSessionContextRetainedAuthority(actor.execution,(execution,sources,action)=>x.coordinator.prepare(execution,sources,action))
   const revision=await writeSessionContextRevision({sessionId:x.f.session.id,kind:'compact_summary',content:{summary:'Fictional released fact',boundarySequence:0},expectedCursor:null,authority,derivation:{producer:'fixture:explicit-release',sources:read.sources}})
   expect(revision).not.toBeNull()
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   const current=await x.runtime(),reader={execution:current.execution,accumulator:current.accumulator}
   bindSessionContextRetainedAuthority(current.execution,(execution,sources,action)=>x.coordinator.prepare(execution,sources,action))
   expect(await readSessionContextRevisions(x.f.session.id,'compact_summary',reader)).toMatchObject([{content:{summary:'Fictional released fact'}}])
   await expect(x.coordinator.prepare((await x.runtime(x.f.secondId)).execution,read.sources,'context')).rejects.toMatchObject({code:'source_access_denied'})
   await x.sourcePool.query('UPDATE releases SET revoked=true WHERE id=$1',[x.releaseId])
   await expect(x.coordinator.prepare((await x.runtime()).execution,read.sources,'context')).rejects.toMatchObject({code:'source_access_denied'})
   expect((await x.f.pool.query('SELECT observation FROM external_source_observations WHERE id=$1',[read.sources[0].resourceId])).rows[0].observation.retention).toEqual({mode:'released_snapshot',releaseId:x.releaseId,expiresAt:x.expiresAt})
  }finally{await x.cleanup()}
 })
 it('refuses expired releases and source withdrawal without laundering a missing observation',async()=>{
  const x=await fixture()
  try{
   const actor=await x.runtime(),args={id:'record-1',fields:['description'],retentionMode:'released_snapshot',releaseId:x.releaseId}
   const read=await actor.runtime.read!('readRecord',args,'released_snapshot')
   await x.sourcePool.query("UPDATE records SET withdrawn=true WHERE id='record-1'")
   await expect(x.coordinator.prepare(actor.execution,read.sources,'context')).rejects.toMatchObject({code:'source_access_denied'})
   await x.sourcePool.query("UPDATE records SET withdrawn=false WHERE id='record-1'")
   await x.sourcePool.query('UPDATE releases SET expires_at=$2 WHERE id=$1',[x.releaseId,Date.now()-1])
   await expect((await x.runtime()).runtime.read!('readRecord',args,'released_snapshot')).rejects.toMatchObject({code:'source_unavailable'})
  }finally{await x.cleanup()}
 })
})
