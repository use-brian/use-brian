import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceChatHandoffTool,
  WORKSPACE_CHAT_HANDOFF_MAX_CHARS,
  workspaceChatHandoffInputSchema,
  type ToolContext,
  type WorkspaceChatHandoffPort,
} from '../../index.js'

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'user-1',
    assistantId: 'assistant-1',
    sessionId: 'private-session-1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'private-channel-1',
    workspaceId: 'workspace-1',
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

describe('[COMP:api/workspace-chat-handoff] shareCurrentWorkToWorkspace', () => {
  it('is a fresh-confirmation write and previews the exact audience, title, and handoff', async () => {
    const tool = createWorkspaceChatHandoffTool({ create: vi.fn() })

    expect(tool.requiresConfirmation).toBe(true)
    expect(tool.allowPersistentApproval).toBe(false)
    expect(tool.isReadOnly).toBe(false)
    expect(tool.isConcurrencySafe).toBe(false)

    await expect(
      tool.describeConfirmation?.(
        {
          title: 'Wholesale pricing launch',
          handoff: 'Goal: finish the price list.\nOpen: confirm delivery fees.',
        },
        context(),
      ),
    ).resolves.toEqual([
      'Audience: Members of the current workspace who can access this room',
      'Title: Wholesale pricing launch',
      'Context teammates will see:',
      'Goal: finish the price list.',
      'Open: confirm delivery fees.',
    ])
  })

  it('uses trusted ToolContext identity and returns the canonical workspace-room path', async () => {
    const create = vi.fn(async () => ({ sessionId: 'room-1' }))
    const tool = createWorkspaceChatHandoffTool({ create } as WorkspaceChatHandoffPort)

    const result = await tool.execute(
      {
        title: 'Wholesale pricing launch',
        handoff: 'Share the pricing decisions and unresolved delivery fee.',
      },
      context(),
    )

    expect(create).toHaveBeenCalledWith({
      sourceSessionId: 'private-session-1',
      userId: 'user-1',
      assistantId: 'assistant-1',
      workspaceId: 'workspace-1',
      appId: 'Use Brian',
      title: 'Wholesale pricing launch',
      handoff: 'Share the pricing decisions and unresolved delivery fee.',
    })
    expect(result).toEqual({
      data: {
        kind: 'workspace_chat_created',
        sessionId: 'room-1',
        title: 'Wholesale pricing launch',
        openPath: '/w/workspace-1/chat?v=workspace&s=room-1',
      },
    })
  })

  it('fails closed outside a workspace web conversation', async () => {
    const create = vi.fn()
    const tool = createWorkspaceChatHandoffTool({ create })

    const noWorkspace = await tool.execute(
      { title: 'Room', handoff: 'Context' },
      context({ workspaceId: null }),
    )
    const onTelegram = await tool.execute(
      { title: 'Room', handoff: 'Context' },
      context({ channelType: 'telegram' }),
    )

    expect(noWorkspace.isError).toBe(true)
    expect(onTelegram.isError).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('bounds the user-visible disclosure payload', () => {
    expect(
      workspaceChatHandoffInputSchema.safeParse({
        title: 'Room',
        handoff: 'x'.repeat(WORKSPACE_CHAT_HANDOFF_MAX_CHARS),
      }).success,
    ).toBe(true)
    expect(
      workspaceChatHandoffInputSchema.safeParse({
        title: 'Room',
        handoff: 'x'.repeat(WORKSPACE_CHAT_HANDOFF_MAX_CHARS + 1),
      }).success,
    ).toBe(false)
  })
})
