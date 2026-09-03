import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { OAuthAuthorizationStore } from '../../db/oauth-authorization-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import { oauthAuthorizationsRoutes } from '../oauth-authorizations.js'

const WID = '11111111-1111-4111-8111-111111111111'
const AUTH_ID = '22222222-2222-4222-8222-222222222222'
const AID = '33333333-3333-4333-8333-333333333333'
const PID = '44444444-4444-4444-8444-444444444444'

function makeDeps() {
  const authorizationStore = {
    listForWorkspace: vi.fn().mockResolvedValue([]),
    updateCaptureBinding: vi.fn().mockResolvedValue(true),
    revoke: vi.fn().mockResolvedValue(true),
  } as unknown as OAuthAuthorizationStore
  const workspaceStore = {
    getRole: vi.fn().mockResolvedValue('owner'),
  } as unknown as WorkspaceStore
  return { authorizationStore, workspaceStore }
}

function app(deps: ReturnType<typeof makeDeps>) {
  const value = express()
  value.use(express.json())
  value.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = '55555555-5555-4555-8555-555555555555'
    next()
  })
  value.use(
    '/api/workspaces/:workspaceId/oauth-authorizations',
    oauthAuthorizationsRoutes(deps),
  )
  return value
}

describe('[COMP:api/programmatic-capture] OAuth capture binding', () => {
  it('sets the assistant and profile override on an active grant', async () => {
    const deps = makeDeps()
    const response = await request(app(deps))
      .put(`/api/workspaces/${WID}/oauth-authorizations/${AUTH_ID}/capture`)
      .send({ assistantId: AID, profileId: PID })

    expect(response.status).toBe(204)
    expect(deps.authorizationStore.updateCaptureBinding).toHaveBeenCalledWith(
      '55555555-5555-4555-8555-555555555555', AUTH_ID, WID, AID, PID,
    )
  })

  it('rejects a profile override without a capture assistant', async () => {
    const deps = makeDeps()
    const response = await request(app(deps))
      .put(`/api/workspaces/${WID}/oauth-authorizations/${AUTH_ID}/capture`)
      .send({ assistantId: null, profileId: PID })

    expect(response.status).toBe(400)
    expect(deps.authorizationStore.updateCaptureBinding).not.toHaveBeenCalled()
  })
})
