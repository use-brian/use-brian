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
  captureProfileSession,
  completeComputerTask,
  createBrowserProfile,
  deleteBrowserProfile,
  getComputerFrame,
  getComputerTask,
  getBrowserExtensionStatus,
  listBrowserProfiles,
  mostRecentComputerTask,
  pairBrowserExtension,
  markComputerSessionCaptured,
  resumeComputerTask,
  revokeProfileSession,
  revokeBrowserCredential,
  saveBrowserCredential,
  sendComputerInput,
  setComputerSessionBackend,
  testBrowserCredential,
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

describe('[COMP:app-web/browsers-surface] Browsers index task selection', () => {
  it('opens the most recently active running or paused task', () => {
    const base = {
      profileId: null,
      injectedSite: null,
      createdAt: 1,
      backend: 'cloud' as const,
    }
    expect(
      mostRecentComputerTask([
        { ...base, taskId: 't1', sessionId: 's1', status: 'running', lastActivityAt: 10 },
        { ...base, taskId: 't2', sessionId: 's2', status: 'paused', lastActivityAt: 20 },
      ])?.sessionId,
    ).toBe('s2')
    expect(mostRecentComputerTask([])).toBeNull()
  })
})

describe('[COMP:app-web/sandbox-takeover] Take-Over live view SDK', () => {
  it('resolves the active task and maps 404 to null (the "no task" empty state)', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, { taskId: 't1', status: 'running', profileId: 'p1', injectedSite: null, workspaceId: 'w1', createdAt: 1, backend: 'local', connectionState: 'disconnected' }),
    )
    const task = await getComputerTask('sess-1')
    expect(task?.status).toBe('running')
    expect(task?.profileId).toBe('p1')
    expect(task?.backend).toBe('local')
    expect(task?.connectionState).toBe('disconnected')
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

    mockFetch.mockResolvedValueOnce(respond(200, { ok: true }))
    await sendComputerInput('sess-1', { kind: 'pointer', action: 'down', x: 10, y: 20 })
    expect(JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string)).toEqual({
      kind: 'pointer', action: 'down', x: 10, y: 20,
    })
    mockFetch.mockResolvedValueOnce(respond(200, { ok: true }))
    await sendComputerInput('sess-1', { kind: 'pointer', action: 'move', x: 15, y: 25 })
    expect(JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string)).toEqual({
      kind: 'pointer', action: 'move', x: 15, y: 25,
    })
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

    expect(await completeComputerTask('sess-1', 'failed')).toBe(true)
    const complete = mockFetch.mock.calls.at(-1)!
    expect(String(complete[0])).toContain('/tasks/sess-1/complete')
    expect(JSON.parse(complete[1]!.body as string)).toEqual({ outcome: 'failed' })
  })

})

// "Save this login from my browser" (browser-session-portability.md D5): a
// profile-scoped capture, not a task-scoped one - no sessionId, just the
// profile and the site. Echoes site + capturedAt on success (story 3) and
// surfaces the server's message verbatim on failure (story 20), so distinct
// refusals like a wrong tab's site never collapse into one flattened error.
describe('[COMP:app-web/profile-management] captureProfileSession ("Save this login from my browser")', () => {
  it('posts to the profile-scoped capture route and echoes site + capturedAt on success', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, { ok: true, site: 'instagram.com', capturedAt: '2026-08-04T00:00:00.000Z' }),
    )
    const result = await captureProfileSession('p1', 'instagram.com')
    expect(result).toEqual({ ok: true, site: 'instagram.com', capturedAt: '2026-08-04T00:00:00.000Z' })
    const call = mockFetch.mock.calls.at(-1)!
    expect(String(call[0])).toContain('/api/computer/profiles/p1/capture')
    expect(call[1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(call[1]!.body as string)).toEqual({ site: 'instagram.com' })
  })

  it('surfaces the server message verbatim on a non-500 refusal', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(409, {
        error: 'The allowed tab is on a different site than instagram.com.',
        code: 'site_mismatch',
      }),
    )
    const refused = await captureProfileSession('p1', 'instagram.com')
    expect(refused.ok).toBe(false)
    expect(refused.error).toBe('The allowed tab is on a different site than instagram.com.')
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
        credentialAuthConfigured: true,
        profiles: [
          {
            id: 'p1',
            name: 'Personal',
            clearance: 'confidential',
            defaultBackend: 'cloud',
            localControlMode: 'task_tabs',
            enabledAssistantIds: [],
            assistantRoutingNotes: { 'assistant-1': 'Use for personal accounts.' },
            canManage: true,
            sessions: [{ site: 'github.com', capturedAt: 'x', lastUsedAt: null, status: 'active' }],
          },
        ],
      }),
    )
    const res = await listBrowserProfiles('ws-1')
    expect(res.configured).toBe(true)
    expect(res.credentialAuthConfigured).toBe(true)
    expect(res.profiles[0].sessions[0].site).toBe('github.com')
    expect(res.profiles[0].canManage).toBe(true)
    expect(res.profiles[0].assistantRoutingNotes?.['assistant-1']).toContain('personal')
    expect(String(mockFetch.mock.calls[0][0])).toContain('/api/computer/profiles?workspaceId=ws-1')
  })

  it('creates, updates, and deletes a profile over the CRUD routes', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, { profile: { id: 'p2', name: 'Company IG', clearance: 'confidential' } }),
    )
    const created = await createBrowserProfile({
      workspaceId: 'ws-1',
      name: 'Company IG',
      defaultBackend: 'local',
    })
    expect(created?.id).toBe('p2')
    expect(created?.sessions).toEqual([])
    expect(created?.credentials).toEqual([])
    const create = mockFetch.mock.calls.at(-1)!
    expect(String(create[0])).toContain('/api/computer/profiles')
    expect(create[1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(create[1]!.body as string)).toEqual({
      workspaceId: 'ws-1',
      name: 'Company IG',
      defaultBackend: 'local',
    })

    await updateBrowserProfile('p2', {
      clearance: 'internal',
      defaultBackend: 'local',
      localControlMode: 'full_browser',
      assistantRoutingNotes: { 'assistant-1': 'Use for the company account.' },
    })
    const patch = mockFetch.mock.calls.at(-1)!
    expect(String(patch[0])).toContain('/api/computer/profiles/p2')
    expect(patch[1]).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse(patch[1]!.body as string)).toEqual({
      clearance: 'internal',
      defaultBackend: 'local',
      localControlMode: 'full_browser',
      assistantRoutingNotes: { 'assistant-1': 'Use for the company account.' },
    })

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

  it('saves, tests, and revokes a write-only browser credential', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, {
        credential: {
          id: 'cred-1',
          profileId: 'p1',
          workspaceId: 'ws-1',
          site: 'example.com',
          loginUrl: 'https://accounts.example.com/login',
          accountLabel: 'Primary',
          status: 'active',
          lastUsedAt: null,
          lastFailureCode: null,
          createdAt: 'x',
          updatedAt: 'x',
        },
      }),
    )
    const saved = await saveBrowserCredential('p1', {
      loginUrl: 'https://accounts.example.com/login',
      accountLabel: 'Primary',
      username: 'member@example.com',
      password: 'secret-password',
    })
    expect(saved?.site).toBe('example.com')
    const saveCall = mockFetch.mock.calls.at(-1)!
    expect(String(saveCall[0])).toContain('/profiles/p1/credentials')
    expect(JSON.parse(saveCall[1]!.body as string)).toEqual({
      loginUrl: 'https://accounts.example.com/login',
      accountLabel: 'Primary',
      username: 'member@example.com',
      password: 'secret-password',
    })

    mockFetch.mockResolvedValueOnce(
      respond(422, { ok: false, status: 'needs_user', code: 'mfa_required' }),
    )
    expect(await testBrowserCredential('p1', 'cred-1')).toEqual({
      ok: false,
      status: 'needs_user',
      code: 'mfa_required',
    })
    expect(String(mockFetch.mock.calls.at(-1)?.[0])).toContain(
      '/profiles/p1/credentials/cred-1/test',
    )

    expect(await revokeBrowserCredential('p1', 'cred-1')).toBe(true)
    const revoke = mockFetch.mock.calls.at(-1)!
    expect(String(revoke[0])).toContain('/profiles/p1/credentials/cred-1')
    expect(revoke[1]).toMatchObject({ method: 'DELETE' })
  })
})

describe('[COMP:app-web/connect-browser] Profile-scoped extension pairing SDK', () => {
  it('scopes status and pairing to the selected browser profile', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, { configured: true, connected: true, build: 'abc', staleBuild: false }),
    )
    expect(await getBrowserExtensionStatus('ws-1', 'profile-1')).toMatchObject({ connected: true })
    expect(String(mockFetch.mock.calls.at(-1)?.[0])).toContain(
      '/api/browser-extension/status?workspaceId=ws-1&browserProfileId=profile-1',
    )

    mockFetch.mockResolvedValueOnce(
      respond(200, {
        pairingToken: 'token',
        relayUrl: 'wss://relay.example/ext',
        browserProfileId: 'profile-1',
        expiresInSeconds: 600,
      }),
    )
    const paired = await pairBrowserExtension('ws-1', 'profile-1')
    expect(paired?.browserProfileId).toBe('profile-1')
    expect(JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string)).toEqual({
      workspaceId: 'ws-1',
      browserProfileId: 'profile-1',
    })
  })
})
