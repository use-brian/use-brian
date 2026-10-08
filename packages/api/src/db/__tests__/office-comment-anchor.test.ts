import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { createOfficeArtifactStore, type OfficeDbQuery } from '../office-artifacts.js'
import { createOfficeLiveStore } from '../office-live.js'
import { createOfficeCommentStore } from '../office-comments.js'
import { createOfficeCommentAnchorWriter } from '../../office/comment-anchor-storage.js'
import { createOfficeCommentVersionResolver } from '../../office/comment-version.js'
import { completePresentationSnapshot } from '../../../../core/src/office/__tests__/fixtures.js'

// Embedded PostgreSQL: real Office FKs, anchor policies, member-operation floor
// and Office root-scope functions. Minimal FK parents and unrestricted agent/Team
// seams; full agent/Team integration lives in office-operation-scope.integration.
let pg: PGlite
const owner = randomUUID(), outsider = randomUUID(), workspace = randomUUID()
const query: OfficeDbQuery = async <T>(actor: string, sql: string, params: unknown[]) =>
  pg.transaction(async tx => {
    await tx.query("SELECT set_config('app.current_user_id',$1,true)", [actor])
    return tx.query<T>(sql, params)
  })
const artifacts = createOfficeArtifactStore(query), live = createOfficeLiveStore(query), comments = createOfficeCommentStore(query)

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE workspaces(id uuid PRIMARY KEY, home_apps jsonb DEFAULT '[]');
    CREATE TABLE assistants(id uuid PRIMARY KEY);
    CREATE TABLE workspace_members(workspace_id uuid, user_id uuid, role text DEFAULT 'member', clearance text DEFAULT 'internal');
    CREATE TABLE workspace_files(id uuid PRIMARY KEY, workspace_id uuid, bytes bytea, path text DEFAULT '/fixture', sensitivity text DEFAULT 'internal', compartments text[] DEFAULT '{}', metadata jsonb DEFAULT '{}');
  `)
  for (const name of ['3941_office_artifacts.sql', '3943_office_collaboration.sql'])
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'))
  // Columns introduced by later broad scope/session migrations, unused by the
  // anchor SQL but selected by the normal store shell/get projection.
  await pg.exec(`ALTER TABLE office_artifacts ADD compartments text[] NOT NULL DEFAULT '{}',
    ADD project_ids uuid[] NOT NULL DEFAULT '{}', ADD expires_at timestamptz;
    ALTER TABLE office_artifacts DROP CONSTRAINT office_artifacts_default_workspace_role_check;
    ALTER TABLE office_artifacts ADD CHECK(default_workspace_role IN ('view','comment','edit','deny'));
    INSERT INTO users VALUES ('${owner}'),('${outsider}');
    INSERT INTO workspaces(id) VALUES ('${workspace}');
    INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES ('${workspace}','${owner}','owner','confidential');
  `)
  await pg.exec(`
    CREATE FUNCTION sensitivity_rank(s text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE s WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 END $$;
    CREATE FUNCTION effective_member_team_compartments(a uuid,w uuid) RETURNS text[] LANGUAGE sql AS $$ SELECT NULL::text[] $$;
    CREATE FUNCTION effective_member_read_compartments(a uuid,w uuid) RETURNS text[] LANGUAGE sql AS $$ SELECT NULL::text[] $$;
    CREATE FUNCTION agent_read_scope_allows(s text,c text[],p uuid[]) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION agent_visibility_allows(w uuid,u uuid,a uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION agent_mutation_scope_allows(c text[]) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  `)
  const floor=readFileSync(new URL('../../../migrations/589_member_operation_floor.sql',import.meta.url),'utf8')
  await pg.exec(floor.slice(floor.indexOf('CREATE FUNCTION'),floor.indexOf('DO $$')))
  const scope=readFileSync(new URL('../../../migrations/596_office_operation_scope.sql',import.meta.url),'utf8')
  await pg.exec(scope.slice(0,scope.indexOf('CREATE FUNCTION office_child_scope_allows'))+'COMMIT;')
  await pg.exec(`
    ALTER TABLE workspace_files ENABLE ROW LEVEL SECURITY;
    CREATE POLICY file_member ON workspace_files USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid));
    CREATE POLICY file_floor_read ON workspace_files AS RESTRICTIVE FOR SELECT USING(member_operation_scope_allows(workspace_id,sensitivity,compartments,false));
    CREATE POLICY file_floor_insert ON workspace_files AS RESTRICTIVE FOR INSERT WITH CHECK(member_operation_scope_allows(workspace_id,sensitivity,compartments,true));
  `)
  await pg.exec(readFileSync(new URL('../../../migrations/610_office_anchor_file_scope.sql',import.meta.url),'utf8'))
  await pg.exec(`
    CREATE ROLE office_test_actor;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO office_test_actor;
    SET ROLE office_test_actor;
  `)
}, 30_000)
afterAll(async () => { await pg?.close() })

async function fixture() {
  const artifact = await artifacts.createShell({ userId: owner, workspaceId: workspace,
    family: 'presentation', title: 'New draft', templateVersionId: null,
    capabilityVersion: 1, sensitivity: 'internal', mode: 'template' })
  const snapshot = { ...completePresentationSnapshot(), artifactId: artifact.id, workspaceId: workspace }
  await live.initializeIfMissing({ userId: owner, artifactId: artifact.id, snapshot })
  const discard = vi.fn(async (fileId: string) => { await query(owner, 'DELETE FROM workspace_files WHERE id=$1', [fileId]) })
  const persist = vi.fn(async (userId: string, _artifact: unknown, bytes: Uint8Array) => {
    const fileId = randomUUID()
    await query(userId, 'INSERT INTO workspace_files(id,workspace_id,bytes) VALUES($1,$2,$3)', [fileId, workspace, Buffer.from(bytes)])
    return { fileId, discard: () => discard(fileId) }
  })
  const canComment = vi.fn(async () => true)
  const deps = { getArtifact: artifacts.get, getLive: live.getOfflineSource, anchorDraft: artifacts.anchorDraft, canComment, persist }
  return { artifact, snapshot, deps, discard, resolve: createOfficeCommentVersionResolver(deps) }
}

async function anchorParams(f: Awaited<ReturnType<typeof fixture>>) {
  const source = (await live.getOfflineSource(owner, f.artifact.id))!
  const bytes = new TextEncoder().encode(JSON.stringify(source.snapshot))
  const saved = await f.deps.persist(owner, f.artifact, bytes)
  return { userId: owner, artifactId: f.artifact.id, expectedSeq: source.seq, expectedUpdate: source.update,
    snapshotFileId: saved.fileId, snapshotHash: createHash('sha256').update(bytes).digest('hex'),
    operationClock: source.stateVector, schemaVersion: source.snapshot.schemaVersion, capabilityVersion: source.snapshot.capabilityVersion }
}

describe('[COMP:api/office-store] draft comment anchoring SQL', () => {
  it('rejects an import that races with a live draft edit', async () => {
    const f = await fixture()
    await live.initialize({userId:owner,artifactId:f.artifact.id,snapshot:{...f.snapshot,title:'Edited draft'}})
    await expect(live.initialize({userId:owner,artifactId:f.artifact.id,snapshot:f.snapshot,expectedSeq:1})).rejects.toThrow('office_import_draft_changed')
    expect((await live.get(owner,f.artifact.id))?.snapshot.title).toBe('Edited draft')
    const fresh = await fixture()
    await live.initialize({userId:owner,artifactId:fresh.artifact.id,snapshot:{...fresh.snapshot,title:'Imported draft'},expectedSeq:1})
    expect((await live.get(owner,fresh.artifact.id))?.snapshot.title).toBe('Imported draft')
  })

  it('anchors an initialized live draft to a real version/file and atomically creates its discussion without rebasing', async () => {
    const f = await fixture(), before = await live.getOfflineSource(owner, f.artifact.id)
    const versionId = await f.resolve(owner, f.artifact)
    expect(versionId).toBeTruthy()
    expect(await artifacts.get(owner, f.artifact.id)).toMatchObject({ headVersion: 0, headVersionId: versionId })
    expect(await live.getOfflineSource(owner, f.artifact.id)).toEqual(before)
    const version = await query(owner, 'SELECT version::int, snapshot_file_id FROM office_artifact_versions WHERE id=$1', [versionId])
    expect(version.rows).toEqual([{ version: 0, snapshot_file_id: expect.any(String) }])
    const thread = await comments.createThread({ userId: owner, workspaceId: workspace, artifactId: f.artifact.id,
      artifactVersionId: versionId!, anchor: { kind: 'slide', targetIds: [f.snapshot.slides[0]!.id] }, body: 'Review draft' })
    expect(thread).toMatchObject({ threadId: expect.any(String), messageId: expect.any(String) })
    // A failed first message rolls back its thread too.
    await expect(comments.createThread({ userId: owner, workspaceId: workspace, artifactId: f.artifact.id,
      artifactVersionId: versionId!, anchor: { kind: 'slide', targetIds: [f.snapshot.slides[0]!.id] }, body: '' })).rejects.toMatchObject({ code: '23514' })
    expect((await comments.listThreads(owner, f.artifact.id))).toHaveLength(1)
    expect(f.discard).not.toHaveBeenCalled()
    const checkpoint = await artifacts.commitVersion({ ...await anchorParams(f), expectedVersion: 0,
      snapshotTitle: 'Checkpoint', origin: 'manual', authorType: 'user', authorUserId: owner, summary: 'First save' })
    expect(checkpoint).toMatchObject({ version: 1 })
    expect((await query(owner, 'SELECT parent_version_id FROM office_artifact_versions WHERE id=$1', [checkpoint!.id])).rows)
      .toEqual([{ parent_version_id: versionId }])
  })

  it('converges overlapping first-comment attempts on one immutable version and removes only the losing file', async () => {
    const f = await fixture()
    const ids = await Promise.all([f.resolve(owner, f.artifact), f.resolve(owner, f.artifact)])
    expect(ids[0]).toBeTruthy(); expect(ids[1]).toBe(ids[0])
    expect((await query(owner, 'SELECT id FROM office_artifact_versions WHERE artifact_id=$1', [f.artifact.id])).rows).toHaveLength(1)
    expect(f.discard).toHaveBeenCalledTimes(1)
    const winnerFile = (await query<{ snapshot_file_id: string }>(owner, 'SELECT snapshot_file_id FROM office_artifact_versions WHERE id=$1', [ids[0]])).rows[0]!.snapshot_file_id
    expect(f.discard).not.toHaveBeenCalledWith(winnerFile)
    expect((await query(owner, 'SELECT id FROM workspace_files WHERE id=$1', [winnerFile])).rows).toHaveLength(1)
  })

  it.each(['sequence', 'bytes', 'base', 'lifecycle', 'foreign-user', 'missing-file'] as const)('fails closed for %s without publishing an anchor', async change => {
    const f = await fixture(), params = await anchorParams(f)
    if (change === 'sequence') await query(owner, 'UPDATE office_collab_documents SET seq=seq+1 WHERE artifact_id=$1', [f.artifact.id])
    if (change === 'bytes') params.expectedUpdate = new Uint8Array([0])
    if (change === 'base') await query(owner, 'UPDATE office_collab_documents SET base_version=1 WHERE artifact_id=$1', [f.artifact.id])
    if (change === 'lifecycle') await query(owner, "UPDATE office_artifacts SET lifecycle_state='archived' WHERE id=$1", [f.artifact.id])
    if (change === 'foreign-user') params.userId = outsider
    if (change === 'missing-file') {
      params.snapshotFileId = randomUUID()
      await expect(artifacts.anchorDraft(params)).rejects.toMatchObject({ code: '23503' })
    } else expect(await artifacts.anchorDraft(params)).toBeNull()
    expect((await artifacts.get(owner, f.artifact.id))?.headVersionId).toBeNull()
    expect((await query(owner, 'SELECT id FROM office_artifact_versions WHERE artifact_id=$1', [f.artifact.id])).rows).toHaveLength(0)
  })

  it('does not snapshot an unauthorized or uninitialized draft, and rechecks authority after storage', async () => {
    const f = await fixture()
    f.deps.canComment.mockResolvedValue(false)
    expect(await f.resolve(owner, f.artifact)).toBeNull()
    expect(f.deps.persist).not.toHaveBeenCalled()
    f.deps.canComment.mockResolvedValueOnce(true).mockResolvedValue(false)
    expect(await f.resolve(owner, f.artifact)).toBeNull()
    expect(f.discard).toHaveBeenCalledTimes(1)
    expect((await artifacts.get(owner, f.artifact.id))?.headVersionId).toBeNull()
    await query(owner, 'DELETE FROM office_collab_documents WHERE artifact_id=$1', [f.artifact.id])
    f.deps.canComment.mockResolvedValue(true); f.deps.persist.mockClear()
    expect(await f.resolve(owner, f.artifact)).toBeNull()
    expect(f.deps.persist).not.toHaveBeenCalled()
  })

  it('preserves a published file when the database acknowledgement is ambiguous', async () => {
    const f = await fixture()
    const resolve = createOfficeCommentVersionResolver({ ...f.deps, anchorDraft: async params => {
      expect(await artifacts.anchorDraft(params)).not.toBeNull()
      throw new Error('acknowledgement lost')
    } })
    await expect(resolve(owner, f.artifact)).rejects.toThrow('acknowledgement lost')
    expect(f.discard).not.toHaveBeenCalled()
    const head = (await artifacts.get(owner, f.artifact.id))!.headVersionId
    expect(head).toBeTruthy()
    // Retry with the stale artifact object still recovers the winning version.
    expect(await f.resolve(owner, f.artifact)).toBe(head)
    expect(f.discard).toHaveBeenCalledTimes(1)
  })

  it('reuses a normal checkpoint that wins while the draft snapshot is being stored', async () => {
    const f = await fixture(), params = await anchorParams(f)
    const persist = f.deps.persist.getMockImplementation()!
    let head: string | undefined
    f.deps.persist.mockImplementation(async (...args) => {
      const saved = await persist(...args)
      head = (await artifacts.commitVersion({ ...params, expectedVersion: 0,
        snapshotTitle: 'Concurrent checkpoint', origin: 'manual', authorType: 'user', authorUserId: owner, summary: 'Save' }))?.id
      return saved
    })
    const anchored = await f.resolve(owner, f.artifact)
    expect(head).toBeTruthy(); expect(anchored).toBe(head)
    expect(f.discard).toHaveBeenCalledTimes(1)
    expect((await query(owner, 'SELECT version::int FROM office_artifact_versions WHERE artifact_id=$1', [f.artifact.id])).rows).toEqual([{ version: 1 }])
  })

  it('fails closed on missing protected-storage policy or lost Comment authority before writing bytes', async () => {
    const f=await fixture(), writeBytes=vi.fn(), authorizePath=vi.fn(async()=>false)
    const persist=createOfficeCommentAnchorWriter({filesApi:{writeBytes,delete:vi.fn()},
      membership:vi.fn(async()=>({role:'member',clearance:'internal'} as never)),authorizePath})
    await expect(persist(owner,f.artifact,new Uint8Array([1]),'a'.repeat(64))).rejects.toThrow('storage unavailable')
    authorizePath.mockRejectedValue(new Error('function does not exist'))
    await expect(persist(owner,f.artifact,new Uint8Array([1]),'a'.repeat(64))).rejects.toThrow('function does not exist')
    expect(writeBytes).not.toHaveBeenCalled()
  })

  it('refuses malformed, missing-root and cross-workspace anchor file bindings', async () => {
    const f=await fixture()
    for(const [workspaceId,path] of [[workspace,'/office/anchors/bad/snapshot.json'],
      [workspace,`/office/anchors/${randomUUID()}/snapshot.json`],
      [randomUUID(),`/office/anchors/${f.artifact.id}/snapshot.json`]]) {
      await expect(query(owner,'INSERT INTO workspace_files(id,workspace_id,path) VALUES($1,$2,$3)',[randomUUID(),workspaceId,path])).rejects.toMatchObject({code:'42501'})
    }
  })

  it.each(['public','internal'] as const)('stores a protected %s anchor with a lower-clearance commenter and rechecks generic file access', async sensitivity => {
    const f=await fixture(), commenter=randomUUID(), denied=randomUUID()
    await pg.query('INSERT INTO users VALUES($1),($2)',[commenter,denied])
    await pg.query('INSERT INTO workspace_members(workspace_id,user_id,clearance) VALUES($1,$2,$4),($1,$3,$4)',[workspace,commenter,denied,sensitivity])
    await query(owner,'UPDATE office_artifacts SET sensitivity=$2 WHERE id=$1',[f.artifact.id,sensitivity])
    const artifact={...f.artifact,sensitivity}
    const writeBytes=vi.fn(async (ctx: any, params: any) => {
      // The real 589 floor and 610 Office policies, not an always-success stub.
      expect(ctx.clearance).toBe(sensitivity);expect(ctx.writeSensitivity).toBe(sensitivity)
      const id=randomUUID()
      await query(ctx.userId, 'INSERT INTO workspace_files(id,workspace_id,bytes,path,sensitivity,metadata) VALUES($1,$2,$3,$4,$5,$6)',
        [id,ctx.workspaceId,Buffer.from(params.bytes),params.path,params.sensitivity,{noIndex:true}])
      return {ok:true as const,value:{id} as never}
    })
    const persist=createOfficeCommentAnchorWriter({ filesApi:{writeBytes,delete:vi.fn()},
      membership:vi.fn(async()=>({role:'member',clearance:sensitivity} as never)),
      authorizePath:async(actor,workspaceId,path)=>(await query<{allowed:boolean}>(actor,'SELECT office_anchor_file_scope_allows($1,$2,true) AS allowed',[workspaceId,path])).rows[0]!.allowed })
    const resolve=createOfficeCommentVersionResolver({...f.deps,persist})
    const versionId=await resolve(commenter,artifact);expect(versionId).toBeTruthy()
    const fileId=(await query<{snapshot_file_id:string}>(owner,'SELECT snapshot_file_id FROM office_artifact_versions WHERE id=$1',[versionId])).rows[0]!.snapshot_file_id
    expect((await query(commenter,'SELECT bytes FROM workspace_files WHERE id=$1',[fileId])).rows).toHaveLength(1)
    expect((await query(commenter,"SELECT id FROM workspace_files WHERE id=$1 AND NOT COALESCE((metadata->>'noIndex')::boolean,false)",[fileId])).rows).toHaveLength(0)
    await expect(query(commenter,'INSERT INTO workspace_files(id,workspace_id,path,sensitivity) VALUES($1,$2,$3,$4)',[randomUUID(),workspace,`/office/anchors/${artifact.id}/wrong-clearance.json`,'confidential'])).rejects.toMatchObject({code:'42501'})
    // Membership and sufficient clearance alone must not bypass an Office deny.
    await query(owner,"INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role) VALUES($1,$2,$3,'deny')",[artifact.id,workspace,denied])
    expect((await query(denied,'SELECT * FROM workspace_files WHERE id=$1',[fileId])).rows).toHaveLength(0)
    expect((await query(denied,"SELECT * FROM workspace_files WHERE path LIKE '/office/anchors/%'",[])).rows).toHaveLength(0)
    await query(owner,'UPDATE office_artifacts SET visibility_user_ids=$2 WHERE id=$1',[artifact.id,[owner]])
    expect((await query(commenter,'SELECT bytes FROM workspace_files WHERE id=$1',[fileId])).rows).toHaveLength(0)
    await query(owner,"UPDATE office_artifacts SET visibility_user_ids='{}',default_workspace_role='deny' WHERE id=$1",[artifact.id])
    expect((await query(commenter,'SELECT bytes FROM workspace_files WHERE id=$1',[fileId])).rows).toHaveLength(0)
    // Even the owner cannot mutate a published immutable anchor through Files.
    expect((await query(owner,"UPDATE workspace_files SET path='/leaked.json' WHERE id=$1 RETURNING id",[fileId])).rows).toHaveLength(0)
    expect((await query(owner,'DELETE FROM workspace_files WHERE id=$1 RETURNING id',[fileId])).rows).toHaveLength(0)
  })

  it('returns not-ready after a live edit wins, without rebasing or leaving an unused file', async () => {
    const f = await fixture(), persist = f.deps.persist.getMockImplementation()!
    f.deps.persist.mockImplementation(async (...args) => {
      const saved = await persist(...args)
      await query(owner, 'UPDATE office_collab_documents SET seq=seq+1 WHERE artifact_id=$1', [f.artifact.id])
      return saved
    })
    expect(await f.resolve(owner, f.artifact)).toBeNull()
    expect(f.discard).toHaveBeenCalledTimes(1)
    expect((await artifacts.get(owner, f.artifact.id))?.headVersionId).toBeNull()
    expect((await live.getOfflineSource(owner, f.artifact.id))?.seq).toBe(2)
  })
})
