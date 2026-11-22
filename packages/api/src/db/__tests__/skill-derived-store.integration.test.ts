import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { getAppPool, getPool } from '../client.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { createDbSkillStore } from '../skill-store.js'
import { createDbWorkspaceSkillFilesStore } from '../workspace-skill-files-store.js'
import { createMemory, type Memory } from '../memories.js'
import {
  applyDerivedSkillPatch,
  applyDerivedSkillSupportFile,
  createDerivedWorkspaceSkill,
  readWorkspaceSkillRevisionSource,
  recordDerivedSkillRederivation,
} from '../skill-derived-store.js'

const { assertLocalFixture } = await import(
  new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
)
await assertLocalFixture()

const pool = getPool()

async function admittedSkill(workspaceId: string, revisionId: string, userId: string, settings: Record<string, string> = {}) {
  const app = await getAppPool().connect()
  try {
    await app.query('BEGIN')
    const context = {
      'app.current_user_id': userId,
      'app.system_bypass': 'false',
      'app.agent_workspace_id': workspaceId,
      'app.agent_actor_id': userId,
      ...settings,
    }
    await app.query('SELECT set_config(k,v,true) FROM unnest($1::text[],$2::text[]) AS t(k,v)',
      [Object.keys(context), Object.values(context)])
    const result = await app.query(
      `SELECT read_admitted_native_scope_snapshot($1,'workspace_skill_revision',$2) AS snapshot,
              read_entity_derivation_source($1,'workspace_skill_revision',$2) AS "entityWriter"`,
      [workspaceId, revisionId],
    )
    return result.rows[0]
  } finally {
    await app.query('ROLLBACK')
    app.release()
  }
}

function memorySource(memory: Memory): ScopeSource {
  return {
    workspaceId: memory.workspaceId!,
    userId: memory.userId,
    assistantId: memory.assistantId,
    sensitivity: memory.sensitivity,
    compartments: memory.compartments,
    projectIds: memory.projectIds,
    resourceKind: 'memory',
    resourceId: memory.id,
    version: memory.scopeVersion,
  }
}

async function fixture() {
  const workspaceId = randomUUID()
  const userId = randomUUID()
  const assistantId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query(
    "INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Procedural fixture',$2)",
    [workspaceId, userId],
  )
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [workspaceId, userId],
  )
  await pool.query(
    "INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')",
    [assistantId, userId, workspaceId],
  )
  await pool.query(
    "INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'finance','Finance')",
    [workspaceId],
  )
  const source = await createMemory({
    workspaceId,
    userId,
    assistantId,
    createdByUserId: userId,
    summary: 'Use the reviewed finance close checklist',
    sensitivity: 'confidential',
    compartments: ['finance'],
  })
  return { workspaceId, userId, assistantId, source }
}

describe('[COMP:api/procedural-skill-evidence] immutable skill revision lineage', () => {
  afterAll(async () => {
    await getAppPool().end()
    await pool.end()
  })

  it('admits an authored revision for its native member and withholds withdrawn or inaccessible receipts', async () => {
    const f = await fixture()
    await pool.query(`INSERT INTO workspace_skills(workspace_id,author_id,slug,name,description,content,sensitivity,induction_source,write_origin)
      VALUES($1,$2,'native-offer','Native offer','Fixture skill','Fixture instructions','public','authored','foreground')`,
    [f.workspaceId, f.userId])
    const { rows: [skill] } = await pool.query('SELECT id,scope_revision_id FROM workspace_skills WHERE workspace_id=$1', [f.workspaceId])
    const read = (id: string, settings?: Record<string, string>) => admittedSkill(f.workspaceId, id, f.userId, settings)

    expect(await read(skill.scope_revision_id)).toMatchObject({
      snapshot: { workspaceId: f.workspaceId, userId: null, assistantId: null, version: '1', held: false, sensitivity: 'public' },
      entityWriter: null,
    })
    expect((await read(randomUUID())).snapshot).toEqual({ held: true })
    const other = await fixture()
    expect((await admittedSkill(other.workspaceId, skill.scope_revision_id, other.userId)).snapshot).toEqual({ held: true })
    expect((await read(skill.scope_revision_id, { 'app.application_id': randomUUID() })).snapshot).toEqual({ held: true })
    expect((await read(skill.scope_revision_id, { 'app.public_share_root': randomUUID() })).snapshot).toEqual({ held: true })
    await expect(read(skill.scope_revision_id, { 'app.v2_assistant_id': randomUUID() })).rejects.toThrow('scope_operation_denied')
    await expect(admittedSkill(f.workspaceId, skill.scope_revision_id, randomUUID())).rejects.toThrow('scope_operation_denied')

    await pool.query("UPDATE workspace_skills SET content='Replacement instructions' WHERE id=$1", [skill.id])
    expect((await read(skill.scope_revision_id)).snapshot).toEqual({ held: true })
    const replacement = await readWorkspaceSkillRevisionSource(f.workspaceId, skill.id)
    expect(replacement!.resourceId).not.toBe(skill.scope_revision_id)
    expect((await read(replacement!.resourceId)).snapshot.held).toBe(false)
  })

  it('persists complete inputs, carries the exact scope, and holds every descendant revision', async () => {
    const f = await fixture()
    const created = await createDerivedWorkspaceSkill({
      workspaceId: f.workspaceId,
      authorUserId: f.userId,
      slug: 'finance-close-checklist',
      name: 'Finance close checklist',
      description: 'Run the reviewed close checklist',
      content: '# Finance close\nFollow the reviewed checklist.',
      source: 'auto-generated',
      writeOrigin: 'background_review',
      originatingAssistantId: f.assistantId,
      humanApproved: false,
      evidence: { producer: 'fixture:procedural-create', sources: [memorySource(f.source)] },
    })

    const first = await readWorkspaceSkillRevisionSource(f.workspaceId, created.rowId)
    expect(first).toMatchObject({
      workspaceId: f.workspaceId,
      userId: f.userId,
      assistantId: f.assistantId,
      sensitivity: 'confidential',
      compartments: ['finance'],
      resourceKind: 'workspace_skill_revision',
      version: '1',
    })

    await applyDerivedSkillPatch({
      workspaceId: f.workspaceId,
      skillId: created.rowId,
      content: '# Finance close\nUse the reconciled checklist.',
      diff: 'Reconciled checklist wording',
      evidence: {
        producer: 'fixture:procedural-patch',
        sources: [first!, memorySource(f.source)],
      },
    })
    const second = await readWorkspaceSkillRevisionSource(f.workspaceId, created.rowId)
    // A derived patch references its predecessor. The retained immutable receipt
    // still carries that earlier read's scope after the skill head advances.
    const actor = {
      'app.agent_clearance': 'confidential',
      'app.agent_compartments': JSON.stringify(['finance']),
      'app.agent_project_ids': 'null',
      'app.agent_visibility_assistants': JSON.stringify([f.assistantId]),
    }
    expect((await admittedSkill(f.workspaceId, first!.resourceId, f.userId, actor)).snapshot).toMatchObject({
      version: first!.version, held: false, userId: f.userId, assistantId: f.assistantId, compartments: ['finance'],
    })
    expect((await admittedSkill(f.workspaceId, first!.resourceId, f.userId, { ...actor, 'app.agent_clearance': 'public' })).snapshot).toEqual({ held: true })
    expect(second).toMatchObject({ resourceKind: 'workspace_skill_revision', version: '1' })
    expect(second!.resourceId).not.toBe(first!.resourceId)

    const edges = await pool.query(
      `SELECT source_kind,source_id FROM scope_derivation_sources s
       JOIN scope_derivations d ON d.id=s.derivation_id
       WHERE d.resource_kind='workspace_skill_revision' AND d.resource_id=$1
       ORDER BY source_kind,source_id`,
      [second!.resourceId],
    )
    expect(edges.rows).toEqual([
      { source_kind: 'memory', source_id: f.source.id },
      { source_kind: 'workspace_skill_revision', source_id: first!.resourceId },
    ])

    await recordDerivedSkillRederivation({
      workspaceId: f.workspaceId,
      skillId: created.rowId,
      evidence: {
        producer: 'fixture:procedural-rederivation',
        sources: [second!, memorySource(f.source)],
      },
    })
    const third = await readWorkspaceSkillRevisionSource(f.workspaceId, created.rowId)
    expect(third!.resourceId).not.toBe(second!.resourceId)
    const rederived = await pool.query(
      'SELECT rederivation_count,confidence FROM workspace_skills WHERE id=$1',
      [created.rowId],
    )
    expect(rederived.rows[0]).toEqual({ rederivation_count: 1, confidence: 0.05 })
    await expect(pool.query(
      "UPDATE workspace_skill_scope_revisions SET sensitivity='public' WHERE id=$1",
      [third!.resourceId],
    )).rejects.toThrow('workspace_skill_scope_revision_immutable')

    await pool.query("UPDATE memories SET compartments=ARRAY['finance','restricted'] WHERE id=$1", [
      f.source.id,
    ])
    expect(await readWorkspaceSkillRevisionSource(f.workspaceId, created.rowId)).toBeNull()
    const held = await pool.query(
      'SELECT revision,scope_held FROM workspace_skill_scope_revisions WHERE skill_id=$1 ORDER BY revision',
      [created.rowId],
    )
    expect(held.rows).toEqual([
      { revision: '1', scope_held: true },
      { revision: '2', scope_held: true },
      { revision: '3', scope_held: true },
    ])
    await expect(
      applyDerivedSkillPatch({
        workspaceId: f.workspaceId,
        skillId: created.rowId,
        content: 'Stale patch',
        diff: null,
        evidence: { producer: 'fixture:stale-patch', sources: [first!] },
      }),
    ).rejects.toThrow('scope_source_changed')

    const app = await getAppPool().connect()
    try {
      await app.query(
        "SELECT set_config('app.current_user_id',$1,false),set_config('app.system_bypass','false',false)",
        [f.userId],
      )
      expect((await app.query('SELECT id FROM workspace_skills WHERE id=$1', [created.rowId])).rows).toEqual([])
    } finally {
      app.release()
    }
  })
  it('keeps captured skill resources stable across derived replacement and ordinary human edits', async () => {
    const f = await fixture()
    const evidence = { producer: 'fixture:bundle', sources: [memorySource(f.source)] }
    const skill = await createDerivedWorkspaceSkill({
      workspaceId: f.workspaceId, authorUserId: f.userId, slug: 'versioned-bundle', name: 'Versioned bundle',
      description: 'Fixture resource', content: '{{reference:guide.md}}', inductionSource: 'self',
      humanApproved: true, source: 'auto-generated', writeOrigin: 'background_review', evidence,
    })
    const files = createDbWorkspaceSkillFilesStore()
    const store = createDbSkillStore()
    const capture = async () => {
      const rows = await store.listForWorkspaceContent(f.workspaceId, f.userId, { includeResources: true })
      return rows.find(row => row.id === skill.slug)!
    }
    const writeDerived = (content: string) => applyDerivedSkillSupportFile({
      workspaceId: f.workspaceId, skillId: skill.rowId, kind: 'reference', name: 'guide.md', content, evidence,
    })
    expect((await capture()).resources).toEqual([])
    await writeDerived('First derived resource')
    const initial = await capture()
    await writeDerived('Second derived resource')
    const beforeManualEdit = await capture()
    expect(boundScopeSources(initial)[0].resourceId).not.toBe(boundScopeSources(beforeManualEdit)[0].resourceId)

    // The same RLS-backed store used by PUT and DELETE /skills/:id/files.
    // A human edit of a derived skill leaves its scope lineage intact.
    await files.upsert(f.userId, { workspaceSkillId: skill.rowId, kind: 'reference', name: 'guide.md', content: 'Human replacement' })
    const afterManualEdit = await capture()
    expect(boundScopeSources(afterManualEdit)).toEqual(boundScopeSources(beforeManualEdit))
    expect(await files.delete(f.userId, skill.rowId, 'reference', 'guide.md')).toBe(true)

    expect(initial.resources?.map(file => file.content)).toEqual(['First derived resource'])
    expect(beforeManualEdit.resources?.map(file => file.content)).toEqual(['Second derived resource'])
    expect(afterManualEdit.resources?.map(file => file.content)).toEqual(['Human replacement'])
    expect((await capture()).resources).toEqual([])
    const historical = boundScopeSources(beforeManualEdit)[0]!
    const actor = {
      'app.agent_clearance': 'confidential', 'app.agent_compartments': JSON.stringify(['finance']),
      'app.agent_project_ids': 'null', 'app.agent_visibility_assistants': JSON.stringify([f.assistantId]),
    }
    expect((await admittedSkill(f.workspaceId, historical.resourceId, f.userId, actor)).snapshot)
      .toMatchObject({ version: historical.version, held: false })
  })
})
