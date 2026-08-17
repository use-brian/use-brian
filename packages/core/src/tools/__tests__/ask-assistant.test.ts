import { describe, it, expect, vi } from 'vitest'
import { createInterAssistantTools, type InterAssistantDeps } from '../base/ask-assistant.js'
import type { ToolContext } from '../types.js'
import type { ConsultResponse, Task } from '../../a2a/types.js'

const ctx: ToolContext = {
  userId: 'u_caller',
  assistantId: 'a_caller',
  workspaceId: 'ws_caller',
  sessionId: 's_1',
  appId: 'web',
  channelType: 'web',
  channelId: 'web-1',
  abortSignal: new AbortController().signal,
}

function completedTask(text: string): Task {
  const ts = '2026-05-09T00:00:00Z'
  return {
    taskId: 't_1',
    contextId: 'ctx_1',
    status: { state: 'completed', timestamp: ts },
    artifacts: [],
    history: [
      {
        messageId: 'm_2',
        role: 'agent',
        parts: [{ kind: 'text', text }],
        contextId: 'ctx_1',
        taskId: 't_1',
      },
    ],
  }
}

function makeDeps(overrides: Partial<InterAssistantDeps> = {}): InterAssistantDeps {
  return {
    isFollowing: vi.fn().mockResolvedValue(true),
    getFollowing: vi.fn().mockResolvedValue([]),
    consultTransport: {
      send: vi.fn().mockResolvedValue({ task: completedTask('ok') } satisfies ConsultResponse),
    },
    ...overrides,
  }
}

describe('[COMP:tools/ask-assistant] Inter-assistant tools', () => {
  describe('listConnectedAssistants', () => {
    it('surfaces bio as `purpose` and the caller note', async () => {
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_lobster',
            followingWorkspaceId: 'ws_caller',
            followingAssistantName: 'DD Lobster',
            followingOwnerHandle: 'lobster-owner',
            followingBio: 'Hong Kong restaurant scout',
            callerNote: 'lunch picks in Sai Ying Pun',
          },
        ]),
      })
      const tools = createInterAssistantTools(deps)
      const list = tools.find((t) => t.name === 'listConnectedAssistants')!
      const result = await list.execute({}, ctx)
      const data = result.data as Array<{
        purpose: string | null
        note: string | null
      }>
      expect(data[0].purpose).toBe('Hong Kong restaurant scout')
      expect(data[0].note).toBe('lunch picks in Sai Ying Pun')
    })

    it('defaults a user-origin follow to trigger=relevance', async () => {
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_lobster',
            followingWorkspaceId: 'ws_caller',
            followingAssistantName: 'DD Lobster',
            followingOwnerHandle: 'lobster',
            followingBio: 'restaurant scout',
            origin: 'user',
            callerNote: 'lunch picks',
          },
        ]),
      })
      const tools = createInterAssistantTools(deps)
      const list = tools.find((t) => t.name === 'listConnectedAssistants')!
      const result = await list.execute({}, ctx)
      const data = result.data as Array<{ trigger: string; note: string | null }>
      expect(data[0].trigger).toBe('relevance')
      expect(data[0].note).toBe('lunch picks')
    })

    it('marks a workspace-origin connection explicit-only and synthesizes a capability-scoped note for an app callee', async () => {
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_doc',
            followingWorkspaceId: 'ws_caller',
            followingAssistantName: 'Doc',
            followingOwnerHandle: 'doc',
            followingBio: null,
            followingAppType: 'doc',
            origin: 'workspace',
            callerNote: null,
          },
          {
            followingAssistantId: 'a_feed',
            followingWorkspaceId: 'ws_caller',
            followingAssistantName: 'Feed',
            followingOwnerHandle: 'feed',
            followingAppType: 'distribution',
            origin: 'workspace',
            callerNote: null,
          },
        ]),
      })
      const tools = createInterAssistantTools(deps)
      const list = tools.find((t) => t.name === 'listConnectedAssistants')!
      const result = await list.execute({}, ctx)
      const data = result.data as Array<{ trigger: string; note: string | null }>
      expect(data[0].trigger).toBe('explicit-only')
      expect(data[0].note).toMatch(/doc page or view/i)
      expect(data[0].note).toMatch(/explicitly/i)
      expect(data[1].trigger).toBe('explicit-only')
      expect(data[1].note).toMatch(/feed/i)
    })

    it('keeps an owner-set caller note even for a workspace-origin connection', async () => {
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_doc',
            followingWorkspaceId: 'ws_caller',
            followingAssistantName: 'Doc',
            followingOwnerHandle: 'doc',
            followingAppType: 'doc',
            origin: 'workspace',
            callerNote: 'our product spec pages',
          },
        ]),
      })
      const tools = createInterAssistantTools(deps)
      const list = tools.find((t) => t.name === 'listConnectedAssistants')!
      const result = await list.execute({}, ctx)
      const data = result.data as Array<{ trigger: string; note: string | null }>
      expect(data[0].trigger).toBe('explicit-only')
      expect(data[0].note).toBe('our product spec pages')
    })
  })

  describe('askAssistant', () => {
    it('rejects an unknown target with the id, the discovery tool, and a no-retry verdict', async () => {
      const deps = makeDeps({
        isFollowing: vi.fn().mockResolvedValue(false),
      })
      const tools = createInterAssistantTools(deps)
      const ask = tools.find((t) => t.name === 'askAssistant')!
      const result = await ask.execute({ targetAssistantId: 'a_other', question: 'hi' }, ctx)
      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toMatch(/Not connected/i)
      expect(data).toContain('a_other')
      expect(data).toContain('listConnectedAssistants')
      expect(data).toMatch(/Do NOT retry/i)
    })

    it('gives the same account whichever pre-check catches the unknown target', async () => {
      const ask = (deps: InterAssistantDeps) =>
        createInterAssistantTools(deps).find((t) => t.name === 'askAssistant')!

      const notFollowing = await ask(makeDeps({ isFollowing: vi.fn().mockResolvedValue(false) }))
        .execute({ targetAssistantId: 'a_other', question: 'hi' }, ctx)
      // isFollowing says yes but the connections list has no such row.
      const notInList = await ask(makeDeps({ getFollowing: vi.fn().mockResolvedValue([]) }))
        .execute({ targetAssistantId: 'a_other', question: 'hi' }, ctx)

      expect(notInList.isError).toBe(true)
      expect(String(notInList.data)).toBe(String(notFollowing.data))
    })

    it('builds a free-mode ConsultRequest and returns the agent text on completed', async () => {
      const send = vi.fn().mockResolvedValue({ task: completedTask('the answer is 42') } satisfies ConsultResponse)
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_target',
            followingWorkspaceId: 'ws_caller',
            followingAssistantName: 'Target',
            followingOwnerHandle: 'target',
          },
        ]),
        consultTransport: { send },
      })
      const tools = createInterAssistantTools(deps)
      const ask = tools.find((t) => t.name === 'askAssistant')!
      const result = await ask.execute({ targetAssistantId: 'a_target', question: 'meaning of life?' }, ctx)
      expect(result.data).toBe('the answer is 42')
      expect(send).toHaveBeenCalledTimes(1)
      const req = send.mock.calls[0][0]
      expect(req.target.assistantId).toBe('a_target')
      expect(req.target.workspaceId).toBe('ws_caller')
      expect(req.target.capabilityId).toBeUndefined()
      expect(req.chain.depth).toBe(0)
      expect(req.chain.path).toEqual([])
    })

    it('surfaces a failed Task as a tool error', async () => {
      const failed: Task = {
        taskId: 't_1',
        contextId: 'ctx_1',
        status: {
          state: 'failed',
          message: {
            messageId: 'm_e',
            role: 'agent',
            parts: [{ kind: 'text', text: 'Cross-workspace consults are not supported.' }],
          },
          timestamp: '2026-05-09T00:00:00Z',
        },
        artifacts: [],
      }
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_target',
            followingWorkspaceId: 'ws_other',
            followingAssistantName: 'Target',
            followingOwnerHandle: 'target',
          },
        ]),
        consultTransport: {
          send: vi.fn().mockResolvedValue({ task: failed } satisfies ConsultResponse),
        },
      })
      const tools = createInterAssistantTools(deps)
      const ask = tools.find((t) => t.name === 'askAssistant')!
      const result = await ask.execute({ targetAssistantId: 'a_target', question: 'q' }, ctx)
      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toMatch(/Cross-workspace/i)          // the callee's own words
      expect(data).toContain('a_target')                // echoes the target id
      expect(data).toMatch(/The connection is fine/i)   // NOT an unknown-target failure
      expect(data).toMatch(/fail the same way/i)        // its own verdict
      expect(data).not.toMatch(/Not connected/i)
    })

    it('a transport failure reads differently from an unknown target', async () => {
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_target',
            followingWorkspaceId: 'ws_caller',
            followingAssistantName: 'Target',
            followingOwnerHandle: 'target',
          },
        ]),
        consultTransport: {
          send: vi.fn().mockRejectedValue(new Error('consult transport unavailable')),
        },
      })
      const ask = createInterAssistantTools(deps).find((t) => t.name === 'askAssistant')!
      const result = await ask.execute({ targetAssistantId: 'a_target', question: 'q' }, ctx)

      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('a_target')
      expect(data).toContain('consult transport unavailable')
      expect(data).toMatch(/failed in transit/i)
      expect(data).toMatch(/not a wrong target id/i)
      expect(data).toMatch(/Retry once/i)
      expect(data).not.toMatch(/Not connected/i)
    })

    it('a timeout is not offered as a retry', async () => {
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_target',
            followingWorkspaceId: 'ws_caller',
            followingAssistantName: 'Target',
            followingOwnerHandle: 'target',
          },
        ]),
        consultTransport: { send: vi.fn().mockRejectedValue(new Error('Tool timed out after 60000ms')) },
      })
      const ask = createInterAssistantTools(deps).find((t) => t.name === 'askAssistant')!
      const result = await ask.execute({ targetAssistantId: 'a_target', question: 'q' }, ctx)

      expect(String(result.data)).toMatch(/timed out before it answered/i)
      expect(String(result.data)).toMatch(/Do not repeat a long-running ask/i)
    })

    it('a failed listing is never reported as "no connections"', async () => {
      const deps = makeDeps({ getFollowing: vi.fn().mockRejectedValue(new Error('ECONNRESET')) })
      const list = createInterAssistantTools(deps).find((t) => t.name === 'listConnectedAssistants')!
      const result = await list.execute({}, ctx)

      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('listConnectedAssistants')
      expect(data).toMatch(/unknown, not empty/i)
      expect(data).toMatch(/do not guess an id/i)
    })
  })
})
