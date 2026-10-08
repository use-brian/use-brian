import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, query } from '../../db/client.js'
import { createWorkspaceStore } from '../../db/workspace-store.js'
import { getBrainInboxRow } from '../../db/brain-inbox-store.js'
import { crmRoutes } from '../../routes/crm.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

async function fixture() {
  const workspace = randomUUID(), owner = randomUUID(), member = randomUUID()
  const research = randomUUID(), sales = randomUUID()
  for (const user of [owner, member]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
  await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional department fixture','test',$2)", [workspace, owner])
  for (const [user, role] of [[owner, 'owner'], [member, 'member']]) await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')", [workspace, user, role])
  await query("INSERT INTO assistants(id,name,workspace_id,kind,clearance,owner_user_id) VALUES($1,'Fixture assistant',$2,'primary','confidential',$3)", [randomUUID(), workspace, owner])
  for (const [id, name] of [[research, 'Research'], [sales, 'Sales']]) {
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,$3,$4,'team',$1::text,$5)", [id, workspace, name, owner, `team:${id}`])
    await query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,$3,$4,'team',$5)", [workspace, `team:${id}`, name, owner, id])
  }
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store') ON CONFLICT DO NOTHING", [workspace, sales, member])
  await query('UPDATE workspace_members SET home_department_id=$1 WHERE workspace_id=$2 AND user_id=$3', [research, workspace, owner])
  await query('UPDATE workspace_members SET home_department_id=$1 WHERE workspace_id=$2 AND user_id=$3', [sales, workspace, member])
  await query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [workspace])
  const app = express(); app.use(express.json())
  // Test transport supplies a principal; all membership, scope and writes use real stores.
  app.use((req, _res, next) => { Object.assign(req, { userId: req.header('x-fixture-user') }); next() })
  app.use('/crm', crmRoutes({ workspaceStore: createWorkspaceStore() }))
  return { app, workspace, owner, member, research, sales }
}

describe('[COMP:crm/creation-destination] real route and departmental storage', () => {
  it('previews the home, persists its classification, and hides it from a different department', async () => {
    const f = await fixture(), base = `/crm/${f.workspace}`
    const preview = await request(f.app).get(`${base}/creation-destination`).set('x-fixture-user', f.owner).expect(200)
    expect(preview.body.defaultDestination).toEqual({ departmentId: f.research, sensitivity: 'internal' })
    const created = await request(f.app).post(`${base}/records`).set('x-fixture-user', f.owner).send({ kind: 'contact', name: 'Fixture contact' }).expect(201)
    const row = (await query('SELECT sensitivity,compartments FROM entities WHERE id=$1', [created.body.id])).rows[0]
    expect(row).toMatchObject({ sensitivity: 'internal', compartments: [`team:${f.research}`] })
    await request(f.app).get(`${base}/records/${created.body.id}`).set('x-fixture-user', f.member).expect(404)
    expect(await getBrainInboxRow({ workspaceId: f.workspace, userId: f.member, primitive: 'contact', rowId: created.body.id })).toBeNull()
  })
  it('requires explicit General and refuses a stale or above-clearance department choice', async () => {
    const f = await fixture(), base = `/crm/${f.workspace}`
    const preview = await request(f.app).get(`${base}/creation-destination`).set('x-fixture-user', f.member).expect(200)
    expect(preview.body.departments.map((d: { id: string }) => d.id)).toEqual([f.sales])
    await request(f.app).post(`${base}/records`).set('x-fixture-user', f.member).send({ kind: 'company', name: 'Over tier', destination: { departmentId: f.sales, sensitivity: 'confidential' } }).expect(403)
    for (const kind of ['contact', 'company', 'deal']) {
      const general = await request(f.app).post(`${base}/records`).set('x-fixture-user', f.member).send({ kind, name: `General ${kind} fixture`, destination: { departmentId: null, sensitivity: 'internal' } }).expect(201)
      expect((await query('SELECT compartments FROM entities WHERE id=$1', [general.body.id])).rows[0].compartments).toEqual([])
      const brain = await getBrainInboxRow({ workspaceId: f.workspace, userId: f.member, primitive: kind as 'contact' | 'company' | 'deal', rowId: general.body.id })
      expect(brain?.body.name).toBe(`General ${kind} fixture`)
    }
    await query("UPDATE department_edges SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2", [f.workspace, f.member])
    await request(f.app).post(`${base}/records`).set('x-fixture-user', f.member).send({ kind: 'company', name: 'Revoked fixture', destination: { departmentId: f.sales, sensitivity: 'internal' } }).expect(403)
  })
  it('allows departmental clearance above General clearance through the actual create and read endpoints', async () => {
    const f = await fixture(), base = `/crm/${f.workspace}`
    await query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspace, f.member])
    await query("UPDATE department_edges SET clearance='confidential' WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3", [f.workspace, f.sales, f.member])
    const created = await request(f.app).post(`${base}/records`).set('x-fixture-user', f.member).send({ kind: 'company', name: 'Department clearance fixture', destination: { departmentId: f.sales, sensitivity: 'confidential' } })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await request(f.app).get(`${base}/records/${created.body.id}`).set('x-fixture-user', f.member).expect(200)
  })

})
