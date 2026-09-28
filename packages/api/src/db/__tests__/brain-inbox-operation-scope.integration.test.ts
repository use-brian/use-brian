import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import type { AccessContext } from '@use-brian/core'

import {
  countBrainInbox,
  getBrainInboxRow,
  listBrainInbox,
  type BrainInboxPrimitive,
} from '../brain-inbox-store.js'
import { getAppPool, getPool } from '../client.js'
import { createMemory } from '../memories.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { resolveWorkspaceViewpoint } from '../workspace-viewpoint.js'

const { assertLocalFixture } = await import(
  new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
)
await assertLocalFixture()

const pool = getPool()

type Source = { primitive: BrainInboxPrimitive; id: string }

async function fixture() {
  const workspaceId = randomUUID()
  const ownerId = randomUUID()
  const memberId = randomUUID()
  const assistantId = randomUUID()
  const projectId = randomUUID()

  for (const userId of [ownerId, memberId]) {
    await pool.query(
      'INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',
      [userId],
    )
  }
  await pool.query(
    "INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Brain review fixture',$2)",
    [workspaceId, ownerId],
  )
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,'owner','assigned'),($1,$3,'member','assigned')",
    [workspaceId, ownerId, memberId],
  )
  await pool.query(
    "INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance,team_scope_mode) VALUES($1,$2,$3,'Fixture assistant','primary','confidential','all')",
    [assistantId, workspaceId, ownerId],
  )
  await pool.query(
    "INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",
    [projectId, workspaceId, ownerId],
  )

  const groups = createDbWorkspaceGroupStore()
  const finance = await groups.createTeam(ownerId, workspaceId, {
    name: 'Finance',
    key: 'finance',
  })
  const research = await groups.createTeam(ownerId, workspaceId, {
    name: 'Research',
    key: 'research',
  })
  const financeKey = finance.compartmentKey!

  const memory = await createMemory({
    workspaceId,
    assistantId,
    userId: null,
    createdByUserId: ownerId,
    scope: 'workspace',
    summary: 'Finance memory',
    sensitivity: 'internal',
    compartments: [financeKey],
  })
  const memoryId = memory.id
  const entityId = randomUUID()
  const edgeId = randomUUID()
  const taskId = randomUUID()
  const fileId = randomUUID()

  await pool.query("UPDATE memories SET source='model' WHERE id=$1", [memoryId])
  await pool.query(
    `INSERT INTO entities(
       id,workspace_id,kind,display_name,source,sensitivity,compartments,created_by_user_id
     ) VALUES($1,$2,'project','Finance entity','model','internal',$3,$4)`,
    [entityId, workspaceId, [financeKey], ownerId],
  )
  await pool.query(
    `INSERT INTO entity_links(
       id,workspace_id,source_kind,source_id,target_kind,target_id,edge_type,
       source,sensitivity,compartments,assistant_id
     ) VALUES($1,$2,'memory',$3,'entity',$4,'mentioned','model','internal',$5,$6)`,
    [edgeId, workspaceId, memoryId, entityId, [financeKey], assistantId],
  )
  await pool.query(
    `INSERT INTO tasks(
       id,workspace_id,title,source,sensitivity,compartments,created_by_user_id
     ) VALUES($1,$2,'Finance task','model','internal',$3,$4)`,
    [taskId, workspaceId, [financeKey], ownerId],
  )
  await pool.query(
    `INSERT INTO workspace_files(
       id,workspace_id,path,name,storage_uri,source,sensitivity,compartments,
       created_by_user_id
     ) VALUES($1,$2,$3,'finance.txt',$4,'model','internal',$5,$6)`,
    [
      fileId,
      workspaceId,
      `/fixtures/${fileId}.txt`,
      `gs://fixture/${fileId}`,
      [financeKey],
      ownerId,
    ],
  )

  const sources: Source[] = [
    { primitive: 'memory', id: memoryId },
    { primitive: 'entity', id: entityId },
    { primitive: 'entity_link', id: edgeId },
    { primitive: 'task', id: taskId },
    { primitive: 'workspace_file', id: fileId },
  ]

  async function grantRead() {
    const requestId = randomUUID()
    await pool.query(
      `INSERT INTO workspace_access_requests(
         id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,
         target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,
         status,decided_by,decided_at
       ) VALUES(
         $1,$2,$3,'member',$3,$4,'Fixture request',now()-interval '1 day',
         now()+interval '28 days',$5,1,'approved',$6,now()
       )`,
      [requestId, workspaceId, memberId, finance.id, 'a'.repeat(64), ownerId],
    )
    const result = await pool.query<{ id: string }>(
      `INSERT INTO workspace_access_grants(
         workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,
         starts_at,expires_at,approved_by
       ) SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,
                starts_at,expires_at,decided_by
           FROM workspace_access_requests WHERE id=$1
       RETURNING id`,
      [requestId],
    )
    return result.rows[0].id
  }

  async function visibleSources(access: AccessContext) {
    const listed = await listBrainInbox({ workspaceId, userId: memberId, access })
    const counted = await countBrainInbox({ workspaceId, userId: memberId, access })
    const detailed = await Promise.all(
      sources.map(({ primitive, id }) =>
        getBrainInboxRow({
          workspaceId,
          userId: memberId,
          access,
          primitive,
          rowId: id,
        }),
      ),
    )
    return {
      listed: new Set(listed.rows.map((row) => row.id)),
      counted,
      detailed,
    }
  }

  return {
    workspaceId,
    ownerId,
    memberId,
    finance,
    research,
    sources,
    taskId,
    projectId,
    grantRead,
    visibleSources,
  }
}

describe('[COMP:brain/inbox-store] current-source operation scope (integration)', () => {
  afterAll(async () => {
    await getAppPool().end()
    await pool.end()
  })

  it('makes every non-CRM review primitive readable through a real Team grant without granting mutation', async () => {
    const f = await fixture()
    const before = (await resolveWorkspaceViewpoint(f.memberId, f.workspaceId))!
    const denied = await f.visibleSources(before)
    expect(denied.listed.size).toBe(0)
    expect(denied.counted.total).toBe(0)
    expect(denied.detailed).toEqual(Array(f.sources.length).fill(null))

    const grantId = await f.grantRead()
    const allowed = (await resolveWorkspaceViewpoint(f.memberId, f.workspaceId))!
    expect(allowed).toMatchObject({
      compartments: [f.finance.compartmentKey],
      mutationCompartments: [],
    })
    const visible = await f.visibleSources(allowed)
    expect(visible.listed).toEqual(new Set(f.sources.map((source) => source.id)))
    expect(visible.counted.total).toBe(f.sources.length)
    expect(visible.counted.byPrimitive).toMatchObject({
      memory: 1,
      entity: 1,
      entity_link: 1,
      task: 1,
      workspace_file: 1,
    })
    expect(visible.detailed.map((row) => row?.id)).toEqual(
      f.sources.map((source) => source.id),
    )
    for (const source of f.sources) {
      expect(
        await getBrainInboxRow({
          workspaceId: f.workspaceId,
          userId: f.memberId,
          access: allowed,
          primitive: source.primitive,
          rowId: source.id,
          operation: 'mutation',
        }),
      ).toBeNull()
    }

    await pool.query(
      'UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1',
      [grantId, f.ownerId],
    )
    const revoked = await f.visibleSources(allowed)
    expect(revoked.listed.size).toBe(0)
    expect(revoked.counted.total).toBe(0)
    expect(revoked.detailed).toEqual(Array(f.sources.length).fill(null))
  })

  it('keeps list, count and detail in parity for every current-source exclusion', async () => {
    const f = await fixture()
    await f.grantRead()
    const access = (await resolveWorkspaceViewpoint(f.memberId, f.workspaceId))!

    const assertTaskHidden = async (candidate = access) => {
      const list = await listBrainInbox({
        workspaceId: f.workspaceId,
        userId: f.memberId,
        access: candidate,
        primitive: 'task',
      })
      const count = await countBrainInbox({
        workspaceId: f.workspaceId,
        userId: f.memberId,
        access: candidate,
      })
      const detail = await getBrainInboxRow({
        workspaceId: f.workspaceId,
        userId: f.memberId,
        access: candidate,
        primitive: 'task',
        rowId: f.taskId,
      })
      expect(list.rows).toEqual([])
      expect(count.byPrimitive.task).toBe(0)
      expect(detail).toBeNull()
    }

    await pool.query('UPDATE tasks SET compartments=$2 WHERE id=$1', [
      f.taskId,
      [f.research.compartmentKey],
    ])
    await assertTaskHidden()
    await pool.query('UPDATE tasks SET compartments=$2 WHERE id=$1', [
      f.taskId,
      [f.finance.compartmentKey],
    ])

    await pool.query("UPDATE tasks SET sensitivity='confidential' WHERE id=$1", [f.taskId])
    await assertTaskHidden()
    await pool.query("UPDATE tasks SET sensitivity='internal' WHERE id=$1", [f.taskId])

    await pool.query('UPDATE tasks SET project_ids=$2 WHERE id=$1', [
      f.taskId,
      [f.projectId],
    ])
    await assertTaskHidden({ ...access, projectIds: [] })
    await pool.query("UPDATE tasks SET project_ids='{}' WHERE id=$1", [f.taskId])

    await pool.query('UPDATE tasks SET user_id=$2 WHERE id=$1', [f.taskId, f.ownerId])
    await assertTaskHidden()
    await pool.query('UPDATE tasks SET user_id=NULL WHERE id=$1', [f.taskId])

    await pool.query('UPDATE tasks SET scope_held=true WHERE id=$1', [f.taskId])
    await assertTaskHidden()
    await pool.query('UPDATE tasks SET scope_held=false WHERE id=$1', [f.taskId])

    await pool.query('UPDATE tasks SET valid_to=now() WHERE id=$1', [f.taskId])
    await assertTaskHidden()
    await pool.query('UPDATE tasks SET valid_to=NULL WHERE id=$1', [f.taskId])

    await pool.query('UPDATE tasks SET retracted_at=now() WHERE id=$1', [f.taskId])
    await assertTaskHidden()
    await pool.query('UPDATE tasks SET retracted_at=NULL WHERE id=$1', [f.taskId])

    await pool.query(
      'DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
      [f.workspaceId, f.memberId],
    )
    await assertTaskHidden()
  })
})
