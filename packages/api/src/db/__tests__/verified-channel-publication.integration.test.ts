/** A live provider append holds its record before the ordinary-role writer. [COMP:api/conversation-visibility] */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { applyRLSGucs,getAppPool,getPool,queryWithRLS,rollbackAndRelease } from '../client.js'
import { initializeConversationVisibility,verifiedChannelPublicationActive } from '../conversation-visibility.js'
import { claimTurnLease,findOrCreateSession } from '../sessions.js'
import { pinVerifiedChannelPublication,type ChannelRecordPublication } from '../verified-channel-record.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/conversation-visibility] verified provider publication pin',()=>{
  beforeAll(async()=>{await initializeConversationVisibility();expect(verifiedChannelPublicationActive()).toBe(true)})
  afterAll(async()=>{await getAppPool().end();await getPool().end()})

  it('binds the exact current member, verified address and original lease through an app-role append and a later hold',async()=>{
    const f=await persistentContextFixture()
    const session=await findOrCreateSession({assistantId:f.assistantId,userId:f.ownerId,channelType:'telegram',channelId:'15550001331'})
    const token=(await claimTurnLease(session.id,f.assistantId))!
    const version=(await f.pool.query<{version:string}>('SELECT version::text AS version FROM public.conversation_envelopes WHERE session_id=$1',[session.id])).rows[0].version
    const binding:ChannelRecordPublication={address:{session,workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.ownerId,
      member:true,room:false},version}
    const signature='public.pin_verified_channel_conversation_append(uuid,uuid,uuid,uuid,text,text,boolean,boolean,bigint,uuid,uuid)'
    const sql=`SELECT ${signature.split('(')[0]}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`
    const original=[f.workspaceId,session.id,f.ownerId,f.assistantId,'telegram',session.channelId,true,false,version,token,null]
    const tx=await getAppPool().connect(),revocation=await getPool().connect()
    let hold:Promise<unknown>|undefined
    try {
      await expect(queryWithRLS(f.firstId,sql,original)).rejects.toMatchObject({code:'42501',message:'conversation_access_denied'})
      await expect(queryWithRLS(f.ownerId,sql,[...original.slice(0,9),randomUUID(),null])).rejects.toMatchObject({code:'42501'})
      await tx.query('BEGIN');await applyRLSGucs(tx,f.ownerId,f.assistantId)
      expect(await pinVerifiedChannelPublication(tx,binding,token)).toMatchObject({version,visibility:'private_by_kind'})
      const blocked=(await revocation.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      hold=revocation.query('UPDATE public.sessions SET recording_privacy_held=true WHERE id=$1',[session.id])
      let waiting=false
      for(let attempt=0;attempt<40&&!waiting;attempt++) {
        waiting=(await tx.query<{blocked:boolean}>('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS blocked',[blocked])).rows[0].blocked
        if(!waiting)await delay(20)
      }
      expect(waiting).toBe(true)
      await tx.query(`INSERT INTO public.session_messages(session_id,role,sender_user_id,content,sequence_num,workspace_id,user_id,
        sensitivity,compartments,project_ids,scope_version,scope_held) VALUES
        ($1,'user',$2,'[{"type":"text","text":"Fictional pinned channel input"}]',1,$3,$2,'internal','{}','{}',1,false)`,
      [session.id,f.ownerId,f.workspaceId])
      await tx.query('COMMIT')
      await hold
      await expect(queryWithRLS(f.ownerId,sql,original)).rejects.toMatchObject({code:'42501'})
      const ordinary=await queryWithRLS(f.ownerId,'SELECT content FROM public.session_messages WHERE session_id=$1',[session.id])
      expect(ordinary.rows).toEqual([])
      expect((await f.pool.query('SELECT id FROM public.session_messages WHERE session_id=$1',[session.id])).rowCount).toBe(1)
    } finally {
      await rollbackAndRelease(tx)
      await hold?.catch(()=>undefined)
      revocation.release()
      await f.cleanup()
    }
  })
})
