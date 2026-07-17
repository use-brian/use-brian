import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createConfirmRecordingProcessingTool } from '../base/confirm-recording-processing.js'
import type { ToolContext } from '../types.js'

const buildChannelSessionKey = (input: { channel: string; channelId: string; userId: string }) =>
  `${input.channel}:${input.channelId}:${input.userId}`

const ctx: ToolContext = {
  userId: 'u-1',
  assistantId: 'a-1',
  sessionId: 's-1',
  appId: 'Use Brian',
  channelType: 'slack',
  channelId: 'C123',
  workspaceId: 'ws-1',
  abortSignal: new AbortController().signal,
}

function makeDeps(
  overrides: Partial<Parameters<typeof createConfirmRecordingProcessingTool>[0]> = {},
) {
  return {
    buildChannelSessionKey,
    getPending: vi.fn(async () => ({
      recordingId: 'rec-1',
      channelSessionKey: 'slack:C123:u-1',
      defaultBlueprintSlug: 'tpl-default',
    })),
    deletePending: vi.fn(async () => {}),
    enqueueRecordingJob: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' })),
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:recordings/confirm-recording-processing] confirmRecordingProcessing', () => {
  it('a blueprint id → enqueues with that blueprint and deletes the pending row', async () => {
    const deps = makeDeps()
    const tool = createConfirmRecordingProcessingTool(deps)
    const res = await tool.execute({ recordingId: 'rec-1', choice: 'tpl-default' }, ctx)

    expect(deps.enqueueRecordingJob).toHaveBeenCalledWith({
      recordingId: 'rec-1',
      workspaceId: 'ws-1',
      actingUserId: 'u-1',
      blueprintSlug: 'tpl-default',
    })
    expect(deps.deletePending).toHaveBeenCalledWith('rec-1')
    expect(res.isError).toBeFalsy()
  })

  it("'ingest-only' → enqueues with no blueprint", async () => {
    const deps = makeDeps()
    const tool = createConfirmRecordingProcessingTool(deps)
    await tool.execute({ recordingId: 'rec-1', choice: 'ingest-only' }, ctx)

    expect(deps.enqueueRecordingJob).toHaveBeenCalledWith(
      expect.objectContaining({ blueprintSlug: null }),
    )
    expect(deps.deletePending).toHaveBeenCalledWith('rec-1')
  })

  it("'cancel' → deletes the row and enqueues nothing", async () => {
    const deps = makeDeps()
    const tool = createConfirmRecordingProcessingTool(deps)
    const res = await tool.execute({ recordingId: 'rec-1', choice: 'cancel' }, ctx)

    expect(deps.enqueueRecordingJob).not.toHaveBeenCalled()
    expect(deps.deletePending).toHaveBeenCalledWith('rec-1')
    expect(String(res.data)).toMatch(/cancel/i)
  })

  it('rejects an unknown recording id (no pending row)', async () => {
    const deps = makeDeps({ getPending: vi.fn(async () => null) })
    const tool = createConfirmRecordingProcessingTool(deps)
    const res = await tool.execute({ recordingId: 'nope', choice: 'cancel' }, ctx)

    expect(res.isError).toBe(true)
    expect(deps.enqueueRecordingJob).not.toHaveBeenCalled()
    expect(deps.deletePending).not.toHaveBeenCalled()
  })

  it('rejects a foreign recording (session key from another conversation)', async () => {
    const deps = makeDeps({
      getPending: vi.fn(async () => ({
        recordingId: 'rec-1',
        channelSessionKey: 'slack:OTHER:other-user', // not this turn's key
        defaultBlueprintSlug: null,
      })),
    })
    const tool = createConfirmRecordingProcessingTool(deps)
    const res = await tool.execute({ recordingId: 'rec-1', choice: 'tpl-default' }, ctx)

    expect(res.isError).toBe(true)
    expect(deps.enqueueRecordingJob).not.toHaveBeenCalled()
    expect(deps.deletePending).not.toHaveBeenCalled()
  })

  it('errors when the assistant has no workspace', async () => {
    const deps = makeDeps()
    const tool = createConfirmRecordingProcessingTool(deps)
    const res = await tool.execute(
      { recordingId: 'rec-1', choice: 'cancel' },
      { ...ctx, workspaceId: null },
    )
    expect(res.isError).toBe(true)
    expect(deps.getPending).not.toHaveBeenCalled()
  })
})
