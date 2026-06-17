/**
 * Regression: GET /api/sessions must scope Recents/History to the requested
 * workspace's primary assistant. Before the fix the route ignored
 * `?workspaceId=` and always fell back to getDefaultAssistant (the Personal
 * workspace's primary), so every other workspace's Recents leaked the user's
 * personal chat history. Mirrors the chat route's assistant resolution.
 *
 * Component tag: [COMP:api/sessions-list].
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../db/users.js', () => ({
  findOrCreateUser: vi.fn(),
  getDefaultAssistant: vi.fn(),
  getUserAssistant: vi.fn(),
  getUserProfilesByIds: vi.fn(),
  getWorkspacePrimaryAssistant: vi.fn(),
}))
vi.mock('../../db/sessions.js', () => ({
  findSessionByChannel: vi.fn(),
  findSessionById: vi.fn(),
  getSessionMessages: vi.fn(),
  renameSession: vi.fn(),
}))
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceRoleSystem: vi.fn(),
  getWorkspaceMembershipWithClearanceSystem: vi.fn(),
}))
vi.mock('../route-helpers.js', () => ({ resolveUser: vi.fn() }))

import { sessionRoutes } from '../sessions.js'
import { query } from '../../db/client.js'
import {
  getDefaultAssistant,
  getUserAssistant,
  getWorkspacePrimaryAssistant,
} from '../../db/users.js'
import { resolveUser } from '../route-helpers.js'

const mockQuery = vi.mocked(query)
const mockDefault = vi.mocked(getDefaultAssistant)
const mockUserAssistant = vi.mocked(getUserAssistant)
const mockWorkspacePrimary = vi.mocked(getWorkspacePrimaryAssistant)
const mockResolveUser = vi.mocked(resolveUser)

const USER_ID = '11111111-1111-1111-1111-111111111111'
const WS_ID = '22222222-2222-2222-2222-222222222222'
const WS_PRIMARY_ASSISTANT_ID = '33333333-3333-3333-3333-333333333333'
const PERSONAL_PRIMARY_ASSISTANT_ID = '44444444-4444-4444-4444-444444444444'
const EXPLICIT_ASSISTANT_ID = '55555555-5555-5555-5555-555555555555'

function assistant(id: string) {
  return { id } as never
}

function makeApp() {
  const app = express()
  app.use('/api/sessions', sessionRoutes())
  return app
}

beforeEach(() => {
  vi.resetAllMocks()
  mockResolveUser.mockResolvedValue({ id: USER_ID } as never)
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
})

describe('[COMP:api/sessions-list] GET /api/sessions workspace scoping', () => {
  it('resolves the workspace primary assistant when ?workspaceId is given (no leak)', async () => {
    mockWorkspacePrimary.mockResolvedValue(assistant(WS_PRIMARY_ASSISTANT_ID))

    await request(makeApp())
      .get(`/api/sessions?appOrigin=chat&workspaceId=${WS_ID}`)
      .expect(200)

    expect(mockWorkspacePrimary).toHaveBeenCalledWith(USER_ID, WS_ID)
    // The Personal-workspace fallback MUST NOT fire — that was the leak.
    expect(mockDefault).not.toHaveBeenCalled()
    // The list query is scoped to the workspace's assistant, not the personal one.
    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[0]).toBe(WS_PRIMARY_ASSISTANT_ID)
    expect(params[1]).toBe(USER_ID)
  })

  it('returns [] (not personal history) when the user is not a member of the workspace', async () => {
    mockWorkspacePrimary.mockResolvedValue(null)

    const res = await request(makeApp())
      .get(`/api/sessions?appOrigin=chat&workspaceId=${WS_ID}`)
      .expect(200)

    expect(res.body).toEqual([])
    expect(mockDefault).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('honours an explicit ?assistantId over workspaceId', async () => {
    mockUserAssistant.mockResolvedValue(assistant(EXPLICIT_ASSISTANT_ID))

    await request(makeApp())
      .get(`/api/sessions?assistantId=${EXPLICIT_ASSISTANT_ID}&workspaceId=${WS_ID}`)
      .expect(200)

    expect(mockUserAssistant).toHaveBeenCalledWith(USER_ID, EXPLICIT_ASSISTANT_ID)
    expect(mockWorkspacePrimary).not.toHaveBeenCalled()
    expect(mockDefault).not.toHaveBeenCalled()
    expect((mockQuery.mock.calls[0][1] as unknown[])[0]).toBe(EXPLICIT_ASSISTANT_ID)
  })

  it('falls back to the default assistant when neither param is given (back-compat)', async () => {
    mockDefault.mockResolvedValue(assistant(PERSONAL_PRIMARY_ASSISTANT_ID))

    await request(makeApp()).get('/api/sessions?appOrigin=chat').expect(200)

    expect(mockDefault).toHaveBeenCalledWith(USER_ID)
    expect(mockWorkspacePrimary).not.toHaveBeenCalled()
    expect((mockQuery.mock.calls[0][1] as unknown[])[0]).toBe(PERSONAL_PRIMARY_ASSISTANT_ID)
  })
})
