/**
 * The computer-use SDK both surfaces ride — the Take-Over live view page
 * (`/w/[workspaceId]/computer/[sessionId]`) and the Profile-Management
 * settings section (R2-4). Asserts the wire contract against
 * `/api/computer/*` (paths, methods, bodies) and the null/error mappings the
 * UI branches on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth-fetch', () => ({ authFetch: vi.fn() }))

import { authFetch } from '@/lib/auth-fetch'
import {
  completeComputerTask,
  createBrowserProfile,
  deleteBrowserProfile,
  getComputerFrame,
  getComputerTask,
  listBrowserProfiles,
  markComputerSessionCaptured,
  resumeComputerTask,
  revokeProfileSession,
  sendComputerInput,
  setComputerSessionBackend,
  updateBrowserProfile,
} from '../computer'

const mockFetch = vi.mocked(authFetch)

function respond(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockResolvedValue(respond(200, {}))
})

describe('[COMP:app-web/sandbox-takeover] Take-Over live view SDK', () => {
  it('resolves the active task and maps 404 to null (the "no task" empty state)', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, { taskId: 't1', status: 'running', profileId: 'p1', injectedSite: null, workspaceId: 'w1', createdAt: 1 }),
    )
    const task = await getComputerTask('sess-1')
    expect(task?.status).toBe('running')
    expect(task?.profileId).toBe('p1')
    expect(String(mockFetch.mock.calls[0][0])).toContain('/api/computer/tasks/sess-1')

    mockFetch.mockResolvedValueOnce(respond(404))
    expect(await getComputerTask('sess-1')).toBeNull()
  })

  it('resumes on arrival, polls frames, and forwards scaled input events', async () => {
    await resumeComputerTask('sess-1')
    expect(String(mockFetch.mock.calls[0][0])).toContain('/tasks/sess-1/resume')
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'POST' })

    mockFetch.mockResolvedValueOnce(respond(200, { data: 'AAAA', mimeType: 'image/png' }))
    const frame = await getComputerFrame('sess-1')
    expect(frame).toEqual({ data: 'AAAA', mimeType: 'image/png' })

    mockFetch.mockResolvedValueOnce(respond(204))
    expect(await getComputerFrame('sess-1')).toBeNull()

    await sendComputerInput('sess-1', { kind: 'click', x: 10, y: 20 })
    const inputCall = mockFetch.mock.calls.at(-1)!
    expect(String(inputCall[0])).toContain('/tasks/sess-1/input')
    expect(JSON.parse(inputCall[1]!.body as string)).toEqual({ kind: 'click', x: 10, y: 20 })
  })

  it('captures into the task profile, maps 409 to profileRequired, and completes with the chosen outcome', async () => {
    const plain = await markComputerSessionCaptured('sess-1', 'github.com')
    expect(plain).toEqual({ ok: true, profileRequired: false })
    const captured = mockFetch.mock.calls.at(-1)!
    expect(String(captured[0])).toContain('/tasks/sess-1/captured')
    expect(JSON.parse(captured[1]!.body as string)).toEqual({ site: 'github.com' })

    await markComputerSessionCaptured('sess-1', 'github.com', 'p1')
    expect(JSON.parse(mockFetch.mock.calls.at(-1)![1]!.body as string)).toEqual({
      site: 'github.com',
      profileId: 'p1',
    })

    mockFetch.mockResolvedValueOnce(respond(409, { code: 'profile_required' }))
    expect(await markComputerSessionCaptured('sess-1', 'github.com')).toEqual({
      ok: false,
      profileRequired: true,
    })

    await completeComputerTask('sess-1', 'failed')
    const complete = mockFetch.mock.calls.at(-1)!
    expect(String(complete[0])).toContain('/tasks/sess-1/complete')
    expect(JSON.parse(complete[1]!.body as string)).toEqual({ outcome: 'failed' })
  })

})

describe('[COMP:app-web/backend-toggle] The live backend toggle (R2-3)', () => {
  it('flips the session backend, null clearing back to the profile default', async () => {
    await setComputerSessionBackend('sess-1', 'local')
    const flip = mockFetch.mock.calls.at(-1)!
    expect(String(flip[0])).toContain('/api/computer/sessions/sess-1/backend')
    expect(JSON.parse(flip[1]!.body as string)).toEqual({ backend: 'local' })

    await setComputerSessionBackend('sess-1', null)
    expect(JSON.parse(mockFetch.mock.calls.at(-1)![1]!.body as string)).toEqual({ backend: null })
  })
})

describe('[COMP:app-web/profile-management] Profile-Management SDK (R2-4)', () => {
  it('lists profiles (with per-site sessions) scoped to the workspace', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, {
        configured: true,
        profiles: [
          {
            id: 'p1',
            name: 'Personal',
            clearance: 'confidential',
            defaultBackend: 'cloud',
            enabledAssistantIds: [],
            sessions: [{ site: 'github.com', capturedAt: 'x', lastUsedAt: null, status: 'active' }],
          },
        ],
      }),
    )
    const res = await listBrowserProfiles('ws-1')
    expect(res.configured).toBe(true)
    expect(res.profiles[0].sessions[0].site).toBe('github.com')
    expect(String(mockFetch.mock.calls[0][0])).toContain('/api/computer/profiles?workspaceId=ws-1')
  })

  it('creates, updates, and deletes a profile over the CRUD routes', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, { profile: { id: 'p2', name: 'Company IG', clearance: 'confidential' } }),
    )
    const created = await createBrowserProfile({ workspaceId: 'ws-1', name: 'Company IG' })
    expect(created?.id).toBe('p2')
    expect(created?.sessions).toEqual([])
    const create = mockFetch.mock.calls.at(-1)!
    expect(String(create[0])).toContain('/api/computer/profiles')
    expect(create[1]).toMatchObject({ method: 'POST' })

    await updateBrowserProfile('p2', { clearance: 'internal', defaultBackend: 'local' })
    const patch = mockFetch.mock.calls.at(-1)!
    expect(String(patch[0])).toContain('/api/computer/profiles/p2')
    expect(patch[1]).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse(patch[1]!.body as string)).toEqual({ clearance: 'internal', defaultBackend: 'local' })

    await deleteBrowserProfile('p2')
    const del = mockFetch.mock.calls.at(-1)!
    expect(String(del[0])).toContain('/api/computer/profiles/p2')
    expect(del[1]).toMatchObject({ method: 'DELETE' })
  })

  it('revokes one site inside a profile', async () => {
    await revokeProfileSession('p1', 'github.com')
    const call = mockFetch.mock.calls.at(-1)!
    expect(String(call[0])).toContain('/api/computer/profiles/p1/sessions/github.com')
    expect(call[1]).toMatchObject({ method: 'DELETE' })
  })
})
