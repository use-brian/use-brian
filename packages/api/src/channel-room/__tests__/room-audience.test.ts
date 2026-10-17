import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { admitRoomInputScope, resolveRoomBinding } from '../room.js'
import { admitChannelRoom } from '../../workspace-access/session-create-admission.js'

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }))
vi.mock('../../db/client.js', () => ({ query: sql }))

const W='11111111-1111-4111-8111-111111111111'
const A='22222222-2222-4222-8222-222222222222'
const B='33333333-3333-4333-8333-333333333333'
const U='44444444-4444-4444-8444-444444444444'
const G='55555555-5555-4555-8555-555555555555'
const P='66666666-6666-4666-8666-666666666666'

describe('[COMP:api/channel-room] authoritative group classification (PostgreSQL)', () => {
  it('uses approved group labels and valid room bindings independently of the first bot', async () => {
    const db=new PGlite()
    try {
      await db.exec(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE workspace_groups(id uuid,workspace_id uuid,compartment_key text,kind text,status text);
        CREATE TABLE workspace_projects(id uuid,workspace_id uuid);
        CREATE TABLE assistants(id uuid,workspace_id uuid,clearance text,placement_department_id uuid);
        CREATE TABLE channels(id text,workspace_id uuid,status text);
        CREATE TABLE channel_integrations(id text,channel_id text,channel_type text,status text,config jsonb);
        CREATE TABLE workspace_members(user_id uuid,workspace_id uuid,role text);
        CREATE TABLE workspace_access_policies(workspace_id uuid,access_mode text,setup_state text,revision integer,default_department_id uuid);`)
      await db.query('INSERT INTO workspaces VALUES($1)',[W])
      await db.query("INSERT INTO workspace_groups VALUES($1,$2,'team:finance','team','active')",[G,W])
      await db.query('INSERT INTO workspace_projects VALUES($1,$2)',[P,W])
      await db.query("INSERT INTO assistants VALUES($1,$3,'confidential',NULL),($2,$3,'public',NULL)",[A,B,W])
      await db.query("INSERT INTO channels VALUES('first',$1,'active'),('second',$1,'active')",[W])
      await db.query("INSERT INTO workspace_members VALUES($1,$2,'admin')",[U,W])
      const binding={version:1,channelId:'-100',audienceType:'group',clearance:'internal',compartments:['team:finance'],projectIds:[P],
        recipientUserId:null,expiresAt:null,approvedByUserId:U,approvedAt:'2026-10-17T00:00:00Z'}
      await db.query("INSERT INTO channel_integrations VALUES('integration','first','telegram','active',$1),('other','second','telegram','active','{}')",[JSON.stringify({deliveryAudienceBindings:[binding]})])
      for(const assistantId of [A,B]) {
        const result=await admitChannelRoom(db as unknown as PoolClient,{assistantId,userId:U,workspaceId:W,channelType:'telegram',channelId:'-100:topic:7',channelIntegrationId:'integration'})
        expect(result).toEqual({effectiveClearance:'internal',contextGroupId:G,contextProjectId:P,contextCompartments:['team:finance']})
      }
      await db.query("UPDATE workspace_members SET role='member'")
      await expect(admitChannelRoom(db as unknown as PoolClient,{assistantId:A,userId:U,workspaceId:W,channelType:'telegram',channelId:'-100:topic:7',channelIntegrationId:'integration'})).rejects.toThrow('context_not_available')
    } finally { await db.close() }
  })
})


it('[COMP:api/channel-room] raises the web read floor without downgrading old history or changing its Department', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE sessions(id text,effective_clearance text,clearance_source text);
      CREATE FUNCTION sensitivity_rank(t text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT CASE t WHEN 'public' THEN 1 WHEN 'internal' THEN 2 ELSE 3 END $$;
      INSERT INTO sessions VALUES('room','internal','assistant');`)
    sql.mockImplementation((text: string,args: unknown[]) => db.query(text,args))
    const room = { id:'room', effectiveClearance:'internal', contextCompartments:['finance'], contextProjectId:null } as never
    const scope = { workspaceId:'workspace', userId:null, assistantId:null, sensitivity:'confidential' as const, compartments:['finance'], projectIds:[] }
    await admitRoomInputScope(room,{...scope,sensitivity:'internal'})
    expect((await db.query('SELECT clearance_source FROM sessions')).rows).toEqual([{clearance_source:'anchor'}])
    await admitRoomInputScope(room,scope)
    await admitRoomInputScope(room,{...scope,sensitivity:'public'})
    expect((await db.query('SELECT effective_clearance FROM sessions')).rows).toEqual([{effective_clearance:'confidential'}])
    await expect(admitRoomInputScope(room,{...scope,compartments:['marketing']})).rejects.toThrow('context_not_available')
    sql.mockRejectedValue(new Error('database unavailable'))
    await expect(resolveRoomBinding({assistant:{id:'a',workspaceId:'w'},isGroupChat:true,channelType:'telegram',channelIntegrationId:'i'})).rejects.toThrow('database unavailable')
  } finally { await db.close() }
})


it('[COMP:api/channel-room] a Department bot does not classify a provider room, while ordinary web sharing retains its guard', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
      CREATE TABLE assistants(id uuid, placement_department_id uuid);
      CREATE TABLE workspace_groups(id uuid, compartment_key text);
      CREATE TABLE sessions(assistant_id uuid,user_id uuid,visibility text,anchor_kind text,context_compartments text[]);
      CREATE FUNCTION assistant_placement_visible(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;`)
    await db.query('INSERT INTO assistants VALUES($1,$2)', [A,G])
    await db.query("INSERT INTO workspace_groups VALUES($1,'finance')", [G])
    const prior = await readFile(new URL('../../../migrations/741_unified_session_kind.sql', import.meta.url), 'utf8')
    const start = prior.indexOf('CREATE OR REPLACE FUNCTION public.guard_department_assistant_sharing()')
    await db.exec(prior.slice(start, prior.indexOf('END $function$;', start) + 'END $function$;'.length))
    await db.exec('CREATE TRIGGER placement BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION guard_department_assistant_sharing()')
    const insert = (anchor: string, compartments: string[]) => db.query(
      "INSERT INTO sessions VALUES($1,$2,'workspace',$3,$4)", [A,U,anchor,compartments])
    // The old trigger inherited the first bot's Department even for General groups.
    await expect(insert('channel', [])).rejects.toThrow('department_assistant_requires_private_access')
    await db.exec(await readFile(new URL('../../../migrations/772_channel_media_receipts.sql', import.meta.url), 'utf8'))
    await expect(insert('channel', [])).resolves.toBeDefined()
    await expect(insert('none', [])).rejects.toThrow('department_assistant_requires_private_access')
    await expect(insert('none', ['finance'])).resolves.toBeDefined()
  } finally { await db.close() }
})
