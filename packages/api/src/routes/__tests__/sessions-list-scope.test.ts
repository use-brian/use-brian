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
import { DOC_DOCK_RESUME_ROW, isDocSurface } from '../_room-binding.js'
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

/**
 * The doc dock's resume and the chat route's cross-assistant send policy are
 * two halves of ONE contract: the dock keeps the thread when you switch
 * assistant (a per-turn re-address), so any row the resume attaches must be a
 * row another workspace assistant is allowed to answer on.
 *
 * They drifted. The resume accepted `channel_type='notification'` and the
 * pre-migration-187 `app_origin IS NULL` back-compat; `isDocSurface` accepts
 * neither. On 2026-09-01 a workspace's newest owner row was the
 * `channel_id='notifications'` inbox thread, so the dock attached it and every
 * send after an assistant switch died on "Session does not belong to this
 * assistant" - unrecoverable from the UI, because the dock has no new-chat
 * control and each rejection bumped `last_active_at`, re-electing the same row.
 *
 * Component tag: [COMP:api/sessions-list].
 */
describe('[COMP:api/sessions-list] doc-dock workspace-scope resume', () => {
  it('only returns rows the cross-assistant send policy can re-address', () => {
    // The invariant itself. The list query is BUILT from this constant, so
    // widening the resume without widening `isDocSurface` fails here.
    expect(isDocSurface(DOC_DOCK_RESUME_ROW)).toBe(true)
  })

  it('binds the doc surface shape instead of the wide back-compat filter', async () => {
    mockWorkspacePrimary.mockResolvedValue(assistant(WS_PRIMARY_ASSISTANT_ID))

    await request(makeApp())
      .get(`/api/sessions?scope=workspace&workspaceId=${WS_ID}&appOrigin=doc`)
      .expect(200)

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    // Scoped across the workspace's assistants, still the caller's own rows.
    expect(params[0]).toBe(WS_ID)
    expect(params[1]).toBe(USER_ID)
    // …and narrowed to exactly the addressable shape.
    expect(params[2]).toBe(DOC_DOCK_RESUME_ROW.channelType)
    expect(params[3]).toBe(DOC_DOCK_RESUME_ROW.appOrigin)
    expect(sql).toContain('s.channel_type = $3')
    expect(sql).toContain('s.app_origin = $4')
    // The two shapes that produced the dead thread must not be reachable.
    expect(sql).not.toContain('app_origin IS NULL')
    expect(sql).not.toContain("'notification'")
  })

  it('leaves the per-assistant Recents list on the wide back-compat filter', async () => {
    mockUserAssistant.mockResolvedValue(assistant(EXPLICIT_ASSISTANT_ID))

    await request(makeApp())
      .get(`/api/sessions?assistantId=${EXPLICIT_ASSISTANT_ID}&appOrigin=doc`)
      .expect(200)

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    // Recents is a HISTORY list, not a resume target - it never re-addresses,
    // so legacy null-origin and notification rows stay visible there.
    expect(sql).toContain('app_origin IS NULL')
    expect(sql).toContain("'notification'")
    expect(params).toHaveLength(3)
  })

  it('ignores scope=workspace without a workspaceId (falls back to the assistant list)', async () => {
    mockUserAssistant.mockResolvedValue(assistant(EXPLICIT_ASSISTANT_ID))

    await request(makeApp())
      .get(`/api/sessions?scope=workspace&assistantId=${EXPLICIT_ASSISTANT_ID}&appOrigin=doc`)
      .expect(200)

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('s.assistant_id = $1')
    expect(params[0]).toBe(EXPLICIT_ASSISTANT_ID)
  })
})
