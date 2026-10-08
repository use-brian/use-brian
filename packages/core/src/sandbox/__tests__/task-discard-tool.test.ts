import { describe, it, expect, vi } from 'vitest'
import { createComputerTools } from '../tools.js'
import { createLocalBrowserProvider } from '../local-browser-provider.js'
import type { ToolContext } from '../../tools/types.js'

const ctx: ToolContext = { userId: 'user-1', assistantId: 'assistant-1', sessionId: 'session-1', appId: 'app-1',
  workspaceId: 'workspace-1', channelType: 'web', channelId: 'channel-1', abortSignal: new AbortController().signal }
function fixture() {
  const discardTask = vi.fn(async () => 'discarded' as const)
  const resolvePolicy = vi.fn(async () => 'allow' as 'allow' | 'ask' | 'block')
  const unavailable = createLocalBrowserProvider({ transport: null })
  const tool = createComputerTools({ local: unavailable, cloud: unavailable, discardTask, resolvePolicy }).browserDiscardTask
  return { tool, discardTask, resolvePolicy, run: (input = {}, context = ctx) => tool.execute(tool.inputSchema.parse(input), context) }
}

describe('[COMP:sandbox/task-discard] attended agent recovery', () => {
  it('uses trusted caller context without requiring a readable profile and always confirms', async () => {
    const h = fixture()
    expect(h.tool.requiresConfirmation).toBe(true)
    expect(await h.tool.resolveConfirmation?.(ctx, {})).toBe(true)
    expect((await h.run()).isError).not.toBe(true)
    expect(h.discardTask).toHaveBeenCalledWith(ctx, ctx.sessionId)
    await h.run({ sessionId: 'older-session' })
    expect(h.discardTask).toHaveBeenLastCalledWith(ctx, 'older-session')
    expect(h.tool.inputSchema.safeParse({ userId: 'other-user' }).success).toBe(false)
  })

  it('honors tool blocks, unattended refusal and a revoked current caller', async () => {
    const h = fixture()
    h.resolvePolicy.mockResolvedValueOnce('block')
    expect((await h.run()).isError).toBe(true)
    expect((await h.run({}, { ...ctx, channelType: 'scheduled' })).isError).toBe(true)
    const authority = { assertCurrent: async () => { throw new Error('SECRET_SENTINEL') }, execute: async () => { throw new Error('SECRET_SENTINEL') } }
    const result = await h.run({}, { ...ctx, authority })
    expect(result.isError).toBe(true)
    expect(result.data).not.toContain('SECRET_SENTINEL')
    expect(h.discardTask).not.toHaveBeenCalled()
  })

  it('does not imply success when the host cannot confirm teardown', async () => {
    const h = fixture(); h.discardTask.mockRejectedValueOnce(new Error('SECRET_SENTINEL'))
    const result = await h.run()
    expect(result.isError).toBe(true)
    expect(result.data).toContain('could not be confirmed')
    expect(result.data).not.toContain('SECRET_SENTINEL')
  })
})
