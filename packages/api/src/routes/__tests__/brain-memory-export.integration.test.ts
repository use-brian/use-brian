/** [COMP:api/memory-bulk-export] */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { getAppPool, getPool } from '../../db/client.js'
import { createMemory } from '../../db/memories.js'
import { createMemoryExportObserver } from '../../memory-bulk-export.js'
import { brainMemoryExportRoutes } from '../brain-memory-export.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const secret = 'fictional-memory-export-fixture'
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function fixture() {
  const workspaceId = randomUUID()
  const owner = randomUUID()
  const member = randomUUID()
  const outsider = randomUUID()
  const primary = randomUUID()
  const otherAssistant = randomUUID()
  let entitled = true
  let checkEntitlement: (() => Promise<void>) | undefined
  await pool.query('INSERT INTO users(id,auth_provider_id) SELECT id,id::text FROM unnest($1::uuid[]) id', [[owner, member, outsider]])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional Atlas',$2,false)", [workspaceId, owner])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance)
    VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')`, [workspaceId, owner, member])
  await pool.query(`INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance)
    VALUES($1,'Atlas primary',$2,$3,'primary','confidential'),($4,'Atlas notebook',$2,$3,'standard','confidential')`,
  [primary, workspaceId, owner, otherAssistant])
  const app = express()
  const logEvent = vi.fn()
  app.use(express.json())
  app.use('/api/brain', requireAuth(secret), brainMemoryExportRoutes(async id => {
    if (id !== workspaceId) throw new Error('Wrong entitlement workspace')
    await checkEntitlement?.()
    return entitled
  }, createMemoryExportObserver({ logEvent })))
  async function tokenFor(userId: string) {
    const session = await authSessionStore.create(userId, { deviceLabel: 'Fictional browser', userAgent: null, ipAddress: null })
    if (!session) throw new Error('Fixture session missing')
    return createTokens(userId, secret, session).accessToken
  }
  function save(summary: string, fields: Partial<Parameters<typeof createMemory>[0]> = {}) {
    return createMemory({ assistantId: primary, userId: null, workspaceId, summary, sensitivity: 'internal',
      createdByUserId: owner, createdByAssistantId: primary, source: 'user', ...fields })
  }
  const tokens = {
    owner: await tokenFor(owner),
    member: await tokenFor(member),
    outsider: await tokenFor(outsider),
  }
  return {
    workspaceId, owner, member, primary, otherAssistant, save, logEvent,
    paid: (allowed: boolean) => { entitled = allowed },
    onEntitlementCheck: (fn: () => Promise<void>) => { checkEntitlement = fn },
    file: (who: keyof typeof tokens = 'owner', format = 'csv') => request(app).post('/api/brain/memories/export')
      .set('Authorization', `Bearer ${tokens[who]}`).send({ workspaceId, format }),
  }
}

const exportedIds = (csv: string) => [...csv.matchAll(/^"([0-9a-f-]{36})","/gm)].map(row => row[1]).sort()

describe('paid workspace Memory HTTP download', () => {
  it('exports exactly the current viewer’s private and shared rows across pages, assistants and projects', async () => {
    const f = await fixture()
    const projectId = randomUUID()
    await pool.query(`INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by)
      VALUES($1,$2,'Launch project','launch project',$3)`, [projectId, f.workspaceId, f.owner])
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)', [projectId, f.member])
    const shared = []
    for (let i = 0; i < 66; i++) shared.push((await f.save(`Workspace decision ${i}`)).id)
    const project = await f.save('Proyecto 日本語', { detail: 'línea "uno"\n第二行', projectIds: [projectId],
      assistantId: f.otherAssistant, createdByAssistantId: f.otherAssistant })
    const ownerPrivate = await f.save('Owner draft', { userId: f.owner, assistantId: f.otherAssistant, createdByAssistantId: f.otherAssistant })
    const memberPrivate = await f.save('Member draft', { userId: f.member, createdByUserId: f.member })
    const restricted = await f.save('Confidential decision', { sensitivity: 'confidential' })
    const owner = await f.file()
    expect(owner.status, JSON.stringify(owner.body)).toBe(200)
    expect(owner.headers['content-disposition']).toBe('attachment; filename="brian-memories.csv"')
    expect(owner.headers['cache-control']).toBe('no-store')
    expect(exportedIds(owner.text)).toEqual([...shared, project.id, ownerPrivate.id, restricted.id].sort())
    expect(owner.text).toContain('Proyecto 日本語","línea ""uno""\n第二行"')
    const member = await f.file('member')
    expect(member.status, JSON.stringify(member.body)).toBe(200)
    expect(exportedIds(member.text)).toEqual([...shared, project.id, memberPrivate.id].sort())
    const denied = await f.file('outsider')
    expect(denied.status).toBe(404)
    expect(denied.headers['content-disposition']).toBeUndefined()
  }, 45_000)

  it('returns an empty Markdown file and an upgrade prompt scoped to the workspace owner', async () => {
    const f = await fixture()
    const empty = await f.file('owner', 'markdown')
    expect(empty.status).toBe(200)
    expect(empty.text).toBe('# Brian memories\n\n')
    f.paid(false)
    expect((await f.file()).body).toEqual({ error: 'paid_memory_export_required', canManageBilling: true })
    expect((await f.file('member')).body).toEqual({ error: 'paid_memory_export_required', canManageBilling: false })
    expect((await f.file('outsider')).status).toBe(404)
    expect(f.logEvent.mock.calls.flat()).toEqual([
      { userId: f.owner, eventName: 'memory_bulk_export_download_served', metadata: { workspace_id: f.workspaceId, format: 'markdown', entrypoint: 'brain' } },
      { userId: f.owner, eventName: 'memory_bulk_export_upgrade_required', metadata: { workspace_id: f.workspaceId, format: 'csv', entrypoint: 'brain' } },
      { userId: f.member, eventName: 'memory_bulk_export_upgrade_required', metadata: { workspace_id: f.workspaceId, format: 'csv', entrypoint: 'brain' } },
    ])
  })

  it('withholds all file bytes when access is lost during generation', async () => {
    const f = await fixture()
    await f.save('Decision available before access removal')
    let checks = 0
    f.onEntitlementCheck(async () => {
      if (++checks === 2) await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.member])
    })
    const response = await f.file('member')
    expect(checks).toBe(2)
    expect(response.status).toBe(404)
    expect(response.headers['content-disposition']).toBeUndefined()
    expect(response.text).not.toContain('Decision available')
    expect(f.logEvent).not.toHaveBeenCalled()
  })
})
