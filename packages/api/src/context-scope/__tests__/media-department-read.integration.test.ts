/** Migration 735: recordings, transcript and file segments, and file_cache follow the v2 department floor. */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, query, queryWithRLS } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:access/predicate-parity] Media and segment department floor', () => {
  it('hides another department\'s recordings, transcripts, file segments and cached files, an owner without an edge included', async () => {
    const workspace = randomUUID(), owner = randomUUID(), member = randomUUID(), custodian = randomUUID(), cedar = randomUUID()
    for (const user of [owner, member, custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id,department_read_v2) VALUES($1,'Fictional media fixture','test',$2,true)", [workspace, owner])
    for (const [user, role] of [[owner, 'owner'], [member, 'member'], [custodian, 'member']]) await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')", [workspace, user, role])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)", [cedar, workspace, custodian, `team:${cedar}`])
    await query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)", [workspace, `team:${cedar}`, cedar])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [workspace, cedar, member])
    const labels = [`team:${cedar}`]

    const recording = (await query<{ id: string }>(`INSERT INTO episodes(source_kind,source_ref,occurred_at,workspace_id,created_by_user_id,sensitivity,compartments)
      VALUES('recording','{}'::jsonb,now(),$1,$2,'internal',$3) RETURNING id`, [workspace, custodian, labels])).rows[0].id
    await query(`INSERT INTO recordings(id,workspace_id,title,mime,gcs_key,sensitivity,compartments,created_by_user_id,kind,status)
      VALUES($1,$2,'Fictional Cedar standup','audio/mp4','fictional/key','internal',$3,$4,'meeting','processed')`, [recording, workspace, labels, custodian])
    await query(`INSERT INTO transcript_segments(workspace_id,recording_id,segment_index,start_ms,end_ms,segment_text,created_by_user_id,sensitivity,compartments)
      VALUES($1,$2,0,0,1000,'Fictional Cedar transcript line',$3,'internal',$4)`, [workspace, recording, custodian, labels])
    const file = (await query<{ id: string }>(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,sensitivity,compartments)
      VALUES($1,'/fictional/cedar.txt','cedar.txt','fictional://cedar','internal',$2) RETURNING id`, [workspace, labels])).rows[0].id
    await query(`INSERT INTO file_segments(workspace_id,file_id,segment_index,char_start,char_end,content,created_by_user_id,sensitivity,compartments)
      VALUES($1,$2,0,0,10,'Fictional Cedar segment',$3,'internal',$4)`, [workspace, file, custodian, labels])
    const session = randomUUID(), assistant = randomUUID()
    await query("INSERT INTO assistants(id,name,workspace_id,kind,clearance,owner_user_id) VALUES($1,'Fictional primary',$2,'primary','confidential',$3)", [assistant, workspace, owner])
    await query(`INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,status,visibility) VALUES($1::uuid,$2,$3,$4,'web',$1::text,'idle','owner')`, [session, workspace, assistant, member])
    await query(`INSERT INTO file_cache(session_id,file_name,mime_type,content,size_bytes,expires_at,workspace_id,user_id,sensitivity,compartments)
      VALUES($1,'cedar.txt','text/plain','Fictional Cedar cache',21,now()+interval '1 hour',$2,$3,'internal',$4)`, [session, workspace, member, labels])

    const visible = async (user: string) => {
      const count = async (sql: string) => Number((await queryWithRLS<{ n: string }>(user, sql, [workspace])).rows[0].n)
      return {
        recordings: await count('SELECT count(*)::text AS n FROM recordings WHERE workspace_id=$1'),
        transcripts: await count('SELECT count(*)::text AS n FROM transcript_segments WHERE workspace_id=$1'),
        fileSegments: await count('SELECT count(*)::text AS n FROM file_segments WHERE workspace_id=$1'),
        fileCache: await count('SELECT count(*)::text AS n FROM file_cache WHERE workspace_id=$1'),
      }
    }

    expect(await visible(member)).toEqual({ recordings: 1, transcripts: 1, fileSegments: 1, fileCache: 1 })
    // Owner/admin role grants no edge.
    expect(await visible(owner)).toMatchObject({ recordings: 0, transcripts: 0, fileSegments: 0 })

    await query("UPDATE department_edges SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2", [workspace, member])
    expect(await visible(member)).toEqual({ recordings: 0, transcripts: 0, fileSegments: 0, fileCache: 0 })

    // A legacy workspace is unchanged: the v2 policy passes.
    await query('UPDATE workspaces SET department_read_v2=false WHERE id=$1', [workspace])
    expect((await visible(member)).recordings).toBe(1)
  })
})
