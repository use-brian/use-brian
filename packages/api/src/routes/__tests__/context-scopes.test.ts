/** [COMP:api/context-scope-routes] Registry routes and activation barrier. */
import { WorkspaceAccessError } from '../../workspace-access/policy.js'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

const { departmentsMock } = vi.hoisted(() => ({
  departmentsMock: vi.fn(async () => new Map<string, string>()),
}))
vi.mock('../../db/department-store.js', () => ({ departmentClearancesForUserSystem: departmentsMock }))
import type { ContextScopeStore } from '../../db/context-scope-store.js'
import type { WorkspaceGroupStore } from '../../db/workspace-group-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import { contextScopeRoutes } from '../context-scopes.js'
import type { ContextReadiness } from '../../context-scope/context-readiness.js'

const WID = '11111111-1111-1111-1111-111111111111'
const GID = '22222222-2222-2222-2222-222222222222'
const AID = '33333333-3333-3333-3333-333333333333'
const reviewHeaders = {'X-Brian-Access-Review-Id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','X-Brian-Access-Review-Hash':'a'.repeat(64)}
const CONNECTOR_ID = '44444444-4444-4444-8444-444444444444'

const blocked: ContextReadiness = {
  enforcementVersion: 1,
  readyForActivation: false,
  checks: [{
    id: 'connectors', ready: false, blocking: true,
    detail: 'A connector is not scope-bound.',
  }],
  legacyGeneral: {},
}

function makeApp(role: 'owner' | 'admin' | 'member' | null = 'owner', opts: { deriveDepartmental?: boolean } = {}) {
  const workspaceStore = {
    getRole: vi.fn().mockResolvedValue(role),
  } as unknown as WorkspaceStore
  const groupStore = {
    listGroups: vi.fn().mockResolvedValue([]),
    setTeamAssistant: vi.fn(),
    updateTeam: vi.fn().mockResolvedValue({
      id: GID,
      workspaceId: WID,
      name: 'Finance',
      key: 'accounting',
      description: 'Close and reporting',
      color: '#334455',
      status: 'active',
      readAll: false,
      memberCount: 1,
      createdAt: '2026-08-26T00:00:00.000Z',
    }),
  } as unknown as WorkspaceGroupStore
  const contextStore = {
    listTeams: vi.fn().mockResolvedValue([]),
    listProjects: vi.fn().mockResolvedValue([]),
    getTeamSystem: vi.fn().mockResolvedValue({
      id: GID,
      workspaceId: WID,
      name: 'Accounting',
      key: 'accounting',
      status: 'active',
      compartmentKey: `team:${GID}`,
      readAll: false,
      readBundle: [`team:${GID}`],
    }),
    getProjectSystem: vi.fn().mockResolvedValue(null),
    updateProject: vi.fn().mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555',
      workspaceId: WID,
      name: 'Atlas',
      status: 'active',
    }),
  } as unknown as ContextScopeStore
  const connectorInstanceStore = {
    get: vi.fn().mockResolvedValue({
      id: CONNECTOR_ID,
      workspaceId: WID,
      scope: 'workspace',
      compartments: [],
      projectIds: [],
    }),
    update: vi.fn().mockResolvedValue({ id: CONNECTOR_ID }),
  }
  const connectorGrantStore = {
    listForTargetSystem: vi.fn().mockResolvedValue([]),
    updateContext: vi.fn(),
  }
  const reclassificationStore = {
    append: vi.fn(),
    reclassify: vi.fn(),
    getRequirements: vi.fn().mockResolvedValue(null),
  }
  const getReadiness=vi.fn().mockResolvedValue(blocked)
  const getDepartmentalReadiness=vi.fn().mockResolvedValue({ready:false,enforcementVersion:1,requiredEnforcementVersion:2,missingCapabilities:['replay_delivery']})
  const executeAccessCommand=vi.fn().mockResolvedValue({appliedCommand:{subjectId:GID}})
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = 'user-1'
    next()
  })
  app.use('/api', contextScopeRoutes({
    workspaceStore,
    executeAccessCommand,
    groupStore,
    contextStore,
    getReadiness,
    ...(opts.deriveDepartmental ? {} : { getDepartmentalReadiness }),
    connectorInstanceStore: connectorInstanceStore as never,
    connectorGrantStore: connectorGrantStore as never,
    reclassificationStore: reclassificationStore as never,
  }))
  return {
    app,
    workspaceStore,
    executeAccessCommand,
    groupStore,
    contextStore,
    connectorInstanceStore,
    connectorGrantStore,
    reclassificationStore,
    getReadiness,
  }
}

describe('[COMP:api/context-scope-routes] Teams and Projects REST contract', () => {
  it('does not show activation ready when the older context checks pass but departments are incomplete',async()=>{
    const {app,getReadiness}=makeApp('admin')
    getReadiness.mockResolvedValue({...blocked,readyForActivation:true,checks:[]})
    const response=await request(app).get(`/api/workspaces/${WID}/context/readiness`)
    expect(response.status).toBe(200)
    expect(response.body.readyForActivation).toBe(false)
    expect(response.body.checks).toContainEqual(expect.objectContaining({id:'delegation',blocking:true,ready:false}))
  })
  it('derives the departmental verdict from the same evidence pass instead of probing twice',async()=>{
    const {app,getReadiness}=makeApp('admin',{deriveDepartmental:true})
    const response=await request(app).get(`/api/workspaces/${WID}/context/readiness`)
    expect(response.status).toBe(200)
    expect(getReadiness).toHaveBeenCalledTimes(1)
    expect(response.body.departmental).toMatchObject({ready:false,missingCapabilities:expect.arrayContaining(['enforcement_version'])})
    expect(response.body.readyForActivation).toBe(false)
  })
  it('hides a workspace from non-members', async () => {
    const { app } = makeApp(null)
    const response = await request(app).get(`/api/workspaces/${WID}/groups`)
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'not_found' })
  })

  it('lets members list the visible Team registry', async () => {
    const { app, groupStore, contextStore } = makeApp('member')
    const response = await request(app).get(`/api/workspaces/${WID}/groups`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ groups: [] })
    expect(groupStore.listGroups).toHaveBeenCalledWith('user-1', WID)
    expect(contextStore.listTeams).toHaveBeenCalledWith('user-1', WID)
  })

  it('rejects missing or malformed review proof before invoking the writer',async()=>{
    const {app,executeAccessCommand}=makeApp('admin')
    for(const headers of [{},{...reviewHeaders,'X-Brian-Access-Review-Id':'invalid'}]){
      const response=await request(app).put(`/api/workspaces/${WID}/groups/${GID}/members/${AID}`).set(headers).send({})
      expect(response.status).toBe(409);expect(response.body.error).toBe('access_review_required')
    }
    expect(executeAccessCommand).not.toHaveBeenCalled()
  })

  it('enforces readiness on the server before assigning a Team to an assistant', async () => {
    const { app, groupStore,executeAccessCommand } = makeApp('admin')
    executeAccessCommand.mockRejectedValueOnce(new WorkspaceAccessError('departmental_enforcement_incomplete',409))
    const response = await request(app)
      .put(`/api/workspaces/${WID}/groups/${GID}/assistants/${AID}`).set(reviewHeaders)
      .send({})
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      error: 'departmental_enforcement_incomplete',
    })
    expect(groupStore.setTeamAssistant).not.toHaveBeenCalled()
  })

  it('updates Team metadata through the first-class registry route', async () => {
    const { app, groupStore,executeAccessCommand } = makeApp('admin')
    vi.mocked(groupStore.listGroups).mockResolvedValueOnce([{id:GID,workspaceId:WID,kind:'team',name:'Finance',color:'#334455'}] as never)
    const response = await request(app)
      .patch(`/api/workspaces/${WID}/groups/${GID}`).set(reviewHeaders)
      .send({ name: 'Finance', description: 'Close and reporting', color: '#334455' })
    expect(response.status).toBe(200)
    expect(response.body.group).toMatchObject({ id: GID, name: 'Finance', color: '#334455' })
    expect(executeAccessCommand).toHaveBeenCalledWith(WID,'user-1', {
      type:'department.update',teamId:GID,name: 'Finance', description: 'Close and reporting', color: '#334455',
    },{type:'access.command.apply',reviewId:reviewHeaders['X-Brian-Access-Review-Id'],payloadHash:reviewHeaders['X-Brian-Access-Review-Hash']})
  })

  it('updates Project metadata without treating Project participation as an ACL', async () => {
    const projectId = '55555555-5555-4555-8555-555555555555'
    const { app, contextStore } = makeApp('admin')
    const response = await request(app)
      .patch(`/api/workspaces/${WID}/projects/${projectId}`)
      .send({ name: 'Atlas' })
    expect(response.status).toBe(200)
    expect(response.body.project).toMatchObject({ id: projectId, name: 'Atlas' })
    expect(contextStore.updateProject).toHaveBeenCalledWith(
      'user-1', WID, projectId, { name: 'Atlas' },
    )
  })

  it('labels a connector with a department without the activation barrier (an audience, not a scope claim)', async () => {
    const { app, connectorInstanceStore } = makeApp('admin')
    connectorInstanceStore.get.mockResolvedValue({
      id: CONNECTOR_ID, workspaceId: WID, scope: 'workspace', compartments: [], projectIds: [],
    })
    connectorInstanceStore.update.mockResolvedValue({ id: CONNECTOR_ID })
    const response = await request(app)
      .put(`/api/workspaces/${WID}/connectors/${CONNECTOR_ID}/context`)
      .send({ contextGroupId: GID })
    expect(response.status).toBe(204)
    expect(connectorInstanceStore.update).toHaveBeenCalledWith('user-1', CONNECTOR_ID, {
      compartments: [`team:${GID}`], projectIds: [],
    })
  })

  it('lets the member who exposed a connector move it only into a department they hold', async () => {
    const { app, connectorGrantStore } = makeApp('member')
    connectorGrantStore.listForTargetSystem.mockResolvedValue([{
      id: 'grant-1', connectorInstanceId: CONNECTOR_ID, grantedByUserId: 'user-1',
      compartments: [], projectIds: [],
      instance: { id: CONNECTOR_ID, scope: 'user', workspaceId: null, compartments: [], projectIds: [] },
    }])
    connectorGrantStore.updateContext.mockResolvedValue(true)
    departmentsMock.mockResolvedValueOnce(new Map())
    const refused = await request(app)
      .put(`/api/workspaces/${WID}/connectors/${CONNECTOR_ID}/context`)
      .send({ contextGroupId: GID })
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ error: 'connector_department_not_held' })
    departmentsMock.mockResolvedValueOnce(new Map([[GID, 'internal']]))
    const allowed = await request(app)
      .put(`/api/workspaces/${WID}/connectors/${CONNECTOR_ID}/context`)
      .send({ contextGroupId: GID })
    expect(allowed.status).toBe(204)
    expect(connectorGrantStore.updateContext).toHaveBeenCalledWith(
      'user-1', 'grant-1', [`team:${GID}`], [],
    )
  })

  it('hides a teammate connector in another department and refuses edits outside the audience', async () => {
    const { app, connectorGrantStore } = makeApp('member')
    connectorGrantStore.listForTargetSystem.mockResolvedValue([{
      id: 'grant-1', connectorInstanceId: CONNECTOR_ID, grantedByUserId: 'teammate',
      compartments: [`team:${GID}`], projectIds: [],
      instance: { id: CONNECTOR_ID, scope: 'user', workspaceId: null, compartments: [], projectIds: [] },
    }])
    const hidden = await request(app).get(`/api/workspaces/${WID}/connectors/${CONNECTOR_ID}/context`)
    expect(hidden.status).toBe(404)
    departmentsMock.mockResolvedValueOnce(new Map([[GID, 'internal']]))
    const viewer = await request(app).get(`/api/workspaces/${WID}/connectors/${CONNECTOR_ID}/context`)
    expect(viewer.status).toBe(200)
    expect(viewer.body.canEdit).toBe(false)
    departmentsMock.mockResolvedValueOnce(new Map([[GID, 'internal']]))
    const edit = await request(app)
      .put(`/api/workspaces/${WID}/connectors/${CONNECTOR_ID}/context`)
      .send({ contextGroupId: null })
    expect(edit.status).toBe(403)
    expect(connectorGrantStore.updateContext).not.toHaveBeenCalled()
  })

  it('projects connector bindings as stable Team ids and never exposes compartment keys', async () => {
    const { app, connectorInstanceStore, contextStore } = makeApp('admin')
    connectorInstanceStore.get.mockResolvedValue({
      id: CONNECTOR_ID,
      workspaceId: WID,
      scope: 'workspace',
      compartments: [`team:${GID}`],
      projectIds: [],
    })
    ;(contextStore.listTeams as ReturnType<typeof vi.fn>).mockResolvedValue([{
      id: GID,
      name: 'Accounting',
      compartmentKey: `team:${GID}`,
    }])

    const response = await request(app)
      .get(`/api/workspaces/${WID}/connectors/${CONNECTOR_ID}/context`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      context: { contextGroupId: GID, contextProjectId: null },
      canEdit: true,
    })
    expect(JSON.stringify(response.body)).not.toContain(`team:${GID}`)
  })

  it('updates a teammate-owned connector through its workspace grant without owner-scoped instance access', async () => {
    const { app, connectorInstanceStore, connectorGrantStore } = makeApp('admin')
    connectorInstanceStore.get.mockResolvedValue(null)
    connectorGrantStore.listForTargetSystem.mockResolvedValue([{
      id: 'grant-1',
      connectorInstanceId: CONNECTOR_ID,
      compartments: [],
      projectIds: [],
      instance: {
        id: CONNECTOR_ID,
        scope: 'user',
        workspaceId: null,
        compartments: [],
        projectIds: [],
      },
    }])
    connectorGrantStore.updateContext.mockResolvedValue(true)

    const response = await request(app)
      .put(`/api/workspaces/${WID}/connectors/${CONNECTOR_ID}/context`)
      .send({ contextGroupId: null, contextProjectId: null })

    expect(response.status).toBe(204)
    expect(connectorInstanceStore.get).not.toHaveBeenCalled()
    expect(connectorGrantStore.updateContext).toHaveBeenCalledWith(
      'user-1',
      'grant-1',
      [],
      [],
    )
  })

  it('explains reclassifiable scope with stable ids while only flagging undisclosed legacy requirements', async () => {
    const { app, contextStore, reclassificationStore } = makeApp('member')
    reclassificationStore.getRequirements.mockResolvedValue({
      compartments: [`team:${GID}`, 'legacy:client-principal'],
      projectIds: [],
    })
    ;(contextStore.listTeams as ReturnType<typeof vi.fn>).mockResolvedValue([{
      id: GID,
      name: 'Accounting',
      compartmentKey: `team:${GID}`,
    }])

    const response = await request(app)
      .get(`/api/workspaces/${WID}/context/reclassify?primitive=memory&rowId=memory-1`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      context: {
        teamIds: [GID],
        projectIds: [],
        hasOtherCompartments: true,
      },
    })
    expect(JSON.stringify(response.body)).not.toContain('legacy:client-principal')
    expect(JSON.stringify(response.body)).not.toContain(`team:${GID}`)
  })
})
