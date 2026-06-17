import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
}))

vi.mock('../../db/users.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/users.js')>('../../db/users.js')
  return {
    ...actual,
    findUserById: vi.fn(),
  }
})

import { detectTzDrift } from '../tz-drift-detector.js'
import { query } from '../../db/client.js'
import { findUserById } from '../../db/users.js'

const mockQuery = vi.mocked(query)
const mockFindUserById = vi.mocked(findUserById)

// The detector runs 5 sequential queries in order:
//   1. suppression check
//   2. flapping guard (distinct daily-top tzs in 7d)
//   3. dominant tz in 48h window
//   4. bounce check (has user seen currentTz in last 24h)
//   5. active local-mode jobs
//
// Each helper below advances the mock by returning a happy-path value
// for the named stage; the test then overrides whichever stage is
// under test.

function mockSuppression(suppressed: boolean) {
  mockQuery.mockResolvedValueOnce({ rows: [{ suppressed }], rowCount: 1 } as never)
}

function mockFlapping(distinct: number) {
  mockQuery.mockResolvedValueOnce({ rows: [{ distinct_tops: distinct }], rowCount: 1 } as never)
}

function mockDominant(tz: string | null, n: number, latest: Date) {
  if (tz === null) {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
  } else {
    mockQuery.mockResolvedValueOnce({ rows: [{ tz, n, latest }], rowCount: 1 } as never)
  }
}

function mockBounce(seen_home: boolean) {
  mockQuery.mockResolvedValueOnce({ rows: [{ seen_home }], rowCount: 1 } as never)
}

function mockJobs(jobs: Array<{ id: string; instructions: string; timezone: string }>) {
  mockQuery.mockResolvedValueOnce({ rows: jobs, rowCount: jobs.length } as never)
}

function setUser(timezone: string | null) {
  mockFindUserById.mockResolvedValue({
    id: 'u_1',
    timezone,
  } as never)
}

describe('[COMP:api/tz-drift-detector] detectTzDrift', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockFindUserById.mockReset()
  })

  it('fires when a dominant new tz is observed recently and no bounce-back', async () => {
    setUser('Asia/Hong_Kong')
    mockSuppression(false)
    mockFlapping(1)
    mockDominant('Asia/Tokyo', 7, new Date())
    mockBounce(false)
    mockJobs([{ id: 'j1', instructions: 'pill at 2pm', timezone: 'Asia/Hong_Kong' }])

    const result = await detectTzDrift('u_1')
    expect(result).not.toBeNull()
    expect(result?.suggestedTz).toBe('Asia/Tokyo')
    expect(result?.currentTz).toBe('Asia/Hong_Kong')
    expect(result?.observationCount).toBe(7)
    expect(result?.pinnedJobs).toHaveLength(1)
  })

  it('returns null when the suppression window is active', async () => {
    setUser('Asia/Hong_Kong')
    mockSuppression(true)

    const result = await detectTzDrift('u_1')
    expect(result).toBeNull()
    // Only the suppression query should have run.
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('returns null when the client tz is flapping (>=3 daily-top tzs in 7d)', async () => {
    setUser('Asia/Hong_Kong')
    mockSuppression(false)
    mockFlapping(4)

    const result = await detectTzDrift('u_1')
    expect(result).toBeNull()
  })

  it('returns null when there is no dominant tz at all', async () => {
    setUser('Asia/Hong_Kong')
    mockSuppression(false)
    mockFlapping(1)
    mockDominant(null, 0, new Date())

    const result = await detectTzDrift('u_1')
    expect(result).toBeNull()
  })

  it('returns null when the dominant tz matches the current tz', async () => {
    setUser('Asia/Hong_Kong')
    mockSuppression(false)
    mockFlapping(1)
    mockDominant('Asia/Hong_Kong', 10, new Date())

    const result = await detectTzDrift('u_1')
    expect(result).toBeNull()
  })

  it('returns null when the dominant tz has < 3 observations', async () => {
    setUser('Asia/Hong_Kong')
    mockSuppression(false)
    mockFlapping(1)
    mockDominant('Asia/Tokyo', 2, new Date())

    const result = await detectTzDrift('u_1')
    expect(result).toBeNull()
  })

  it('returns null when the latest observation is stale (>6h old)', async () => {
    setUser('Asia/Hong_Kong')
    mockSuppression(false)
    mockFlapping(1)
    mockDominant('Asia/Tokyo', 5, new Date(Date.now() - 8 * 60 * 60 * 1000))

    const result = await detectTzDrift('u_1')
    expect(result).toBeNull()
  })

  it('returns null when the user has bounced back to home tz in the last 24h', async () => {
    setUser('Asia/Hong_Kong')
    mockSuppression(false)
    mockFlapping(1)
    mockDominant('Asia/Tokyo', 5, new Date())
    mockBounce(true)

    const result = await detectTzDrift('u_1')
    expect(result).toBeNull()
  })

  it('returns null when the user has no active, local-mode jobs to nudge', async () => {
    setUser('Asia/Hong_Kong')
    mockSuppression(false)
    mockFlapping(1)
    mockDominant('Asia/Tokyo', 5, new Date())
    mockBounce(false)
    mockJobs([])

    const result = await detectTzDrift('u_1')
    expect(result).toBeNull()
  })

  it('returns null when the user record is missing', async () => {
    mockFindUserById.mockResolvedValue(null as never)

    const result = await detectTzDrift('u_missing')
    expect(result).toBeNull()
  })
})
