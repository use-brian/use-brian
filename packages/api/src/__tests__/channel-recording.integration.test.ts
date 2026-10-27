import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, query } from '../db/client.js'
import { admitTelegramRecording, changeChannelRecording, telegramRecordingEnabled, confirmChannelRecordingOwner } from '../channel-recording.js'
import { getSessionTranscriptForWorkspaceSystem, listSessionsForWorkspaceSystem } from '../db/sessions.js'
import { appendChannelRoomMessage } from '../channel-room/messages.js'
import { findOrCreateChannelRoom } from '../channel-room/room.js'
import { decideSessionRead } from '../session-read-access.js'
const { assertLocalFixture } = await import(new URL('../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const [workspace,owner,speaker,assistant,channel,integration] = Array.from({length:6},()=>randomUUID())
const conversationId = '-1000000001:topic:21'
const incoming = (id: string) => ({ integrationId: integration,conversationId,assistantId: assistant,providerMessageId: id,text:`Message ${id}`,senderUserId:speaker })

describe('[COMP:api/channel-recording] native recording ownership and cutover', () => {
  beforeAll(async () => {
    await query(`INSERT INTO users(id,auth_provider,auth_provider_id,name) SELECT id,'test',id::text,'Fictional person' FROM unnest($1::uuid[]) id`,[[owner,speaker]])
    await query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Recording test',$2)",[workspace,owner])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')",[workspace,owner,speaker])
    await query("INSERT INTO assistants(id,name,workspace_id,clearance) VALUES($1,'Recorder',$2,'internal')",[assistant,workspace])
    await query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Test bot')",[channel,workspace])
    await query("INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id) VALUES($1,$2,'telegram','\\x00'::bytea,'987654321')",[integration,channel])
  })
  afterAll(async () => {
    await query('DELETE FROM workspaces WHERE id=$1',[workspace])
    await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,speaker]])
    await getPool().end(); await getAppPool().end()
  })
  it('does not guess a legacy owner and persists the connecting identity on confirmation',async()=>{
    expect(await telegramRecordingEnabled(integration,conversationId)).toBe(false)
    await expect(confirmChannelRecordingOwner(integration,speaker)).rejects.toThrow()
    await confirmChannelRecordingOwner(integration,owner)
    expect(await telegramRecordingEnabled(integration,conversationId)).toBe(true)
  })
  it('records every speaker privately for the connector owner, blocks system transcript leakage and replays',async()=>{
    const first=await admitTelegramRecording(incoming('1'))
    expect(first?.session).toMatchObject({userId:owner,visibility:'personal',anchorKind:'channel'})
    expect(decideSessionRead({callerUserId:speaker,session:first!.session,assistantWorkspaceId:workspace,
      membershipClearance:'confidential',membershipCompartments:null,membershipProjectIds:null}).readable).toBe(false)
    expect(decideSessionRead({callerUserId:owner,session:first!.session,assistantWorkspaceId:workspace,
      membershipClearance:'confidential',membershipCompartments:null,membershipProjectIds:null}).readable).toBe(true)
    await expect(query("UPDATE sessions SET visibility='workspace' WHERE id=$1",[first!.session.id])).rejects.toThrow()
    await expect(query('UPDATE sessions SET recording_revision=NULL WHERE id=$1',[first!.session.id])).rejects.toThrow()
    await expect(query('UPDATE sessions SET room_capture=true WHERE id=$1',[first!.session.id])).rejects.toThrow()
    const next=await admitTelegramRecording({...incoming('2'),senderUserId:owner})
    expect(next?.session.id).toBe(first!.session.id)
    expect((await query('SELECT sender_user_id FROM session_messages WHERE session_id=$1 ORDER BY sequence_num',[first!.session.id])).rows.map(r=>r.sender_user_id)).toEqual([speaker,owner])
    expect(await admitTelegramRecording(incoming('1'))).toBeNull()
    expect(await getSessionTranscriptForWorkspaceSystem(first!.session.id,workspace,{limit:10})).toBeNull()
    expect((await listSessionsForWorkspaceSystem(workspace,{limit:50})).some(r=>r.id===first!.session.id)).toBe(false)
  })
  it('uses immutable future epochs and refuses stale writers, invalid Projects and competing revisions',async()=>{
    const personal=await admitTelegramRecording(incoming('3'))
    const base={integrationId:integration,actorId:owner,id:personal!.policy.id,revision:personal!.policy.revision,enabled:true}
    await expect(changeChannelRecording({...base,destination:'workspace',projectId:randomUUID()})).rejects.toThrow()
    const work=await changeChannelRecording({...base,destination:'workspace',projectId:null})
    await expect(changeChannelRecording({...base,destination:'workspace',projectId:null})).rejects.toThrow()
    const shared=await admitTelegramRecording(incoming('4'))
    expect(shared!.session.visibility).toBe('workspace')
    expect(shared!.session.id).not.toBe(personal!.session.id)
    expect((await query('SELECT visibility FROM sessions WHERE id=$1',[personal!.session.id])).rows[0].visibility).toBe('personal')
    await expect(appendChannelRoomMessage({sessionId:personal!.session.id,role:'user',content:[{type:'text',text:'stale'}],channelMessageId:'stale'})).rejects.toThrow(/recording_destination_unavailable/)
    expect(await admitTelegramRecording(incoming('1'))).toBeNull()
    await changeChannelRecording({...base,revision:work.revision,enabled:false,destination:'workspace',projectId:null})
    expect(await telegramRecordingEnabled(integration,conversationId)).toBe(false)
    await expect(admitTelegramRecording(incoming('5'))).rejects.toThrow()
    expect((await query('SELECT 1 FROM channel_recording_messages WHERE provider_message_id=$1 AND policy_id=$2',['5',base.id])).rows).toHaveLength(0)
  })
  it('requires a live Project roster and preserves its label on repeated writes',async()=>{
    const project=randomUUID()
    await query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Test project','test project',$3)",[project,workspace,owner])
    await query("INSERT INTO project_shared_scopes(project_id,workspace_id,origin,status) VALUES($1,$2,'created','active')",[project,workspace])
    await query('INSERT INTO project_shared_owners(workspace_id,project_id,user_id) VALUES($1,$2,$3)',[workspace,project,owner])
    await query("INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,assistant_id,origin) VALUES($1,$2,'assistant',$3,'invited')",[workspace,project,assistant])
    await query('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=true WHERE id=$1',[workspace])
    await query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='departments' WHERE workspace_id=$1",[workspace])
    const personal=await admitTelegramRecording({...incoming('project-1'),conversationId:'-1000000004'})
    await changeChannelRecording({integrationId:integration,actorId:owner,id:personal!.policy.id,revision:personal!.policy.revision,
      enabled:true,destination:'workspace',projectId:project})
    const work=await admitTelegramRecording({...incoming('project-2'),conversationId:'-1000000004'})
    expect(work!.session.contextProjectId).toBe(project)
    expect(work!.session.contextCompartments).toEqual([`project:${project}`])
    expect((await admitTelegramRecording({...incoming('project-3'),conversationId:'-1000000004'}))!.session.id).toBe(work!.session.id)
    await query("DELETE FROM project_shared_members WHERE project_id=$1 AND assistant_id=$2",[project,assistant])
    await expect(admitTelegramRecording({...incoming('project-4'),conversationId:'-1000000004'})).rejects.toThrow()
    await expect(appendChannelRoomMessage({sessionId:work!.session.id,role:'user',content:[{type:'text',text:'revoked'}],channelMessageId:'revoked'})).rejects.toThrow()
  })
  it('revocation blocks new writes and legacy channel identities stay quarantined',async()=>{
    const legacy={workspaceId:workspace,channelIntegrationId:integration,assistantId:assistant,channelType:'telegram',channelId:'-1000000002',starterUserId:speaker}
    await expect(findOrCreateChannelRoom(legacy)).rejects.toThrow('channel_room_unavailable')
    await expect(findOrCreateChannelRoom({...legacy,starterUserId:owner})).rejects.toThrow('channel_room_unavailable')
    expect((await query('SELECT id FROM sessions WHERE workspace_id=$1 AND channel_id=$2 AND recording_privacy_held',[workspace,legacy.channelId])).rows).toHaveLength(1)
    await query("UPDATE channels SET status='revoked' WHERE id=$1",[channel])
    expect(await telegramRecordingEnabled(integration,'-1000000003')).toBe(false)
    await expect(admitTelegramRecording({...incoming('6'),conversationId:'-1000000003'})).rejects.toThrow()
  })
})
