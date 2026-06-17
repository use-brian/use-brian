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

function inputRequiredTask(): Task {
  return {
    taskId: 't_1',
    contextId: 'ctx_1',
    status: { state: 'input_required', timestamp: '2026-05-09T00:00:00Z' },
    artifacts: [],
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

describe('[COMP:tools/ask-assistant] Inter-assistant tools (mode-based)', () => {
  describe('listConnectedAssistants', () => {
    it('surfaces bio as `purpose`, caller note, and mode info', async () => {
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_lobster',
            followingWorkspaceId: 'ws_lobster',
            followingAssistantName: 'DD Lobster',
            followingOwnerHandle: 'lobster-owner',
            followingBio: 'Hong Kong restaurant scout',
            callerNote: 'lunch picks in Sai Ying Pun',
            mode: { id: 'm_1', name: 'Calendar', description: 'cal only', requireApproval: false },
          },
        ]),
      })
      const tools = createInterAssistantTools(deps)
      const list = tools.find((t) => t.name === 'listConnectedAssistants')!
      const result = await list.execute({}, ctx)
      const data = result.data as Array<{
        purpose: string | null
        note: string | null
        mode: { name: string; requireApproval: boolean }
      }>
      expect(data[0].purpose).toBe('Hong Kong restaurant scout')
      expect(data[0].note).toBe('lunch picks in Sai Ying Pun')
      expect(data[0].mode.name).toBe('Calendar')
      expect(data[0].mode.requireApproval).toBe(false)
    })

    it('reports `Free` mode for connections with no mode bound', async () => {
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_x',
            followingWorkspaceId: 'ws_x',
            followingAssistantName: 'X',
            followingOwnerHandle: 'x',
            mode: null,
          },
        ]),
      })
      const tools = createInterAssistantTools(deps)
      const list = tools.find((t) => t.name === 'listConnectedAssistants')!
      const result = await list.execute({}, ctx)
      const data = result.data as Array<{ mode: { name: string } }>
      expect(data[0].mode.name).toBe('Free')
    })

    it('defaults a user-origin follow to trigger=relevance', async () => {
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_lobster',
            followingWorkspaceId: 'ws_lobster',
            followingAssistantName: 'DD Lobster',
            followingOwnerHandle: 'lobster',
            followingBio: 'restaurant scout',
            origin: 'user',
            callerNote: 'lunch picks',
            mode: null,
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
            mode: null,
          },
          {
            followingAssistantId: 'a_feed',
            followingWorkspaceId: 'ws_caller',
            followingAssistantName: 'Feed',
            followingOwnerHandle: 'feed',
            followingAppType: 'distribution',
            origin: 'workspace',
            callerNote: null,
            mode: null,
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
            mode: null,
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
    it('rejects when not following the target', async () => {
      const deps = makeDeps({
        isFollowing: vi.fn().mockResolvedValue(false),
      })
      const tools = createInterAssistantTools(deps)
      const ask = tools.find((t) => t.name === 'askAssistant')!
      const result = await ask.execute({ targetAssistantId: 'a_other', question: 'hi' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.data).toMatch(/Not following/i)
    })

    it('builds a free-mode ConsultRequest and returns the agent text on completed', async () => {
      const send = vi.fn().mockResolvedValue({ task: completedTask('the answer is 42') } satisfies ConsultResponse)
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_target',
            followingWorkspaceId: 'ws_target',
            followingAssistantName: 'Target',
            followingOwnerHandle: 'target',
            mode: null,
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
      expect(req.target.workspaceId).toBe('ws_target')
      expect(req.target.capabilityId).toBeUndefined()
      expect(req.chain.depth).toBe(0)
      expect(req.chain.path).toEqual([])
    })

    it('surfaces an approval-pending message on input_required', async () => {
      const deps = makeDeps({
        getFollowing: vi.fn().mockResolvedValue([
          {
            followingAssistantId: 'a_target',
            followingWorkspaceId: 'ws_target',
            followingAssistantName: 'Target',
            followingOwnerHandle: 'target',
            mode: { id: 'm_1', name: 'Approval-required', description: null, requireApproval: true },
          },
        ]),
        consultTransport: {
          send: vi.fn().mockResolvedValue({ task: inputRequiredTask() } satisfies ConsultResponse),
        },
      })
      const tools = createInterAssistantTools(deps)
      const ask = tools.find((t) => t.name === 'askAssistant')!
      const result = await ask.execute({ targetAssistantId: 'a_target', question: 'sensitive q' }, ctx)
      expect(result.data).toMatch(/approval/i)
    })
  })
})
