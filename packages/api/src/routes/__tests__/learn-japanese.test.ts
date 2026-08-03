/**
 * OAuth installation contract for the first-party Learn Japanese app.
 * Component tag: [COMP:api/learn-japanese-install].
 */

import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainAuth } from '../../brain-mcp/auth.js'
import type { BrainKeyStore } from '../../db/brain-keys-store.js'
import type { OAuthAuthorizationStore } from '../../db/oauth-authorization-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import {
  learnJapaneseRoutes,
  type LearnJapaneseQuery,
} from '../learn-japanese.js'

const WID = '11111111-1111-1111-1111-111111111111'
const AID = '22222222-2222-2222-2222-222222222222'
const KID = '33333333-3333-3333-3333-333333333333'

function oauthAuth(overrides: Partial<BrainAuth> = {}): BrainAuth {
  return {
    keyId: KID,
    workspaceId: WID,
    scope: 'read_write',
    maxClearance: 'internal',
    authKind: 'oauth_token',
    actingUserId: 'user-1',
    ...overrides,
  }
}

function makeDeps(auth: BrainAuth | null = oauthAuth()) {
  const authorizationStore = {
    revoke: vi.fn().mockResolvedValue(true),
  } as unknown as OAuthAuthorizationStore
  const workspaceStore = {
    getRole: vi.fn().mockResolvedValue('owner'),
  } as unknown as WorkspaceStore
  const runQuery = vi.fn() as unknown as LearnJapaneseQuery
  return {
    brainKeyStore: {} as BrainKeyStore,
    authorizationStore,
    workspaceStore,
    webAppUrl: 'https://app.usebrian.ai',
    authenticate: vi.fn().mockResolvedValue(auth),
    runQuery,
  }
}

function makeApp(deps: ReturnType<typeof makeDeps>) {
  const app = express()
  app.use(express.json())
  app.use('/api/apps/learn-japanese', learnJapaneseRoutes(deps))
  return app
}

describe('[COMP:api/learn-japanese-install] POST /install', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires an OAuth token', async () => {
    const deps = makeDeps(null)
    const res = await request(makeApp(deps)).post('/api/apps/learn-japanese/install')
    expect(res.status).toBe(401)
    expect(deps.runQuery).not.toHaveBeenCalled()
  })

  it('rejects API keys and read-only OAuth grants', async () => {
    const apiKeyDeps = makeDeps(oauthAuth({ authKind: 'api_key' }))
    expect((await request(makeApp(apiKeyDeps)).post('/api/apps/learn-japanese/install')).status).toBe(401)

    const readDeps = makeDeps(oauthAuth({ scope: 'read' }))
    expect((await request(makeApp(readDeps)).post('/api/apps/learn-japanese/install')).status).toBe(403)
  })

  it('rechecks the consenting user live admin role', async () => {
    const deps = makeDeps()
    deps.workspaceStore.getRole = vi.fn().mockResolvedValue('member')
    const res = await request(makeApp(deps)).post('/api/apps/learn-japanese/install')
    expect(res.status).toBe(403)
    expect(deps.runQuery).not.toHaveBeenCalled()
  })

  it('returns an existing teacher without creating a duplicate', async () => {
    const deps = makeDeps()
    vi.mocked(deps.runQuery).mockResolvedValueOnce({
      rows: [{ id: AID, name: 'Japanese Teacher' }],
    })

    const res = await request(makeApp(deps)).post('/api/apps/learn-japanese/install')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      workspaceId: WID,
      assistantId: AID,
      assistantName: 'Japanese Teacher',
      assistantUrl: `https://app.usebrian.ai/w/${WID}/chat?assistant=${AID}`,
      created: false,
    })
    expect(deps.runQuery).toHaveBeenCalledTimes(1)
  })

  it('creates one internal app assistant and returns its standard chat URL', async () => {
    const deps = makeDeps()
    vi.mocked(deps.runQuery)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: AID, name: 'Japanese Teacher' }] })

    const res = await request(makeApp(deps)).post('/api/apps/learn-japanese/install')
    expect(res.status).toBe(201)
    expect(res.body.created).toBe(true)
    expect(res.body.assistantUrl).toBe(
      `https://app.usebrian.ai/w/${WID}/chat?assistant=${AID}`,
    )
    const insertSql = vi.mocked(deps.runQuery).mock.calls[1][0]
    expect(insertSql).toContain("'internal', 'app', 'learn-japanese'")
    expect(vi.mocked(deps.runQuery).mock.calls[1][1]?.[1]).toBe(WID)
  })

  it('resolves the winner when concurrent installs race', async () => {
    const deps = makeDeps()
    vi.mocked(deps.runQuery)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: AID, name: 'Japanese Teacher' }] })

    const res = await request(makeApp(deps)).post('/api/apps/learn-japanese/install')
    expect(res.status).toBe(200)
    expect(res.body.assistantId).toBe(AID)
    expect(res.body.created).toBe(false)
  })
})

describe('[COMP:api/learn-japanese-install] DELETE /connection', () => {
  it('revokes the calling grant and leaves the assistant untouched', async () => {
    const deps = makeDeps()
    const res = await request(makeApp(deps)).delete('/api/apps/learn-japanese/connection')
    expect(res.status).toBe(204)
    expect(deps.authorizationStore.revoke).toHaveBeenCalledWith('user-1', KID)
    expect(deps.runQuery).not.toHaveBeenCalled()
  })
})
