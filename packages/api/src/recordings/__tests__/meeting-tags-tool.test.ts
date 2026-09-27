import { describe, expect, it, vi } from 'vitest'
import { createMeetingTagsTool } from '../meeting-tags-tool.js'
const mock = vi.hoisted(() => ({ read: vi.fn(), command: vi.fn(), access: vi.fn() }))
vi.mock('../meeting-tags-service.js', () => ({ createMeetingTagsService: () => ({ read: mock.read, command: mock.command }) }))
vi.mock('../../db/client.js', () => ({ runWithAgentAccess: (actor: unknown, run: () => unknown) => { mock.access(actor); return run() } }))
const context = { userId: 'user', workspaceId: 'workspace', assistantId: 'assistant', sessionId: 'session', channelType: 'web', channelId: 'channel', clearance: 'internal', compartments: ['operations'] } as never
const pageId = '00000000-0000-0000-0000-000000000001'
describe('[COMP:recordings/meeting-tags] Brian command parity', () => {
  it('reads without mutation and delegates explicit commands with the current actor ceiling', async () => {
    const tool = createMeetingTagsTool({} as never)
    mock.read.mockResolvedValue({ tags: [], rules: [], suggestions: [] })
    await tool.execute({ pageId }, context)
    expect(mock.command).not.toHaveBeenCalled()
    expect(mock.read).toHaveBeenCalledWith('user', 'workspace', pageId)
    expect(mock.access).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user', workspaceId: 'workspace', clearance: 'internal', compartments: ['operations'] }))
    const command = { kind: 'set-tags' as const, tags: ['Custom'] }
    await tool.execute({ pageId, command }, context)
    expect(mock.command).toHaveBeenCalledWith('user', 'workspace', pageId, command)
  })
  it('rejects a missing workspace without running the service', async () => {
    vi.clearAllMocks()
    const result = await createMeetingTagsTool({} as never).execute({ pageId }, { ...(context as object), workspaceId: null } as never)
    expect(result.isError).toBe(true)
    expect(mock.read).not.toHaveBeenCalled()
    expect(mock.command).not.toHaveBeenCalled()
  })
})
