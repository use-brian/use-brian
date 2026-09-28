import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { ScopeSource } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { createMemory, type Memory } from '../memories.js'
import {
  applyDerivedSkillPatch,
  createDerivedWorkspaceSkill,
  readWorkspaceSkillRevisionSource,
  recordDerivedSkillRederivation,
} from '../skill-derived-store.js'

const { assertLocalFixture } = await import(
  new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
)
await assertLocalFixture()

const pool = getPool()

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
})
