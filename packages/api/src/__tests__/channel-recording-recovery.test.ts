/** [COMP:api/channel-recording] The real recovery migration is exercised as a
 * non-superuser. Fixture bodies remain in place; only reviewed text may resume. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ids = Object.fromEntries(['actor','other','member','workspace','assistant','channel','integration','session','privateSession'].map(key=>[key,randomUUID()])) as Record<string,string>
const conversation = '-1000000123:topic:9'
const db = new PGlite()
const sql = (text:string,values:unknown[]=[]) => db.query<Record<string,unknown>>(text,values)
const actor = async (id=ids.actor) => { await sql("SELECT set_config('app.current_user_id',$1,false)",[id]) }
const preview = async (id=ids.actor,sessionId=ids.session) => {
  await actor(id)
  return (await sql('SELECT telegram_recording_recovery_snapshot($1,$2,$3,$4) AS value',[id,ids.workspace,ids.channel,sessionId])).rows[0] as {value:Record<string,unknown>|null}
}
const apply = async (token:string,id=ids.actor,sessionId=ids.session) => {
  await actor(id)
  return (await sql('SELECT apply_telegram_recording_recovery($1,$2,$3,$4,$5) AS value',[id,ids.workspace,ids.channel,sessionId,token])).rows[0] as {value:Record<string,unknown>}
}

async function schema() {
  await db.exec(`CREATE ROLE recording_recovery_app; CREATE ROLE app_user; GRANT app_user TO recording_recovery_app; GRANT CREATE ON SCHEMA public TO recording_recovery_app; SET ROLE recording_recovery_app;
    CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE workspaces(id uuid PRIMARY KEY,department_read_v2 boolean DEFAULT false,project_shared_spaces boolean DEFAULT false);
    CREATE TABLE workspace_members(workspace_id uuid,user_id uuid,role text,clearance text,compartments text[] DEFAULT '{}');
    CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid,clearance text,name text DEFAULT 'Fictional assistant',compartments text[]);
    CREATE TABLE channels(id uuid PRIMARY KEY,workspace_id uuid,channel_type text,status text DEFAULT 'active');
    CREATE TABLE channel_integrations(id uuid PRIMARY KEY,channel_id uuid,channel_type text,status text DEFAULT 'active',bot_user_id text,
      recording_owner_user_id uuid,connected_by_user_id uuid,connected_workspace_id uuid,connected_bot_user_id text,config jsonb DEFAULT '{}');
    CREATE TABLE channel_assistants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),channel_id uuid,assistant_id uuid,external_surface_id text);
    CREATE TABLE workspace_projects(id uuid PRIMARY KEY,workspace_id uuid,status text,name text); CREATE TABLE project_shared_scopes(project_id uuid,status text);
    CREATE TABLE sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,user_id uuid,assistant_id uuid,channel_type text,channel_id text,
      visibility text,anchor_kind text,anchor_ref text,effective_clearance text,context_compartments text[] DEFAULT '{}',context_project_id uuid,
      context_group_id uuid,recording_policy_id uuid,recording_revision integer,recording_privacy_held boolean DEFAULT false,
      room_capture boolean DEFAULT false,app_id text,app_origin text,clearance_source text,title text,created_at timestamptz DEFAULT now(),
      last_active_at timestamptz DEFAULT now(),compact_summary text,compact_boundary_sequence integer);
    CREATE TABLE session_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid,role text,content jsonb,sequence_num integer,
      channel_message_id text,sender_user_id uuid,sender_assistant_id uuid,published_sender_name text,workspace_id uuid,user_id uuid,
      assistant_id uuid,sensitivity text DEFAULT 'internal',compartments text[] DEFAULT '{}',project_ids uuid[] DEFAULT '{}',
      scope_version integer,scope_held boolean,created_at timestamptz DEFAULT now(),attachments jsonb DEFAULT '[]',CHECK(workspace_id IS NULL OR scope_version IS NOT NULL AND scope_held IS NOT NULL));
    CREATE TABLE channel_recording_policies(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),integration_id uuid,workspace_id uuid,bot_id text,
      owner_user_id uuid,conversation_id text,enabled boolean DEFAULT true,destination text DEFAULT 'personal',project_id uuid,
      revision integer DEFAULT 1,session_id uuid,updated_at timestamptz DEFAULT now(),UNIQUE(workspace_id,bot_id,conversation_id));
    CREATE TABLE channel_recording_messages(policy_id uuid,provider_message_id text,session_id uuid,PRIMARY KEY(policy_id,provider_message_id));`)
  await sql('INSERT INTO users VALUES($1),($2),($3)',[ids.actor,ids.other,ids.member])
  await sql('INSERT INTO workspaces(id) VALUES($1)',[ids.workspace])
  await sql("INSERT INTO workspace_members VALUES($1,$2,'owner','confidential','{}'),($1,$3,'admin','confidential','{}'),($1,$4,'member','internal','{}')",[ids.workspace,ids.actor,ids.other,ids.member])
  await sql("INSERT INTO assistants(id,workspace_id,clearance) VALUES($1,$2,'internal')",[ids.assistant,ids.workspace])
  await sql("INSERT INTO channels(id,workspace_id,channel_type) VALUES($1,$2,'telegram')",[ids.channel,ids.workspace])
  await sql("INSERT INTO channel_integrations(id,channel_id,channel_type,bot_user_id) VALUES($1,$2,'telegram','987654321')",[ids.integration,ids.channel])
  await sql('INSERT INTO channel_assistants(channel_id,assistant_id,external_surface_id) VALUES($1,$2,$3)',[ids.channel,ids.assistant,conversation])
  for(const [id,visibility] of [[ids.session,'workspace'],[ids.privateSession,'personal']]) {
    await sql(`INSERT INTO sessions(id,workspace_id,user_id,assistant_id,channel_type,channel_id,visibility,anchor_kind,anchor_ref,effective_clearance,
      recording_privacy_held,title,compact_summary) VALUES($1,$2,$3,$4,'telegram',$5,$6,'channel',$5,'internal',true,'Fictional old topic','PRIVATE_SUMMARY')`,[id,ids.workspace,ids.actor,ids.assistant,conversation,visibility])
  }
}

async function setup() {
  await schema()
  await db.exec(`CREATE FUNCTION sensitivity_rank(text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT CASE $1 WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 ELSE 3 END $$;
    CREATE FUNCTION office_labels_scope_allows(uuid,text,text[],uuid[],uuid[],uuid[],boolean) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.test_scope_allowed',true),'true')<>'false' $$;
    CREATE FUNCTION project_member_live(uuid,text,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;`)
  const binding={version:1,channelId:conversation,audienceType:'group',clearance:'internal',compartments:[],projectIds:[],recipientUserId:null,expiresAt:null,approvedByUserId:ids.actor}
  await sql('UPDATE channel_integrations SET config=$2 WHERE id=$1',[ids.integration,{requireMentionOverrides:[{chatId:'-1000000123',topicId:9}],deliveryAudienceBindings:[binding]}])
  for(const [sequence,role,content,provider] of [
    [1,'user',[{type:'text',text:'Fictional meeting on December 9.'}],'101'],
    [2,'assistant',[{type:'text',text:'The fictional meeting is recorded.'}],'102'],
    [3,'assistant',[{type:'text',text:'PRIVATE_NARRATION'},{type:'tool_use',name:'lookup',input:{private:'PRIVATE_INPUT'}}],'103'],
    [4,'user',[{type:'tool_result',toolUseId:'lookup',content:'PRIVATE_RESULT'}],'104'],
    [5,'assistant',[{type:'text',text:'PRIVATE_UNDELIVERED'}],null],
  ] as const) {
    await sql(`INSERT INTO session_messages(session_id,role,content,sequence_num,channel_message_id,sender_user_id,workspace_id,sensitivity,scope_version,scope_held)
      VALUES($1,$2,$3,$4,$5,$6,$7,'internal',1,false)`,[ids.session,role,JSON.stringify(content),sequence,provider,role==='user'?ids.actor:null,ids.workspace])
  }
  for(const [sequence,provider,userId,assistantId,held,compartments] of [
    [6,'105',ids.other,null,false,[]],
    [7,'106',null,null,true,[]],
    [8,'107',null,ids.assistant,false,[]],
    [9,'108',null,null,false,['private-team']],
    [10,'101',null,null,false,[]],
  ] as const) {
    await sql(`INSERT INTO session_messages(session_id,role,content,sequence_num,channel_message_id,workspace_id,sensitivity,scope_version,scope_held,user_id,assistant_id,compartments)
      VALUES($1,'user',$2,$3,$4,$5,'internal',1,$6,$7,$8,$9)`,
      [ids.session,JSON.stringify([{type:'text',text:'PRIVATE_RESTRICTED_OR_DUPLICATE'}]),sequence,provider,ids.workspace,held,userId,assistantId,compartments])
  }
  for(const [file,name] of [['8134_channel_recording_destination.sql','admit_channel_recording_session'],['8134_channel_recording_destination.sql','guard_channel_recording_session_update'],['8135_channel_recording_privacy_hold.sql','guard_session_recording_privacy']] as const) {
    const source=await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8')
    const start=source.indexOf(`CREATE FUNCTION ${name}()`)
    const end=source.indexOf('END $$;',start)+'END $$;'.length
    expect(start).toBeGreaterThanOrEqual(0)
    await db.exec(source.slice(start,end))
  }
  await db.exec(`CREATE TRIGGER aaab_session_recording_privacy BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION guard_session_recording_privacy();
    CREATE TRIGGER channel_recording_session_admission BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION admit_channel_recording_session();
    CREATE TRIGGER channel_recording_session_update BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION guard_channel_recording_session_update();`)
  await db.exec(await readFile(new URL('../../migrations/8241_telegram_recording_history_recovery.sql',import.meta.url),'utf8'))
  await actor()
}

function token(p:{value:Record<string,unknown>|null}) { expect(p.value).not.toBeNull(); return String(p.value!.snapshotToken) }

describe.sequential('[COMP:api/channel-recording] reviewed legacy group text recovery',()=>{
  beforeAll(setup)
  afterAll(async()=>{await db.close()})
  it('runs the migration as an ordinary role and previews exact public text without reading private history',async()=>{
    expect((await sql('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false})
    const p=await preview()
    expect(p.value).toMatchObject({messageCount:2,skippedMessageCount:8,sessionId:ids.session})
    expect(JSON.stringify(p.value)).not.toContain('PRIVATE_')
    expect((await preview(ids.actor,ids.privateSession)).value).toBeNull()
    expect((await preview(ids.other)).value).toBeNull()
    expect((await preview(ids.member)).value).toBeNull()
    await actor(ids.other)
    expect((await sql('SELECT telegram_recording_recovery_snapshot($1,$2,$3,$4) AS value',[ids.actor,ids.workspace,ids.channel,ids.session])).rows[0]).toEqual({value:null})
  })
  it('exposes only authenticated review ports to the runtime role',async()=>{
    await actor()
    await db.exec('SET ROLE app_user')
    try {
      const result=await sql('SELECT preview_telegram_recording_recovery($1,$2,$3) AS value',[ids.actor,ids.workspace,ids.channel])
      expect(JSON.stringify(result.rows)).toContain(ids.session)
      await expect(sql('SELECT * FROM channel_recording_recovery_receipts')).rejects.toThrow('permission denied')
      await expect(sql('SELECT * FROM telegram_recording_recovery_projection($1)',[ids.session])).rejects.toThrow('permission denied')
      await expect(sql('SELECT telegram_recording_recovery_text($1::jsonb)',['[]'])).rejects.toThrow('permission denied')
    } finally { await db.exec('SET ROLE recording_recovery_app') }
  })
  it('projects only complete text messages and strips untrusted block metadata',async()=>{
    const project=async(body:unknown)=>(await sql('SELECT telegram_recording_recovery_text($1::jsonb) AS value',[JSON.stringify(body)])).rows[0].value
    expect(await project([{type:'text',text:'Visible',signature:'PRIVATE_SIGNATURE'}])).toEqual([{type:'text',text:'Visible'}])
    expect(await project('Plain provider text')).toEqual([{type:'text',text:'Plain provider text'}])
    for(const body of [null,{},[],[{type:'text',text:' '}],[{type:'text',text:'Visible'},{type:'image',data:'PRIVATE_IMAGE'}],[{type:'thinking',thinking:'PRIVATE_REASONING'}],[{type:'text',text:3}]]) expect(await project(body)).toBeNull()
  })
  it('refuses generic unhold, stale review, changed audience and revoked source access',async()=>{
    await expect(sql('UPDATE sessions SET recording_privacy_held=false WHERE id=$1',[ids.session])).rejects.toThrow('recording_privacy_review_required')
    const old=token(await preview())
    await sql("UPDATE sessions SET title='Changed after review' WHERE id=$1",[ids.session])
    await expect(apply(old)).rejects.toThrow('recording_recovery_unavailable')
    await sql("SELECT set_config('app.test_scope_allowed','false',false)")
    expect((await preview()).value).toBeNull()
    await sql("SELECT set_config('app.test_scope_allowed','true',false)")
    const original=(await sql('SELECT config FROM channel_integrations WHERE id=$1',[ids.integration])).rows[0].config
    await sql('UPDATE channel_integrations SET config=$2 WHERE id=$1',[ids.integration,{deliveryAudienceBindings:[]}])
    expect((await preview()).value).toBeNull()
    await sql('UPDATE channel_integrations SET config=$2 WHERE id=$1',[ids.integration,original])
  })
  it('rejects wrong topic, a stopped competing policy, and a departed original actor',async()=>{
    await sql('UPDATE channel_assistants SET external_surface_id=$2 WHERE channel_id=$1',[ids.channel,'-1000000123:topic:10'])
    expect((await preview()).value).toBeNull()
    await sql('UPDATE channel_assistants SET external_surface_id=$2 WHERE channel_id=$1',[ids.channel,conversation])
    const competingAssistant=randomUUID()
    await sql("INSERT INTO assistants(id,workspace_id,clearance) VALUES($1,$2,'internal')",[competingAssistant,ids.workspace])
    await sql('UPDATE channel_assistants SET external_surface_id=$2 WHERE channel_id=$1',[ids.channel,'-1000000123'])
    await sql('INSERT INTO channel_assistants(channel_id,assistant_id,external_surface_id) VALUES($1,$2,$3)',[ids.channel,competingAssistant,conversation])
    expect((await preview()).value).toBeNull()
    await sql('DELETE FROM channel_assistants WHERE assistant_id=$1',[competingAssistant])
    await sql('UPDATE channel_assistants SET external_surface_id=$2 WHERE channel_id=$1',[ids.channel,conversation])
    const policy=randomUUID()
    await sql("INSERT INTO channel_recording_policies(id,integration_id,workspace_id,bot_id,owner_user_id,conversation_id,enabled) VALUES($1,$2,$3,'987654321',$4,$5,false)",[policy,ids.integration,ids.workspace,ids.actor,conversation])
    expect((await preview()).value).toBeNull()
    await sql('DELETE FROM channel_recording_policies WHERE id=$1',[policy])
    await sql('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[ids.workspace,ids.actor])
    expect((await preview()).value).toBeNull()
    await sql("INSERT INTO workspace_members VALUES($1,$2,'owner','confidential','{}')",[ids.workspace,ids.actor])
  })
  it('rolls back recorder, policy, transcript and receipt together if receipt persistence fails',async()=>{
    await db.exec(`CREATE FUNCTION fixture_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_write_failed'; END $$;
      CREATE TRIGGER fixture_reject_receipt BEFORE INSERT ON channel_recording_recovery_receipts FOR EACH ROW EXECUTE FUNCTION fixture_reject_receipt();`)
    const before=(await sql('SELECT count(*)::int AS count FROM sessions')).rows[0]
    await expect(apply(token(await preview()))).rejects.toThrow('fixture_write_failed')
    expect((await sql('SELECT count(*)::int AS count FROM sessions')).rows[0]).toEqual(before)
    expect((await sql('SELECT id FROM channel_recording_policies')).rows).toEqual([])
    expect((await sql('SELECT recording_owner_user_id FROM channel_integrations WHERE id=$1',[ids.integration])).rows[0]).toEqual({recording_owner_user_id:null})
    await db.exec('DROP TRIGGER fixture_reject_receipt ON channel_recording_recovery_receipts')
  })
  it('copies reviewed text into one Work epoch, leaves originals held and reconciles replay',async()=>{
    const original=(await sql('SELECT to_jsonb(s) AS value FROM sessions s WHERE id=$1',[ids.session])).rows[0]
    const originalMessages=(await sql('SELECT to_jsonb(m) AS value FROM session_messages m WHERE session_id=$1 ORDER BY sequence_num',[ids.session])).rows
    const review=token(await preview())
    await sql("UPDATE channel_integrations SET config=jsonb_set(config,'{seenChats}','[]'::jsonb) WHERE id=$1",[ids.integration])
    const result=(await apply(review)).value
    expect(result.sessionId).not.toBe(ids.session)
    expect((await sql('SELECT visibility,recording_privacy_held,recording_revision FROM sessions WHERE id=$1',[result.sessionId])).rows[0]).toEqual({visibility:'workspace',recording_privacy_held:false,recording_revision:1})
    const recovered=(await sql('SELECT role,content,channel_message_id FROM session_messages WHERE session_id=$1 ORDER BY sequence_num',[result.sessionId])).rows
    expect(recovered).toHaveLength(2)
    expect(JSON.stringify(recovered)).toContain('Fictional meeting on December 9.')
    expect(JSON.stringify(recovered)).not.toContain('PRIVATE_')
    expect((await sql('SELECT to_jsonb(s) AS value FROM sessions s WHERE id=$1',[ids.session])).rows[0]).toEqual(original)
    expect((await sql('SELECT to_jsonb(m) AS value FROM session_messages m WHERE session_id=$1 ORDER BY sequence_num',[ids.session])).rows).toEqual(originalMessages)
    expect((await apply(review)).value).toEqual(result)
    await expect(sql("UPDATE channel_recording_recovery_receipts SET snapshot_token='tampered'")).rejects.toThrow('recording_recovery_receipt_immutable')
  })
})
