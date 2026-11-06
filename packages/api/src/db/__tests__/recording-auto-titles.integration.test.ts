import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../client.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { resolveRecordingForFile } from '../../recordings/recording-for-file.js'
import { processOpenRecordingWithBookkeeping } from '../../recordings/process-recording.js'
import { createFilesApi } from '../../files/files-api.js'
import { getRecordingSystem, listRecordings, updateRecording } from '../recordings-store.js'
import { claimRecordingAutoTitle, commitRecordingAutoTitle, loadRecordingAutoTitle } from '../recording-auto-titles.js'
import { createDbSavedViewStore } from '../saved-views-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function fixture(shared = false) {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID()
  await pool.query("INSERT INTO users(id,auth_provider_id,timezone) VALUES($1::uuid,$1::text,'Asia/Singapore')", [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Topic title fixture',$2,false)", [workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Primary','primary','confidential')", [assistantId,workspaceId])
  const team = await createDbWorkspaceGroupStore().createTeam(userId,workspaceId,{name:'General',key:'general'})
  await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1", [workspaceId,team.id])
  await pool.query("INSERT INTO teamspaces(id,workspace_id,name,sensitivity,is_default,workspace_group_id,created_by) VALUES($1,$2,'General','internal',true,$3,$4)",[randomUUID(),workspaceId,team.id,userId])
  const store = createDbWorkspaceFilesStore()
  const file = await store.create(userId, { workspaceId,path:'/recording.wav',parentPath:'/',name:'recording.wav',mime:'audio/wav',sizeBytes:3,
    storageUri:'gs://fixture/recording',createdByUserId:userId,userId:shared?null:userId,sensitivity:shared?'internal':'confidential',compartments:shared?[`team:${team.id}`]:[],projectIds:[] })
  const adopted = await resolveRecordingForFile(file,userId)
  if (adopted.status!=='ok') throw new Error('fixture adoption failed')
  const storage = { signedReadUrl:async ()=>'https://fixture.example/media',writeBlob:async ()=>{},deleteBlob:async ()=>{} }
  const resolver = { forWorkspace:async ()=>({gcs:storage as never,bucket:'fixture',byo:true}),forUri:async ()=>storage as never }
  const filesApi = createFilesApi({resolver,store,auditStore:{append:async ()=>{}} as never})
  await processOpenRecordingWithBookkeeping({recordingId:adopted.recordingId,actingUserId:userId},{
    filesResolver:resolver,fallbackStorage:storage as never,filesApi,
    transcriber:{transcribe:async ()=>({utterances:[{startMs:0,endMs:1000,speaker:'Speaker 1',text:'The product launch needs a revised pricing plan and a schedule for the next release.'}],truncated:false})} as never,
    brainIngestor:(async ()=>({})) as never,probe:async ()=>1000,
    extract:async ()=>({buffer:Buffer.from('audio'),mime:'audio/wav'}),
  })
  const recording = await getRecordingSystem(adopted.recordingId)
  if (!recording?.transcriptFileId) throw new Error('fixture transcript missing')
  return {workspaceId,userId,assistantId,file,recording,store}
}

async function captured(f: Awaited<ReturnType<typeof fixture>>) {
  const candidate = await claimRecordingAutoTitle()
  expect(candidate?.recordingId).toBe(f.recording.id)
  const snapshot = await loadRecordingAutoTitle(candidate!)
  expect(snapshot?.segments).toHaveLength(1)
  return snapshot!
}

describe('[COMP:recordings/auto-title] current-source topic publication', () => {
  it('titles a notes page in the same scope while preserving a user-named sibling', async () => {
    const f = await fixture(true), snapshot = await captured(f), pages = createDbSavedViewStore()
    const created = []
    for (const nameOrigin of ['placeholder','user'] as const) {
      const page = await pages.createDraft({userId:f.userId,workspaceId:f.workspaceId,name:'Planning notes',nameOrigin,
        entity:'tasks',viewType:'table',binding:{entity:'tasks',viewType:'table'},page:{blocks:[]},state:'saved'},
      {provenance:{kind:'human-authored',actorId:f.userId}})
      await pool.query('UPDATE saved_views SET linked_recording_id=$2 WHERE id=$1',[page.id,f.recording.id])
      created.push(page.id)
    }
    const title = '2026-11-05 08:30 · Product launch planning'
    expect(await commitRecordingAutoTitle(snapshot,title)).toBe(true)
    expect((await pool.query('SELECT name FROM saved_views WHERE id=$1',[created[0]])).rows[0].name).toBe(title)
    expect((await pool.query('SELECT name FROM saved_views WHERE id=$1',[created[1]])).rows[0].name).toBe('Planning notes')
  })

  it('names the recording and both file displays while preserving original bytes, names, semantic versions and transcript access', async () => {
    const f = await fixture(), snapshot = await captured(f)
    const title = '2026-11-05 08:30 · Product launch planning'
    const before = (await pool.query('SELECT id,scope_version::text,scope_held FROM workspace_files WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows
    const episode = (await pool.query('SELECT source_ref,scope_version::text FROM episodes WHERE id=$1',[f.recording.id])).rows[0]
    expect(await commitRecordingAutoTitle(snapshot,title)).toBe(true)
    expect(await getRecordingSystem(f.recording.id)).toMatchObject({title,fileName:'recording.wav',mediaFileId:f.file.id})
    for (const [id,expected] of [[f.file.id,title],[f.recording.transcriptFileId,`${title} · Transcript`]]) {
      const file = await f.store.getById({workspaceId:f.workspaceId,userId:f.userId,assistantId:f.assistantId,assistantKind:'primary',clearance:'confidential',compartments:[]},id!)
      expect(file?.title).toBe(expected)
    }
    expect((await pool.query('SELECT id,scope_version::text,scope_held FROM workspace_files WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows).toEqual(before)
    expect((await pool.query('SELECT source_ref,scope_version::text FROM episodes WHERE id=$1',[f.recording.id])).rows[0]).toEqual(episode)
    expect((await pool.query('SELECT scope_held FROM transcript_segments WHERE recording_id=$1',[f.recording.id])).rows).toEqual([{scope_held:false}])
    expect(await commitRecordingAutoTitle(snapshot,title)).toBe(false)
    const ctx={workspaceId:f.workspaceId,userId:f.userId,assistantId:f.assistantId,assistantKind:'primary' as const,clearance:'confidential' as const,compartments:[]}
    expect((await listRecordings(ctx,f.workspaceId,{q:'launch'})).map(row=>row.id)).toEqual([f.recording.id])
    expect((await f.store.searchByText(ctx,{query:'launch'})).map(row=>row.id).sort())
      .toEqual([f.file.id,f.recording.transcriptFileId].sort())
  })

  it.each(['source','segment','membership','rename'] as const)('refuses stale AI output after a concurrent %s change', async change => {
    const f = await fixture(), snapshot = await captured(f)
    if(change==='source') await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[f.file.id])
    if(change==='segment') await pool.query("UPDATE transcript_segments SET segment_text='Updated topic' WHERE recording_id=$1",[f.recording.id])
    if(change==='membership') await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    if(change==='rename') await updateRecording(f.recording.id,{title:'My chosen title'})
    await expect(commitRecordingAutoTitle(snapshot,'2026-11-05 08:30 · Stale topic')).rejects.toThrow()
    expect((await pool.query('SELECT generated_title FROM recordings WHERE id=$1',[f.recording.id])).rows[0].generated_title).toBeNull()
  })

  it('does not disclose a private subject to a broader linked notes page or replace an explicitly titled transcript', async () => {
    const f = await fixture(), snapshot = await captured(f)
    const page = await createDbSavedViewStore().createDraft({userId:f.userId,workspaceId:f.workspaceId,name:'Meeting notes',nameOrigin:'placeholder',entity:'tasks',viewType:'table',binding:{entity:'tasks',viewType:'table'},page:{blocks:[]},state:'saved'},
      {provenance:{kind:'human-authored',actorId:f.userId}})
    await pool.query('UPDATE saved_views SET linked_recording_id=$2 WHERE id=$1',[page.id,f.recording.id])
    // A file rename invalidates the renamed file's own descendants, but not
    // its recording parent. It must win independently of the recording title.
    await pool.query("UPDATE workspace_files SET title='My reviewed transcript' WHERE id=$1",[f.recording.transcriptFileId])
    expect(await commitRecordingAutoTitle(snapshot,'2026-11-05 08:30 · Private launch plans')).toBe(true)
    expect((await pool.query('SELECT name FROM saved_views WHERE id=$1',[page.id])).rows[0].name).toBe('Meeting notes')
    expect((await pool.query('SELECT title,generated_title FROM workspace_files WHERE id=$1',[f.recording.transcriptFileId])).rows[0])
      .toEqual({title:'My reviewed transcript',generated_title:null})
  })

  it('stops automatic attempts after three claims and lets a later manual file title replace the display title', async () => {
    const f = await fixture()
    for (let attempt=1;attempt<=3;attempt++) {
      expect(await claimRecordingAutoTitle()).toMatchObject({recordingId:f.recording.id,attempt})
      await pool.query('UPDATE recordings SET auto_title_retry_at=now() WHERE id=$1',[f.recording.id])
    }
    expect(await claimRecordingAutoTitle()).toBeNull()
    await pool.query("UPDATE workspace_files SET generated_title='Automatic display' WHERE id=$1",[f.file.id])
    await pool.query("UPDATE workspace_files SET title='Chosen display' WHERE id=$1",[f.file.id])
    expect((await pool.query('SELECT generated_title FROM workspace_files WHERE id=$1',[f.file.id])).rows[0].generated_title).toBeNull()
  })
})
