/**
 * Unit tests for the brain-key management routes.
 * Component tag: [COMP:api/brain-keys-route].
 *
 * The routes take their `brainKeyStore` + `workspaceStore` as injected
 * deps and mount with `mergeParams` under
 * `/api/workspaces/:workspaceId/brain-keys`. Issuing a brain credential
 * is an admin action, so every handler is gated to owner/admin; a
 * non-member gets 404 (membership not probeable). We exercise the gate
 * ladder (401 → invalid-uuid 400 → 404 non-member → 403 non-admin) and
 * the CRUD happy + not-found paths via supertest.
 *
 * Spec: docs/architecture/features/programmatic-access.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { BrainKeyStore, CreatedBrainKey } from '../../db/brain-keys-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import { brainKeysRoutes } from '../brain-keys.js'

const WID = '11111111-1111-1111-1111-111111111111'
const KID = '22222222-2222-2222-2222-222222222222'
const TEAM_ID = '33333333-3333-4333-8333-333333333333'
const PROJECT_ID = '44444444-4444-4444-8444-444444444444'

const CREATED: CreatedBrainKey = {
  id: KID,
  workspaceId: WID,
  name: 'CI key',
  prefix: 'sk_brain_2222',
  scope: 'read_write',
  status: 'active',
  maxClearance: null,
  contextGroupId: null,
  contextProjectId: null,
  createdBy: 'u1',
  createdAt: new Date('2026-07-07T00:00:00.000Z'),
  lastUsedAt: null,
  plaintext: 'sk_brain_2222_supersecretplaintext',
}

function makeDeps() {
  const brainKeyStore = {
    create: vi.fn().mockResolvedValue(CREATED),
    listForWorkspace: vi.fn().mockResolvedValue([{ ...CREATED, plaintext: undefined }]),
    getByIdSystem: vi.fn(),
    revoke: vi.fn().mockResolvedValue(true),
    updateMaxClearance: vi.fn().mockResolvedValue(true),
    touchLastUsedAt: vi.fn(),
  } as unknown as BrainKeyStore
  const workspaceStore = {
    getRole: vi.fn().mockResolvedValue('owner'),
  } as unknown as WorkspaceStore
  const contextStore = {
    getTeamSystem: vi.fn().mockResolvedValue({ id: TEAM_ID, status: 'active' }),
    getProjectSystem: vi.fn().mockResolvedValue({ id: PROJECT_ID, status: 'active' }),
  }
  const getContextReadiness = vi.fn().mockResolvedValue({
    enforcementVersion: 1,
    readyForActivation: true,
    checks: [],
    legacyGeneral: {},
  })
  return { brainKeyStore, workspaceStore, contextStore: contextStore as never, getContextReadiness }
}

function makeApp(deps: ReturnType<typeof makeDeps>, userId?: string) {
  const app = express()
  app.use(express.json())
  if (userId) {
    app.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = userId
      next()
    })
  }
  // mergeParams path — the router reads `:workspaceId` from the mount.
  app.use('/api/workspaces/:workspaceId/brain-keys', brainKeysRoutes(deps))
  return app
}

const base = `/api/workspaces/${WID}/brain-keys`

describe('[COMP:api/brain-keys-route] gate ladder', () => {
  let deps: ReturnType<typeof makeDeps>
  beforeEach(() => {
    deps = makeDeps()
  })

  it('401 without auth', async () => {
    const res = await request(makeApp(deps)).get(base)
    expect(res.status).toBe(401)
  })

  it('400 on a non-uuid workspace id', async () => {
    const res = await request(makeApp(deps, 'u1')).get('/api/workspaces/not-a-uuid/brain-keys')
    expect(res.status).toBe(400)
  })

  it('404 when not a member (membership not probeable)', async () => {
    deps.workspaceStore.getRole = vi.fn().mockResolvedValue(null)
    const res = await request(makeApp(deps, 'u1')).get(base)
    expect(res.status).toBe(404)
    expect(deps.brainKeyStore.listForWorkspace).not.toHaveBeenCalled()
  })

  it('403 for a non-admin member', async () => {
    deps.workspaceStore.getRole = vi.fn().mockResolvedValue('member')
    const res = await request(makeApp(deps, 'u1')).get(base)
    expect(res.status).toBe(403)
    expect(deps.brainKeyStore.listForWorkspace).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/brain-keys-route] GET / (list)', () => {
  it('200 returns keys for an owner (no plaintext)', async () => {
    const deps = makeDeps()
    const res = await request(makeApp(deps, 'u1')).get(base)
    expect(res.status).toBe(200)
    expect(res.body.keys).toHaveLength(1)
    expect(res.body.keys[0].plaintext).toBeUndefined()
    expect(deps.brainKeyStore.listForWorkspace).toHaveBeenCalledWith('u1', WID)
  })
})

describe('[COMP:api/brain-keys-route] POST / (create)', () => {
  it('200 returns the plaintext key exactly once', async () => {
    const deps = makeDeps()
    const res = await request(makeApp(deps, 'u1'))
      .post(base)
      .send({ name: 'CI key', scope: 'read_write' })
    expect(res.status).toBe(200)
    expect(res.body.key).toBe(CREATED.plaintext)
    expect(res.body.prefix).toBe(CREATED.prefix)
    expect(deps.brainKeyStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WID, name: 'CI key', scope: 'read_write', actingUserId: 'u1' }),
    )
  })

  it('400 on invalid body (missing name)', async () => {
    const deps = makeDeps()
    const res = await request(makeApp(deps, 'u1')).post(base).send({ scope: 'read_write' })
    expect(res.status).toBe(400)
    expect(deps.brainKeyStore.create).not.toHaveBeenCalled()
  })

  it('400 on an unknown maxClearance tier', async () => {
    const deps = makeDeps()
    const res = await request(makeApp(deps, 'u1'))
      .post(base)
      .send({ name: 'x', maxClearance: 'top_secret' })
    expect(res.status).toBe(400)
  })

  it('issues a key with stable Team/Project bindings after readiness and active-registry checks', async () => {
    const deps = makeDeps()
    deps.brainKeyStore.create = vi.fn().mockResolvedValue({
      ...CREATED,
      contextGroupId: TEAM_ID,
      contextProjectId: PROJECT_ID,
    })
    const res = await request(makeApp(deps, 'u1'))
      .post(base)
      .send({
        name: 'Scoped agent',
        contextGroupId: TEAM_ID,
        contextProjectId: PROJECT_ID,
      })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ contextGroupId: TEAM_ID, contextProjectId: PROJECT_ID })
    expect(deps.brainKeyStore.create).toHaveBeenCalledWith(expect.objectContaining({
      contextGroupId: TEAM_ID,
      contextProjectId: PROJECT_ID,
    }))
  })

  it('does not issue a scoped key while readiness is red', async () => {
    const deps = makeDeps()
    deps.getContextReadiness.mockResolvedValue({
      enforcementVersion: 1,
      readyForActivation: false,
      checks: [{ id: 'connectors', ready: false, blocking: true, detail: 'missing' }],
      legacyGeneral: {},
    })
    const res = await request(makeApp(deps, 'u1'))
      .post(base)
      .send({ name: 'Scoped agent', contextGroupId: TEAM_ID })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'context_activation_blocked',
      failedChecks: ['connectors'],
    })
    expect(deps.brainKeyStore.create).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/brain-keys-route] PATCH /:keyId (clearance cap)', () => {
  it('204 sets the cap', async () => {
    const deps = makeDeps()
    const res = await request(makeApp(deps, 'u1'))
      .patch(`${base}/${KID}`)
      .send({ maxClearance: 'internal' })
    expect(res.status).toBe(204)
    expect(deps.brainKeyStore.updateMaxClearance).toHaveBeenCalledWith('u1', KID, 'internal')
  })

  it('204 clears the cap with null', async () => {
    const deps = makeDeps()
    const res = await request(makeApp(deps, 'u1'))
      .patch(`${base}/${KID}`)
      .send({ maxClearance: null })
    expect(res.status).toBe(204)
    expect(deps.brainKeyStore.updateMaxClearance).toHaveBeenCalledWith('u1', KID, null)
  })

  it('404 on a non-uuid key id', async () => {
    const deps = makeDeps()
    const res = await request(makeApp(deps, 'u1'))
      .patch(`${base}/not-a-uuid`)
      .send({ maxClearance: null })
    expect(res.status).toBe(404)
    expect(deps.brainKeyStore.updateMaxClearance).not.toHaveBeenCalled()
  })

  it('404 when the key is not visible to the caller (RLS 0 rows)', async () => {
    const deps = makeDeps()
    deps.brainKeyStore.updateMaxClearance = vi.fn().mockResolvedValue(false)
    const res = await request(makeApp(deps, 'u1'))
      .patch(`${base}/${KID}`)
      .send({ maxClearance: null })
    expect(res.status).toBe(404)
  })
})

describe('[COMP:api/brain-keys-route] DELETE /:keyId (revoke)', () => {
  it('204 revokes a key', async () => {
    const deps = makeDeps()
    const res = await request(makeApp(deps, 'u1')).delete(`${base}/${KID}`)
    expect(res.status).toBe(204)
    expect(deps.brainKeyStore.revoke).toHaveBeenCalledWith('u1', KID)
  })

  it('404 when the key is not visible to the caller', async () => {
    const deps = makeDeps()
    deps.brainKeyStore.revoke = vi.fn().mockResolvedValue(false)
    const res = await request(makeApp(deps, 'u1')).delete(`${base}/${KID}`)
    expect(res.status).toBe(404)
  })
})
