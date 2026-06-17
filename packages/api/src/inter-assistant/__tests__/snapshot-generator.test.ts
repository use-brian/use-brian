import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
}))

import { createSnapshotGenerator } from '../snapshot-generator.js'
import { query } from '../../db/client.js'

const mockQuery = vi.mocked(query)

function createMockSnapshotStore() {
  return {
    generateDraft: vi.fn().mockResolvedValue({ id: 'draft_1', content: {} }),
    publish: vi.fn().mockResolvedValue({ id: 'snap_1' }),
    get: vi.fn(),
    list: vi.fn(),
  }
}

describe('[COMP:api/snapshot-generator] createSnapshotGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('knowledge category: queries knowledge_entries, saves draft, publishes', async () => {
    const store = createMockSnapshotStore()
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'ke_1', path: '/a', title: 'Entry 1', summary: null, tags: [] },
        { id: 'ke_2', path: '/b', title: 'Entry 2', summary: null, tags: [] },
        { id: 'ke_3', path: '/c', title: 'Entry 3', summary: null, tags: [] },
      ],
    } as never)

    const generate = createSnapshotGenerator({ snapshotStore: store as never })
    const result = await generate('a_1', 'u_1', 'knowledge')

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('knowledge_entries'),
      ['a_1'],
    )
    expect(store.generateDraft).toHaveBeenCalledWith(
      'a_1',
      'knowledge',
      expect.objectContaining({ count: 3 }),
    )
    expect(store.publish).toHaveBeenCalledWith('u_1', 'draft_1')
    expect(result).toContain('3')
  })

  it('tasks category: queries scheduled_jobs', async () => {
    const store = createMockSnapshotStore()
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'job_1', instructions: 'Daily standup', schedule: {}, timezone: 'UTC', enabled: true, nextRunAt: null },
        { id: 'job_2', instructions: 'Weekly report', schedule: {}, timezone: 'UTC', enabled: true, nextRunAt: null },
      ],
    } as never)

    const generate = createSnapshotGenerator({ snapshotStore: store as never })
    const result = await generate('a_1', 'u_1', 'tasks')

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('scheduled_jobs'),
      ['a_1', 'u_1'],
    )
    expect(store.generateDraft).toHaveBeenCalled()
    expect(result).toContain('2')
  })

  it('memories category: queries memories table', async () => {
    const store = createMockSnapshotStore()
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'mem_1', type: 'preference', summary: 'Likes coffee', tags: [] },
        { id: 'mem_2', type: 'fact', summary: 'Works at Acme', tags: [] },
      ],
    } as never)

    const generate = createSnapshotGenerator({ snapshotStore: store as never })
    const result = await generate('a_1', 'u_1', 'memories')

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('memories'),
      ['a_1', 'u_1'],
    )
    expect(store.generateDraft).toHaveBeenCalled()
    expect(result).toContain('2')
  })

  it('calendar category: returns note about live access', async () => {
    const store = createMockSnapshotStore()

    const generate = createSnapshotGenerator({ snapshotStore: store as never })
    const result = await generate('a_1', 'u_1', 'calendar')

    expect(result).toMatch(/live/i)
    // Calendar still generates a draft (with a note), then publishes
    expect(store.generateDraft).toHaveBeenCalled()
    expect(store.publish).toHaveBeenCalled()
  })

  it('unknown category: generates draft with note', async () => {
    const store = createMockSnapshotStore()

    const generate = createSnapshotGenerator({ snapshotStore: store as never })
    const result = await generate('a_1', 'u_1', 'nonexistent')

    expect(typeof result).toBe('string')
    // Unknown categories still go through generateDraft + publish
    expect(store.generateDraft).toHaveBeenCalledWith(
      'a_1',
      'nonexistent',
      expect.objectContaining({ note: expect.stringContaining('Unknown') }),
    )
  })
})
