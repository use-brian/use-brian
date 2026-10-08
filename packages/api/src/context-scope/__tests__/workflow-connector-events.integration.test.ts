/** Connector events only start runs inside their connector's department audience. */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { connectorWorkflowEventAdmissibleSystem } from '../../workflow/connector-event-admission.js'
import { getPool } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

async function fixture() {
  const workspaceId = randomUUID(), custodian = randomUUID(), author = randomUUID(), cedar = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text),($2::uuid,$2::text)', [custodian, author])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional connector event workspace',$2)", [workspaceId, custodian])
  await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [workspaceId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [workspaceId, custodian, author])
  await pool.query(`INSERT INTO workspace_groups(id,workspace_id,kind,name,created_by,compartment_key,key)
    VALUES($1::uuid,$2,'team','Cedar',$3,$4,$1::text)`, [cedar, workspaceId, custodian, `team:${cedar}`])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)", [workspaceId, `team:${cedar}`, cedar])
  await pool.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin)
    VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING`, [workspaceId, cedar, author])
  const workflow = async (department: string | null) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO workflows(id,workspace_id,created_by,name,definition,context_group_id)
      VALUES($1,$2,$3,'Fictional listener','{}'::jsonb,$4)`, [id, workspaceId, author, department])
    return id
  }
  const connector = async (scope: 'workspace' | 'user', compartments: string[], owner: string | null = null) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO connector_instance(id,scope,workspace_id,user_id,provider,label,compartments)
      VALUES($1,$2,$3,$4,'fictional','Fictional mailbox',$5)`, [id, scope, scope === 'workspace' ? workspaceId : null, owner, compartments])
    return id
  }
  return { workspaceId, author, custodian, cedar, workflow, connector }
}

describe('[COMP:workflow/context-scope] Connector event admission', () => {
  afterAll(async () => { await Promise.all([pool.end(), getPool().end()]) })

  it('admits only events whose connector audience fits the workflow department and its author', async () => {
    const f = await fixture()
    const cedarFlow = await f.workflow(f.cedar), generalFlow = await f.workflow(null)
    const cedarMailbox = await f.connector('workspace', [`team:${f.cedar}`]), generalMailbox = await f.connector('workspace', [])
    const admit = (flow: string, instance: string) => connectorWorkflowEventAdmissibleSystem(flow, f.workspaceId, instance)

    expect(await admit(cedarFlow, cedarMailbox)).toBe(true)
    expect(await admit(cedarFlow, generalMailbox)).toBe(true)
    expect(await admit(generalFlow, generalMailbox)).toBe(true)
    // A Cedar mailbox's content never starts a General run.
    expect(await admit(generalFlow, cedarMailbox)).toBe(false)

    // A private connector reaches only its owner's workflows.
    expect(await admit(generalFlow, await f.connector('user', [], f.author))).toBe(true)
    expect(await admit(generalFlow, await f.connector('user', [], f.custodian))).toBe(false)

    // The author's current department authority is required, not just the saved context.
    await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.author])
    expect(await admit(cedarFlow, cedarMailbox)).toBe(false)

    await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1', [f.workspaceId])
    expect(await admit(generalFlow, cedarMailbox)).toBe(true)
  })
})
