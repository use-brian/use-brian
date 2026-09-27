import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AccessContext, FilesContext } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { applyBrainCorrection } from '../brain-inbox-store.js'
import { updateWorkspaceFileMeta } from '../workspace-files.js'
import { createFilesApi } from '../../files/files-api.js'
import type { GcsFilesClient } from '../../files/gcs-client.js'
import { parseStorageKey } from '../../files/gcs-client.js'
import { runWithAgentAccess } from '../agent-access-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), projectId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'File mutation fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')", [assistantId, workspaceId, userId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)", [projectId, workspaceId, userId])
  const ctx: FilesContext = { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential',
    compartments: ['product', 'other'], mutationCompartments: ['product', 'other'], projectIds: [projectId],
    writeCompartments: ['product'], writeProjectIds: [projectId] }
  const access: AccessContext = { ...ctx, assistantId, assistantKind: 'standard' }
  const blobs = new Map<string, Buffer>()
  const gcs = {
    writeBlob: vi.fn(async (key: string, bytes: Buffer) => { blobs.set(key, Buffer.from(bytes)) }),
    readBlob: vi.fn(async (key: string) => { const bytes = blobs.get(key); return bytes ? { bytes, mime: 'text/plain', metadata: {} } : null }),
    deleteBlob: vi.fn(async (key: string) => { blobs.delete(key) }),
  } as unknown as GcsFilesClient
  const store = createDbWorkspaceFilesStore()
  const api = createFilesApi({ gcs, store, auditStore: { append: vi.fn(async () => {}) } as never, bucket: 'fixture-bucket' })
  const written = await api.write(ctx, { path: '/fixture.txt', content: 'original', sensitivity: 'internal' })
  if (!written.ok) throw new Error('fixture creation failed')
  const file = written.value
  await pool.query(`INSERT INTO file_segments(workspace_id,file_id,segment_index,char_start,char_end,content,created_by_user_id,compartments,project_ids)
    VALUES($1,$2,0,0,8,'original',$3,$4,$5)`, [workspaceId, file.id, userId, ['product'], [projectId]])
  const raw = async () => (await pool.query('SELECT id,title,storage_uri,compartments,scope_version::text,valid_to,superseded_by FROM workspace_files WHERE workspace_id=$1 ORDER BY created_at,id', [workspaceId])).rows
  const patch = { editorUserId: userId, expectedScopeVersion: file.scopeVersion, storageUri: `gs://fixture-bucket/${workspaceId}/${randomUUID()}`, sizeBytes: 9 }
  return { workspaceId, userId, assistantId, projectId, ctx, access, blobs, gcs, store, api, file, raw, patch }
}

describe('[COMP:api/file-mutation-scope] immutable file publication and canonical writers', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it.each(['none', 'explicit', 'ambient'] as const)('checks current-member file authority with %s execution context', async mode => {
    const f = await fixture(), member = randomUUID(), groups = createDbWorkspaceGroupStore()
    const team = await groups.createTeam(f.userId, f.workspaceId, { name: 'Product fixture', key: 'product-fixture' })
    const key = team.compartmentKey!
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,'member','assigned')", [f.workspaceId,member])
    await pool.query('UPDATE workspace_files SET compartments=$2 WHERE id=$1', [f.file.id,[key]])
    const ctx = { ...f.access, userId: member, compartments: [key], mutationCompartments: [key] }
    const access = mode === 'explicit' ? ctx : undefined
    const client = await pool.connect()
    const run = <T,>(fn: () => Promise<T>) => mode === 'ambient' ? runWithAgentAccess({ ...ctx, clearance: ctx.clearance },fn) : fn()
    const replacement = { ...f.patch, editorUserId: member, expectedScopeVersion: undefined }
    const denied = async () => run(async () => {
      await client.query('BEGIN')
      expect(await updateWorkspaceFileMeta(member,f.workspaceId,f.file.id,{title:'Refused'},client,access)).toBeNull()
      expect(await updateWorkspaceFileMeta(member,f.workspaceId,f.file.id,{},client,access)).toBeNull()
      await client.query('COMMIT')
      expect(await f.store.updateSize(member,f.workspaceId,f.file.id,100,{},access)).toBeNull()
      expect(await f.store.delete(member,f.workspaceId,f.file.id,access)).toBe(false)
      expect(await f.store.supersede(member,f.workspaceId,f.file.id,replacement,access)).toBeNull()
    })
    try {
      await denied()
      await groups.addMember(f.userId,team.id,member)
      await client.query('BEGIN')
      expect(await run(() => updateWorkspaceFileMeta(member,f.workspaceId,f.file.id,{title:'Authorized'},client,access))).toMatchObject({title:'Authorized'})
      await client.query('COMMIT')
      await pool.query("UPDATE workspace_files SET sensitivity='confidential' WHERE id=$1", [f.file.id])
      await denied()
      await pool.query("UPDATE workspace_files SET sensitivity='internal',user_id=$2 WHERE id=$1", [f.file.id,f.userId])
      await denied()
      await pool.query('UPDATE workspace_files SET user_id=NULL WHERE id=$1', [f.file.id])
      await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2', [team.id,member])
      await denied()
      expect(await f.raw()).toMatchObject([{title:'Authorized',valid_to:null}])
      expect((await pool.query('SELECT valid_to FROM file_segments WHERE file_id=$1',[f.file.id])).rows).toEqual([{valid_to:null}])
    } finally { await client.query('ROLLBACK'); client.release() }
  })

  it.each([false,true])('checks member destination Teams when creating a file with explicit id=%s', async explicitId => {
    const f=await fixture(), member=randomUUID(), groups=createDbWorkspaceGroupStore()
    const team=await groups.createTeam(f.userId,f.workspaceId,{name:'Product fixture',key:'product-fixture'})
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,'member','assigned')",[f.workspaceId,member])
    const input={...(explicitId?{id:randomUUID()}:{}),workspaceId:f.workspaceId,path:'/member.txt',parentPath:'/',name:'member.txt',mime:'text/plain',sizeBytes:1,storageUri:f.file.storageUri,compartments:[team.compartmentKey!],createdByUserId:member}
    await expect(f.store.create(member,input)).rejects.toMatchObject({code:'scope_operation_denied'})
    await groups.addMember(f.userId,team.id,member)
    const created=await f.store.create(member,input)
    expect(created).toMatchObject({compartments:[team.compartmentKey!]})
    const other=await groups.createTeam(f.userId,f.workspaceId,{name:'Research fixture',key:'research-fixture'})
    expect(await f.store.updateMeta(member,f.workspaceId,created.id,{title:'Refused',inheritCompartments:[other.compartmentKey!]})).toBeNull()
    expect(await f.store.updateSize(member,f.workspaceId,created.id,100,{compartments:[other.compartmentKey!]})).toBeNull()
    await expect(f.store.supersede(member,f.workspaceId,created.id,{...f.patch,editorUserId:member,expectedScopeVersion:undefined,compartments:[other.compartmentKey!]})).rejects.toMatchObject({code:'scope_operation_denied'})
    expect((await pool.query('SELECT title,size_bytes,valid_to FROM workspace_files WHERE id=$1',[created.id])).rows).toEqual([{title:null,size_bytes:'1',valid_to:null}])
  })

  it('rolls back refused file downgrades without a false correction receipt or lower segment',async()=>{
    const f=await fixture()
    await pool.query("UPDATE file_segments SET sensitivity='confidential' WHERE file_id=$1",[f.file.id])
    await expect(applyBrainCorrection({
      mutate:client=>updateWorkspaceFileMeta(f.userId,f.workspaceId,f.file.id,{title:'Refused',sensitivity:'public'},client),
      verifications:()=>[{targetKind:'workspace_file',targetId:f.file.id,workspaceId:f.workspaceId,verifiedByUserId:f.userId,action:'adjust_sensitivity',modelValue:'internal',userValue:'public'}],
    })).rejects.toMatchObject({code:'scope_declassification_required'})
    expect((await pool.query('SELECT count(*)::int AS count FROM brain_verifications WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{count:0}])
    expect(await f.raw()).toMatchObject([{title:null,valid_to:null}])
    expect(await f.store.updateMeta(f.userId,f.workspaceId,f.file.id,{sensitivity:'internal'})).toMatchObject({sensitivity:'internal'})
    expect((await pool.query('SELECT sensitivity FROM file_segments WHERE file_id=$1',[f.file.id])).rows).toEqual([{sensitivity:'confidential'}])
  })

  it('publishes appended bytes and closes prior segments in one canonical supersession', async () => {
    const f = await fixture()
    const result = await f.api.append({ ...f.ctx, writeSensitivity: 'confidential', writeCompartments: ['other'] }, f.file.id, ' new')
    expect(result).toMatchObject({ ok: true, value: { sensitivity: 'confidential', compartments: ['other', 'product'] } })
    if (!result.ok) throw new Error('append failed')
    expect(f.blobs.get(parseStorageKey(f.file.storageUri))!.toString()).toBe('original')
    expect(f.blobs.get(parseStorageKey(result.value.storageUri))!.toString()).toBe('original new')
    expect((await f.raw()).find(row => row.id === f.file.id)).toMatchObject({ superseded_by: result.value.id, valid_to: expect.any(Date) })
    expect((await pool.query('SELECT valid_to FROM file_segments WHERE file_id=$1', [f.file.id])).rows[0].valid_to).toBeInstanceOf(Date)
    expect(result.value.scopeVersion).toBe('1')
  })

  it('allows only one concurrent append and never overwrites historical bytes', async () => {
    const f = await fixture(), write = f.gcs.writeBlob.bind(f.gcs)
    let arrivals = 0, release!: () => void
    const both = new Promise<void>(resolve => { release = resolve })
    f.gcs.writeBlob = async (...args) => { await write(...args); if (++arrivals === 2) release(); await both }
    const results = await Promise.all([f.api.append(f.ctx, f.file.id, ' A'), f.api.append(f.ctx, f.file.id, ' B')])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.find(result => !result.ok)).toMatchObject({ error: { kind: 'conflict', reason: 'changed' } })
    expect((await f.raw()).filter(row => row.valid_to === null)).toHaveLength(1)
    expect(f.blobs.size).toBe(2)
    expect(f.blobs.get(parseStorageKey(f.file.storageUri))!.toString()).toBe('original')
  })

  it('refuses stale publication after source reclassification without touching old bytes', async () => {
    const f = await fixture(), write = f.gcs.writeBlob.bind(f.gcs)
    f.gcs.writeBlob = async (...args) => {
      await write(...args)
      await pool.query("UPDATE workspace_files SET sensitivity='confidential' WHERE id=$1", [f.file.id])
    }
    expect(await f.api.append(f.ctx, f.file.id, ' new')).toMatchObject({ ok: false, error: { kind: 'conflict' } })
    expect(await f.raw()).toHaveLength(1)
    expect([...f.blobs.values()].map(bytes => bytes.toString())).toEqual(['original'])
  })

  it('retains a committed successor after a lost database acknowledgement', async () => {
    const f = await fixture(), supersede = f.store.supersede.bind(f.store)
    f.store.supersede = async (...args) => { await supersede(...args); throw new Error('lost acknowledgement') }
    await expect(f.api.append(f.ctx, f.file.id, ' new')).rejects.toMatchObject({ code: 'file_publication_uncertain', retrySafe: false })
    expect(await f.api.read(f.ctx, '/fixture.txt')).toMatchObject({ ok: true, value: { content: 'original new' } })
    expect(f.blobs.size).toBe(2)
  })

  it('checks read-only reach at the canonical metadata, delete and supersession writers', async () => {
    const f = await fixture(), readOnly = { ...f.access, mutationCompartments: [] }
    expect(await f.store.updateMeta(f.userId, f.workspaceId, f.file.id, { title: 'Denied' }, readOnly)).toBeNull()
    expect(await f.store.delete(f.userId, f.workspaceId, f.file.id, readOnly)).toBe(false)
    expect(await f.store.supersede(f.userId, f.workspaceId, f.file.id, f.patch, readOnly)).toBeNull()
    expect(await f.raw()).toMatchObject([{ title: null, valid_to: null }])
    await runWithAgentAccess({ ...f.ctx, clearance: 'confidential', compartments: f.ctx.compartments, mutationCompartments: [] }, async () => {
      expect(await f.store.supersede(f.userId, f.workspaceId, f.file.id, f.patch)).toBeNull()
    })
  })

  it('checks supplied owner transactions and rolls back metadata plus segments together', async () => {
    const f = await fixture(), client = await pool.connect()
    try {
      await client.query('BEGIN')
      expect(await updateWorkspaceFileMeta(f.userId, f.workspaceId, f.file.id, { title: 'Denied' }, client,
        { ...f.access, mutationCompartments: [] })).toBeNull()
      await client.query('ROLLBACK')
    } finally { client.release() }
    const name = `fixture_segments_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${f.workspaceId}'::uuid THEN RAISE EXCEPTION 'fixture segment refusal'; END IF;
      RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON file_segments FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try {
      await expect(f.store.updateMeta(f.userId, f.workspaceId, f.file.id, { title: 'Changed', inheritCompartments: ['other'] }, f.access)).rejects.toThrow('fixture segment refusal')
      expect(await f.raw()).toMatchObject([{ title: null, compartments: ['product'], scope_version: f.file.scopeVersion }])
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON file_segments`)
      await pool.query(`DROP FUNCTION ${name}()`)
    }
    expect(await f.store.updateMeta(f.userId, f.workspaceId, f.file.id, { title: 'Updated', inheritCompartments: ['other'] }, f.access)).toMatchObject({ title: 'Updated', compartments: ['other', 'product'] })
    expect((await pool.query('SELECT compartments FROM file_segments WHERE file_id=$1', [f.file.id])).rows[0].compartments).toEqual(['other', 'product'])
  })

  it.each(['held', 'retracted', 'historical'] as const)('refuses the %s source at every mutation entry point', async state => {
    const f = await fixture()
    const updates = { held: 'scope_held=true', retracted: 'retracted_at=now()', historical: 'valid_to=now()' }
    await pool.query(`UPDATE workspace_files SET ${updates[state]} WHERE id=$1`, [f.file.id])
    expect(await f.store.updateMeta(f.userId, f.workspaceId, f.file.id, { title: 'Changed' }, f.access)).toBeNull()
    expect(await f.store.delete(f.userId, f.workspaceId, f.file.id, f.access)).toBe(false)
    expect(await f.store.supersede(f.userId, f.workspaceId, f.file.id, f.patch, f.access)).toBeNull()
    expect(await f.raw()).toHaveLength(1)
  })

  it('rejects added destination scope and retains source sensitivity', async () => {
    const f = await fixture()
    await expect(f.store.supersede(f.userId, f.workspaceId, f.file.id, { ...f.patch, compartments: ['foreign'] }, f.access)).rejects.toMatchObject({ code: 'scope_operation_denied' })
    await expect(f.store.updateMeta(f.userId, f.workspaceId, f.file.id, { inheritProjectIds: [randomUUID()] }, f.access)).rejects.toMatchObject({ code: 'scope_operation_denied' })
    await expect(f.store.supersede(f.userId, f.workspaceId, f.file.id, { ...f.patch, sensitivity: 'public' }, f.access)).rejects.toMatchObject({ code: 'scope_declassification_required' })
    const result = await f.store.supersede(f.userId, f.workspaceId, f.file.id, f.patch, f.access)
    expect(result).toMatchObject({ sensitivity: 'internal', compartments: ['product'], projectIds: [f.projectId] })
  })

  it('keeps metadata sensitivity monotone for scoped edits and propagates the retained floor', async () => {
    const f = await fixture()
    await expect(f.store.updateMeta(f.userId, f.workspaceId, f.file.id, { sensitivity: 'public' }, f.access))
      .rejects.toMatchObject({ code: 'scope_declassification_required' })
    expect((await pool.query('SELECT sensitivity FROM file_segments WHERE file_id=$1', [f.file.id])).rows[0].sensitivity).toBe('internal')
  })

  it('guards direct create and legacy size adapters, including explicit actor mismatch', async () => {
    const f = await fixture(), readOnly = { ...f.access, mutationCompartments: [] }
    const input = { workspaceId: f.workspaceId, path: '/other.txt', parentPath: '/', name: 'other.txt',
      mime: 'text/plain', sizeBytes: 1, storageUri: f.file.storageUri, compartments: ['product'], createdByUserId: f.userId }
    await expect(f.store.create(f.userId, input, readOnly)).rejects.toMatchObject({ code: 'scope_operation_denied' })
    await expect(f.store.create(f.userId, input, { ...f.access, userId: randomUUID() })).rejects.toMatchObject({ code: 'scope_operation_denied' })
    expect(await f.store.updateSize(f.userId, f.workspaceId, f.file.id, 100, {}, readOnly)).toBeNull()
    await expect(f.store.updateSize(f.userId, f.workspaceId, f.file.id, 100, { compartments: ['foreign'] }, f.access))
      .rejects.toMatchObject({ code: 'scope_operation_denied' })
    await runWithAgentAccess({ ...f.ctx, clearance: f.ctx.clearance, compartments: f.ctx.compartments, mutationCompartments: [] }, async () => {
      await expect(f.store.create(f.userId, input)).rejects.toMatchObject({ code: 'scope_operation_denied' })
      expect(await f.store.updateSize(f.userId, f.workspaceId, f.file.id, 100)).toBeNull()
    })
    expect(await f.raw()).toHaveLength(1)
    expect(await f.store.getById(f.access, f.file.id)).toMatchObject({ sizeBytes: 8 })
  })
})
