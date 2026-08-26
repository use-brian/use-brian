/** [COMP:api/context-scope-routes] Registry routes and activation barrier. */
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { ContextScopeStore } from '../../db/context-scope-store.js'
import type { WorkspaceGroupStore } from '../../db/workspace-group-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import { contextScopeRoutes } from '../context-scopes.js'
import type { ContextReadiness } from '../../context-scope/context-readiness.js'

const WID = '11111111-1111-1111-1111-111111111111'
const GID = '22222222-2222-2222-2222-222222222222'
const AID = '33333333-3333-3333-3333-333333333333'
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

function makeApp(role: 'owner' | 'admin' | 'member' | null = 'owner') {
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
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = 'user-1'
    next()
  })
  app.use('/api', contextScopeRoutes({
    workspaceStore,
    groupStore,
    contextStore,
    getReadiness: vi.fn().mockResolvedValue(blocked),
    connectorInstanceStore: connectorInstanceStore as never,
    connectorGrantStore: connectorGrantStore as never,
    reclassificationStore: reclassificationStore as never,
  }))
  return {
    app,
    workspaceStore,
    groupStore,
    contextStore,
    connectorInstanceStore,
    connectorGrantStore,
    reclassificationStore,
  }
}

describe('[COMP:api/context-scope-routes] Teams and Projects REST contract', () => {
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

  it('enforces readiness on the server before assigning a Team to an assistant', async () => {
    const { app, groupStore } = makeApp('admin')
    const response = await request(app)
      .put(`/api/workspaces/${WID}/groups/${GID}/assistants/${AID}`)
      .send({})
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      error: 'context_activation_blocked',
      failedChecks: ['connectors'],
    })
    expect(groupStore.setTeamAssistant).not.toHaveBeenCalled()
  })

  it('updates Team metadata through the first-class registry route', async () => {
    const { app, groupStore } = makeApp('admin')
    const response = await request(app)
      .patch(`/api/workspaces/${WID}/groups/${GID}`)
      .send({ name: 'Finance', description: 'Close and reporting', color: '#334455' })
    expect(response.status).toBe(200)
    expect(response.body.group).toMatchObject({ id: GID, name: 'Finance', color: '#334455' })
    expect(groupStore.updateTeam).toHaveBeenCalledWith('user-1', GID, {
      name: 'Finance', description: 'Close and reporting', color: '#334455',
    })
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

  it('enforces readiness before turning a company-wide connector into a scoped capability', async () => {
    const { app, connectorInstanceStore } = makeApp('admin')
    const response = await request(app)
      .put(`/api/workspaces/${WID}/connectors/${CONNECTOR_ID}/context`)
      .send({ contextGroupId: GID, contextProjectId: null })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      error: 'context_activation_blocked',
      failedChecks: ['connectors'],
    })
    expect(connectorInstanceStore.update).not.toHaveBeenCalled()
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
