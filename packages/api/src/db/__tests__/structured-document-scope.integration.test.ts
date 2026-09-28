import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { AccessContext } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { createOfficeArtifactStore } from '../office-artifacts.js'
import { createStructuredFillProposalStore, type StructuredFillProposalInput } from '../structured-fill-proposals.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), actor = randomUUID(), assistantId = randomUUID(), projectId = randomUUID()
  for (const id of [owner, actor]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Structured evidence fixture',$2)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','confidential','assigned')", [workspaceId, owner, actor])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Evidence fixture',$2,$3,'standard')", [assistantId, workspaceId, actor])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Evidence project','evidence project',$3)", [projectId, workspaceId, owner])
  const groups = createDbWorkspaceGroupStore()
  const team = await groups.createTeam(owner, workspaceId, { name: 'Evidence department', key: 'evidence-department' })
  await groups.addMember(owner, team.id, actor)
  const compartment = team.compartmentKey!
  const sourceFileId = randomUUID(), recordsFileId = randomUUID(), imageFileId = randomUUID(), snapshotFileId = randomUUID()
  for (const [id, path, mime] of [
    [sourceFileId, '/fixture/source.pdf', 'application/pdf'],
    [recordsFileId, '/fixture/records.json', 'application/json'],
    [imageFileId, '/fixture/page-1.png', 'image/png'],
    [snapshotFileId, '/fixture/snapshot.json', 'application/json'],
  ]) await pool.query(`INSERT INTO workspace_files
      (id,workspace_id,path,parent_path,name,mime,size_bytes,storage_uri,sensitivity,compartments,project_ids,created_by_user_id)
      VALUES($1,$2,$3,'/fixture',$4,$5,8,$6,'internal',$7,$8,$9)`,
    [id, workspaceId, path, path.split('/').at(-1), mime, `fixture://${id}`, [compartment], [projectId], owner])
  const artifacts = createOfficeArtifactStore()
  const artifact = await artifacts.createShell({ userId: owner, workspaceId, family: 'spreadsheet', title: 'Evidence target', templateVersionId: null,
    capabilityVersion: 1, sensitivity: 'internal', requiredCompartments: [compartment], projectIds: [projectId] })
  const version = await artifacts.commitVersion({ userId: owner, artifactId: artifact.id, snapshotTitle: 'Evidence target', expectedVersion: 0,
    snapshotFileId, snapshotHash: 'a'.repeat(64), operationClock: new Uint8Array(), schemaVersion: 1, capabilityVersion: 1,
    origin: 'manual', authorType: 'user', authorUserId: owner, summary: 'Fixture checkpoint' })
  if (!version) throw new Error('Missing fixture version')
  await pool.query("INSERT INTO office_collab_documents(artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version) VALUES($1,$2,'','',$3,1)", [artifact.id, workspaceId, 'a'.repeat(64)])
  await pool.query("INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role) VALUES($1,$2,$3,'comment')", [artifact.id, workspaceId, actor])
  const extractionId = randomUUID()
  await pool.query(`INSERT INTO structured_document_extractions
      (id,user_id,workspace_id,source_file_id,pdf_sha256,context,status,remote_job_id,records_file_id,records_sha256,document_id,page_numbers,image_files,archived_bytes)
      VALUES($1,$2,$3,$4,$5,'{}','completed','fixture-remote',$6,$7,'fixture-document','[1]',$8,16)`,
    [extractionId, actor, workspaceId, sourceFileId, 'b'.repeat(64), recordsFileId, 'c'.repeat(64),
      JSON.stringify([{ page: 1, fileId: imageFileId, sha256: 'd'.repeat(64), sizeBytes: 8 }])])
  const rows = await pool.query<{ id: string; scopeVersion: string }>('SELECT id,scope_version::text AS "scopeVersion" FROM workspace_files WHERE id=ANY($1::uuid[]) ORDER BY id', [[sourceFileId, recordsFileId, imageFileId]])
  const access: AccessContext & { clearance: 'confidential'; compartments: string[] } = { userId: actor, workspaceId, assistantId, assistantKind: 'standard', clearance: 'confidential',
    compartments: [compartment], mutationCompartments: [compartment], projectIds: [projectId] }
  const input: StructuredFillProposalInput = { userId: actor, workspaceId, artifactId: artifact.id, baseVersionId: version.id, expectedSeq: 1,
    assistantId, extractionId, evidenceHash: 'e'.repeat(64), command: { kind: 'batch', commands: [] }, preview: [{ targetId: randomUUID() }],
    lineage: { fixture: true }, body: 'Unreviewed fictional source evidence.', targetIds: [randomUUID()], access,
    evidenceFiles: rows.rows, evidenceScope: { sensitivity: 'internal', compartments: [compartment], projectIds: [projectId] } }
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM structured_document_fill_proposals WHERE extraction_id=$1) AS proposals,
    (SELECT count(*)::int FROM office_comment_threads WHERE artifact_id=$2) AS threads,
    (SELECT count(*)::int FROM office_comment_messages m JOIN office_comment_threads t ON t.id=m.thread_id WHERE t.artifact_id=$2) AS messages,
    (SELECT count(*)::int FROM office_suggestions WHERE artifact_id=$2) AS suggestions`, [extractionId, artifact.id])).rows[0]
  return { store: createStructuredFillProposalStore(), input, access, actor, workspaceId, artifact, sourceFileId, compartment, counts }
}

describe('[COMP:api/structured-document-store] current structured evidence proposal scope (PG18)', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('admits one current mutation-authorized proposal and atomically refuses stale authority or evidence', async () => {
    const f = await fixture()
    const first = await runWithAgentAccess(f.access, () => f.store.save(f.input))
    expect(first).not.toBeNull()
    expect(await f.counts()).toEqual({ proposals: 1, threads: 1, messages: 1, suggestions: 1 })

    const refuse = async (patch: Partial<StructuredFillProposalInput>) => {
      const before = await f.counts()
      const input = { ...f.input, evidenceHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), ...patch }
      const access = input.access
      const execution = { workspaceId: access.workspaceId, userId: access.userId, clearance: access.clearance,
        compartments: access.compartments, mutationCompartments: access.mutationCompartments, projectIds: access.projectIds,
        visibilityAssistantIds: access.visibilityAssistantIds }
      expect(await runWithAgentAccess(execution, () => f.store.save(input))).toBeNull()
      expect(await f.counts()).toEqual(before)
    }
    const readOnly = { ...f.access, mutationCompartments: [] }
    await refuse({ access: readOnly })
    await refuse({ evidenceFiles: f.input.evidenceFiles.map((file, index) => index === 0 ? { ...file, scopeVersion: `${file.scopeVersion}-stale` } : file) })
    await pool.query("UPDATE office_artifact_grants SET role='view' WHERE artifact_id=$1 AND user_id=$2", [f.artifact.id, f.actor])
    await refuse({})
    await pool.query("UPDATE office_artifact_grants SET role='comment' WHERE artifact_id=$1 AND user_id=$2", [f.artifact.id, f.actor])
    await pool.query('UPDATE office_artifacts SET compartments=\'{}\' WHERE id=$1', [f.artifact.id])
    await refuse({})
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor])
    await refuse({})
  })
})
