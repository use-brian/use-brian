import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', async () => {
  const actual = await vi.importActual<typeof import('../client.js')>('../client.js')
  return {
    ...actual,
    getAppPool: vi.fn(),
    query: vi.fn(),
  }
})

import { getAppPool } from '../client.js'
import {
  createWorkspaceChatHandoffStore,
  PRIVATE_CHAT_HANDOFF_HEADING,
} from '../workspace-chat-handoff-store.js'

const mockGetAppPool = vi.mocked(getAppPool)

function params() {
  return {
    sourceSessionId: 'private-session-1',
    userId: 'user-1',
    assistantId: 'assistant-1',
    workspaceId: 'workspace-1',
    appId: 'Use Brian',
    title: 'Wholesale pricing launch',
    handoff: 'Goal: finalize the wholesale price list.',
  }
}

beforeEach(() => {
  mockGetAppPool.mockReset()
})

describe('[COMP:api/workspace-chat-handoff] persistence', () => {
  it('revalidates the private source and atomically creates an attributed room handoff', async () => {
    const issued: Array<{ text: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        issued.push({ text, values })
        if (text.includes('SELECT a.clearance')) {
          return { rows: [{ clearance: 'internal' }], rowCount: 1 }
        }
        if (text.includes('INSERT INTO sessions')) {
          return { rows: [{ id: 'room-1' }], rowCount: 1 }
        }
        if (text.includes('INSERT INTO session_messages')) {
          return { rows: [{ id: 'message-1' }], rowCount: 1 }
        }
        return { rows: [], rowCount: null }
      }),
      release: vi.fn(),
    }
    mockGetAppPool.mockReturnValue({ connect: async () => client } as never)

    await expect(createWorkspaceChatHandoffStore().create(params())).resolves.toEqual({
      sessionId: 'room-1',
    })

    expect(issued[0].text).toBe('BEGIN')
    expect(issued[1].text).toBe("SET LOCAL app.current_user_id = 'user-1'")

    const sourceRead = issued.find((entry) => entry.text.includes('SELECT a.clearance'))!
    expect(sourceRead.text).toContain("s.channel_type = 'web'")
    expect(sourceRead.text).toContain("s.visibility = 'owner'")
    expect(sourceRead.values).toEqual([
      'private-session-1',
      'user-1',
      'assistant-1',
      'workspace-1',
    ])

    const roomInsert = issued.find((entry) => entry.text.includes('INSERT INTO sessions'))!
    expect(roomInsert.text).toContain("'chat', 'workspace'")
    expect(roomInsert.text).toContain('title_manually_set')
    expect(roomInsert.values).toEqual([
      'assistant-1',
      'user-1',
      expect.any(String),
      'Use Brian',
      'workspace-1',
      'internal',
      'Wholesale pricing launch',
    ])

    const messageInsert = issued.find((entry) => entry.text.includes('INSERT INTO session_messages'))!
    expect(messageInsert.values?.[0]).toBe('room-1')
    expect(messageInsert.values?.[1]).toBe('user')
    expect(messageInsert.values?.[2]).toBe(
      JSON.stringify([
        {
          type: 'text',
          text: `${PRIVATE_CHAT_HANDOFF_HEADING}\n\nGoal: finalize the wholesale price list.`,
        },
      ]),
    )
    expect(messageInsert.values?.[7]).toBe('user-1')
    expect(issued.at(-1)?.text).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('rolls back without creating a room when the trusted source tuple no longer matches', async () => {
    const issued: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        issued.push(text)
        if (text.includes('SELECT a.clearance')) {
          return { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: null }
      }),
      release: vi.fn(),
    }
    mockGetAppPool.mockReturnValue({ connect: async () => client } as never)

    await expect(createWorkspaceChatHandoffStore().create(params())).rejects.toThrow(
      'current conversation can no longer be shared',
    )

    expect(issued).toContain('ROLLBACK')
    expect(issued.some((text) => text.includes('INSERT INTO sessions'))).toBe(false)
    expect(issued).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('rolls back the room insert if the attributed handoff message fails', async () => {
    const issued: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        issued.push(text)
        if (text.includes('SELECT a.clearance')) {
          return { rows: [{ clearance: 'internal' }], rowCount: 1 }
        }
        if (text.includes('INSERT INTO sessions')) {
          return { rows: [{ id: 'room-1' }], rowCount: 1 }
        }
        if (text.includes('INSERT INTO session_messages')) {
          throw new Error('message insert failed')
        }
        return { rows: [], rowCount: null }
      }),
      release: vi.fn(),
    }
    mockGetAppPool.mockReturnValue({ connect: async () => client } as never)

    await expect(createWorkspaceChatHandoffStore().create(params())).rejects.toThrow(
      'message insert failed',
    )

    expect(issued).toContain('ROLLBACK')
    expect(issued).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })
})
