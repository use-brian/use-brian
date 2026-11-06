import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'

const database = vi.hoisted(() => ({ current: null as PGlite | null }))
vi.mock('../db/client.js', () => ({
  getPool: () => database.current,
  query: (sql: string, values?: unknown[]) => database.current!.query(sql, values),
  queryWithRLS: (_actor: string, sql: string, values?: unknown[]) => database.current!.query(sql, values),
}))
import { recoverTelegramRecordingOwner } from '../channel-recording-owner.js'
import { createDbChannelIntegrationStore } from '../db/channel-integrations.js'

describe('[COMP:api/channel-recording] authenticated connector recovery across upgrades', () => {
  const db = new PGlite()
  const owner = randomUUID(), other = randomUUID(), workspace = randomUUID()
  const store = createDbChannelIntegrationStore(randomBytes(32))
  let provenLegacy: string, unknownLegacy: string
  const execute = db as unknown as Pick<PoolClient, 'query'>

  async function seed(recorder: string | null = null) {
    const channel = randomUUID(), integration = randomUUID()
    await db.query("INSERT INTO channels VALUES($1,$2,'active')", [channel, workspace])
    await db.query(`INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id,recording_owner_user_id)
      VALUES($1,$2,'telegram','\\x00'::bytea,'123456',$3)`, [integration, channel, recorder])
    return integration
  }
  async function row(id: string) {
    return (await db.query<{ recording_owner_user_id: string | null; connected_by_user_id: string | null;
      connected_workspace_id: string | null; connected_bot_user_id: string | null }>(
      'SELECT * FROM channel_integrations WHERE id=$1', [id])).rows[0]
  }
  beforeAll(async () => {
    database.current = db
    await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE workspaces(id uuid PRIMARY KEY);
      CREATE TABLE workspace_members(workspace_id uuid, user_id uuid);
      CREATE TABLE channels(id uuid PRIMARY KEY,workspace_id uuid,status text);
      CREATE TABLE channel_integrations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),channel_id uuid UNIQUE,
        channel_type text,credentials bytea,team_id text,team_name text,bot_user_id text,bot_username text,
        status text DEFAULT 'active',config jsonb DEFAULT '{}',created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),last_event_at timestamptz,connector_instance_id uuid,
        recording_owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL);
      CREATE TABLE channel_recording_policies(integration_id uuid,enabled boolean);
      CREATE TABLE channel_user_cache(assistant_id uuid);
      CREATE TABLE channel_assistants(assistant_id uuid,channel_id uuid);`)
    await db.query('INSERT INTO users VALUES($1),($2)',[owner,other])
    await db.query('INSERT INTO workspaces VALUES($1)',[workspace])
    await db.query('INSERT INTO workspace_members VALUES($1,$2),($1,$3)',[workspace,owner,other])
    provenLegacy = await seed(owner)
    unknownLegacy = await seed()
    await db.exec('CREATE ROLE recording_test_app; GRANT CREATE ON SCHEMA public TO recording_test_app')
    for (const table of ['users','workspaces','workspace_members','channels','channel_integrations',
      'channel_recording_policies','channel_user_cache','channel_assistants']) {
      await db.exec(`ALTER TABLE ${table} OWNER TO recording_test_app`)
    }
    await db.exec('SET ROLE recording_test_app')
    // Both the migration and runtime SQL execute as an ordinary table owner.
    await db.exec(await readFile(new URL('../../migrations/8240_channel_connection_provenance.sql', import.meta.url),'utf8'))
  })
  afterAll(async () => { database.current = null; await db.close() })

  it('migrates verified assignments without inventing attribution for an unknown legacy bot', async () => {
    expect(await row(provenLegacy)).toMatchObject({connected_by_user_id:owner,connected_workspace_id:workspace,connected_bot_user_id:'123456'})
    await recoverTelegramRecordingOwner(unknownLegacy,execute)
    expect(await row(unknownLegacy)).toMatchObject({recording_owner_user_id:null,connected_by_user_id:null})
  })
  it('recovers the authenticated connector once, preserving stopped policies and explicit owners',async()=>{
    await db.query('UPDATE channel_integrations SET recording_owner_user_id=NULL WHERE id=$1',[provenLegacy])
    await db.query('INSERT INTO channel_recording_policies VALUES($1,false)',[provenLegacy])
    await recoverTelegramRecordingOwner(provenLegacy,execute)
    await recoverTelegramRecordingOwner(provenLegacy,execute)
    expect((await row(provenLegacy)).recording_owner_user_id).toBe(owner)
    expect((await db.query('SELECT enabled FROM channel_recording_policies WHERE integration_id=$1',[provenLegacy])).rows).toEqual([{enabled:false}])
    await db.query('UPDATE channel_integrations SET recording_owner_user_id=$2 WHERE id=$1',[provenLegacy,other])
    await recoverTelegramRecordingOwner(provenLegacy,execute)
    expect((await row(provenLegacy)).recording_owner_user_id).toBe(other)
  })
  it.each(['departed','different workspace','different bot','revoked integration','revoked channel'])(
    'does not recover from %s provenance',async(kind)=>{
      const id = await seed()
      await db.query(`UPDATE channel_integrations SET connected_by_user_id=$2,connected_workspace_id=$3,
        connected_bot_user_id='123456' WHERE id=$1`,[id,owner,workspace])
      if (kind==='departed') await db.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
      if (kind==='different workspace') {
        const foreignWorkspace = randomUUID()
        await db.query('INSERT INTO workspaces VALUES($1)',[foreignWorkspace])
        await db.query('INSERT INTO workspace_members VALUES($1,$2)',[foreignWorkspace,owner])
        await db.query('UPDATE channel_integrations SET connected_workspace_id=$2 WHERE id=$1',[id,foreignWorkspace])
      }
      if (kind==='different bot') await db.query("UPDATE channel_integrations SET bot_user_id='654321' WHERE id=$1",[id])
      if (kind==='revoked integration') await db.query("UPDATE channel_integrations SET status='revoked' WHERE id=$1",[id])
      if (kind==='revoked channel') await db.query("UPDATE channels SET status='revoked' WHERE id=(SELECT channel_id FROM channel_integrations WHERE id=$1)",[id])
      try {
        await recoverTelegramRecordingOwner(id,execute)
        expect((await row(id)).recording_owner_user_id).toBeNull()
      } finally {
        if(kind==='departed') await db.query('INSERT INTO workspace_members VALUES($1,$2)',[workspace,owner])
      }
    })
  it('retains the original authenticated connector through another member reconnecting',async()=>{
    const channel = randomUUID()
    await db.query("INSERT INTO channels VALUES($1,$2,'active')",[channel,workspace])
    const connect = (actingUserId:string)=>store.upsert({channelId:channel,channelType:'telegram',teamId:null,
      teamName:null,botUserId:'123456',botUsername:'sample_bot',credentials:{bot_token:'synthetic',webhook_secret:'synthetic'},actingUserId})
    const created=await connect(owner)
    await db.query('UPDATE channel_integrations SET recording_owner_user_id=NULL WHERE id=$1',[created.id])
    await connect(other)
    expect((await row(created.id)).connected_by_user_id).toBe(owner)
    await recoverTelegramRecordingOwner(created.id,execute)
    expect((await row(created.id)).recording_owner_user_id).toBe(owner)
  })
  it('does not attribute an unknown legacy installation to a reconnecting member',async()=>{
    const id=await seed()
    const channel=(await db.query<{channel_id:string}>('SELECT channel_id FROM channel_integrations WHERE id=$1',[id])).rows[0].channel_id
    await store.upsert({channelId:channel,channelType:'telegram',teamId:null,teamName:null,botUserId:'123456',botUsername:null,
      credentials:{bot_token:'synthetic',webhook_secret:'synthetic'},actingUserId:other})
    await recoverTelegramRecordingOwner(id,execute)
    expect(await row(id)).toMatchObject({connected_by_user_id:null,recording_owner_user_id:null})
  })
})
