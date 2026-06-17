/**
 * Unit tests for the chat-home routes.
 * Component tags: [COMP:api/home-setup-state], [COMP:api/home-dismiss].
 *
 * Mocks the db-layer home-store + users helpers and exercises the
 * auth / workspace / membership guards and happy paths via supertest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/home-store.js', () => ({
  getHomeSetupState: vi.fn(),
  getHomeGlance: vi.fn(),
  isWorkspaceMember: vi.fn(),
}))
vi.mock('../../db/users.js', () => ({
  getDismissedNudges: vi.fn(),
  updateDismissedNudges: vi.fn(),
}))

import { homeRoutes } from '../home.js'
import { getHomeGlance, getHomeSetupState, isWorkspaceMember } from '../../db/home-store.js'
import { getDismissedNudges, updateDismissedNudges } from '../../db/users.js'

const mockSetup = vi.mocked(getHomeSetupState)
const mockGlance = vi.mocked(getHomeGlance)
const mockMember = vi.mocked(isWorkspaceMember)
const mockDismissed = vi.mocked(getDismissedNudges)
const mockUpdate = vi.mocked(updateDismissedNudges)

const SAMPLE_STATE = {
  profileSet: false,
  companyResearched: false,
  brainPopulated: false,
  connectors: { googleCalendar: false, slack: false, telegram: false, notion: false, github: false, fathom: false },
  aiClientConnected: false,
}

function makeApp(userId?: string) {
  const app = express()
  app.use(express.json())
  if (userId) {
    app.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = userId
      next()
    })
  }
  app.use('/api/home', homeRoutes())
  return app
}

describe('[COMP:api/home-setup-state] GET /api/home/setup-state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMember.mockResolvedValue(true)
    mockSetup.mockResolvedValue(SAMPLE_STATE)
    mockDismissed.mockResolvedValue({})
  })

  it('401 without auth', async () => {
    const res = await request(makeApp()).get('/api/home/setup-state?workspaceId=w1')
    expect(res.status).toBe(401)
  })

  it('400 without workspaceId', async () => {
    const res = await request(makeApp('u1')).get('/api/home/setup-state')
    expect(res.status).toBe(400)
  })

  it('404 when not a workspace member (no setup-state leak)', async () => {
    mockMember.mockResolvedValue(false)
    const res = await request(makeApp('u1')).get('/api/home/setup-state?workspaceId=w1')
    expect(res.status).toBe(404)
    expect(mockSetup).not.toHaveBeenCalled()
  })

  it('200 returns state + dismissedNudges for a member', async () => {
    mockSetup.mockResolvedValue({ ...SAMPLE_STATE, profileSet: true })
    mockDismissed.mockResolvedValue({ company: true })
    const res = await request(makeApp('u1')).get('/api/home/setup-state?workspaceId=w1')
    expect(res.status).toBe(200)
    expect(res.body.profileSet).toBe(true)
    expect(res.body.dismissedNudges).toEqual({ company: true })
    expect(mockSetup).toHaveBeenCalledWith('u1', 'w1')
  })
})

const SAMPLE_GLANCE = {
  learnedRecently: [
    { id: 'e1', label: 'Acme Corp', kind: 'company', createdAt: '2026-06-03T09:00:00.000Z' },
    { id: 'm1', label: 'Prefers async standups', kind: 'memory', createdAt: '2026-05-28T08:30:00.000Z' },
  ],
  recent: [
    { id: 'e1', label: 'Acme Corp', kind: 'company', createdAt: '2026-06-03T09:00:00.000Z' },
    { id: 'p1', label: 'Jane Doe', kind: 'person', createdAt: '2026-06-01T10:00:00.000Z' },
  ],
}

describe('[COMP:api/home-glance] GET /api/home/glance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMember.mockResolvedValue(true)
    mockGlance.mockResolvedValue(SAMPLE_GLANCE)
  })

  it('401 without auth', async () => {
    const res = await request(makeApp()).get('/api/home/glance?workspaceId=w1')
    expect(res.status).toBe(401)
  })

  it('400 without workspaceId', async () => {
    const res = await request(makeApp('u1')).get('/api/home/glance')
    expect(res.status).toBe(400)
  })

  it('404 when not a workspace member (no glance leak)', async () => {
    mockMember.mockResolvedValue(false)
    const res = await request(makeApp('u1')).get('/api/home/glance?workspaceId=w1')
    expect(res.status).toBe(404)
    expect(mockGlance).not.toHaveBeenCalled()
  })

  it('200 returns learnedRecently + recent for a member', async () => {
    const res = await request(makeApp('u1')).get('/api/home/glance?workspaceId=w1')
    expect(res.status).toBe(200)
    expect(res.body.learnedRecently).toEqual(SAMPLE_GLANCE.learnedRecently)
    expect(res.body.recent).toEqual(SAMPLE_GLANCE.recent)
    // Always scoped by a `since` cutoff (never "most recent of all time").
    expect(mockGlance).toHaveBeenCalledWith('u1', 'w1', expect.any(String))
  })

  it('passes the client-supplied `since` through to the store', async () => {
    const since = '2026-06-03T00:00:00.000Z'
    await request(makeApp('u1')).get(`/api/home/glance?workspaceId=w1&since=${encodeURIComponent(since)}`)
    expect(mockGlance).toHaveBeenCalledWith('u1', 'w1', since)
  })

  it('falls back to a 24h window when `since` is missing/unparseable', async () => {
    await request(makeApp('u1')).get('/api/home/glance?workspaceId=w1&since=not-a-date')
    const passed = mockGlance.mock.calls[0][2] as string
    const ageMs = Date.now() - Date.parse(passed)
    // ~24h ago, within a generous tolerance.
    expect(ageMs).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(ageMs).toBeLessThan(25 * 60 * 60 * 1000)
  })
})

describe('[COMP:api/home-dismiss] GET /api/home/dismissed-nudges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDismissed.mockResolvedValue({})
  })

  it('401 without auth', async () => {
    const res = await request(makeApp()).get('/api/home/dismissed-nudges')
    expect(res.status).toBe(401)
    expect(mockDismissed).not.toHaveBeenCalled()
  })

  it('200 returns the per-user dismissal map (no workspace gate)', async () => {
    mockDismissed.mockResolvedValue({ 'brain-unconfirmed': true })
    const res = await request(makeApp('u1')).get('/api/home/dismissed-nudges')
    expect(res.status).toBe(200)
    expect(res.body.dismissed).toEqual({ 'brain-unconfirmed': true })
    expect(mockDismissed).toHaveBeenCalledWith('u1')
  })
})

describe('[COMP:api/home-dismiss] POST /api/home/dismiss-nudge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdate.mockResolvedValue(undefined)
  })

  it('401 without auth', async () => {
    const res = await request(makeApp()).post('/api/home/dismiss-nudge').send({ key: 'profile' })
    expect(res.status).toBe(401)
  })

  it('400 without a valid key', async () => {
    const res = await request(makeApp('u1')).post('/api/home/dismiss-nudge').send({})
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('200 persists the dismissal', async () => {
    const res = await request(makeApp('u1')).post('/api/home/dismiss-nudge').send({ key: 'profile' })
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith('u1', 'profile')
  })
})
