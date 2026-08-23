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

  it('uses the thread-qualified conversation id when the channel supplies one', async () => {
    const deps = makeDeps({
      getPending: vi.fn(async () => ({
        recordingId: 'rec-1',
        channelSessionKey: 'slack:C123:thread:100.001:u-1',
        defaultBlueprintSlug: 'tpl-default',
      })),
    })
    const tool = createConfirmRecordingProcessingTool(deps)
    const res = await tool.execute(
      { recordingId: 'rec-1', choice: 'tpl-default' },
      { ...ctx, channelSessionId: 'C123:thread:100.001' },
    )

    expect(res.isError).toBeFalsy()
    expect(deps.enqueueRecordingJob).toHaveBeenCalledOnce()
  })

  it('rejects an unrecognised choice, names it, lists the valid choices, and queues NOTHING', async () => {
    const deps = makeDeps()
    const tool = createConfirmRecordingProcessingTool(deps)
    const res = await tool.execute({ recordingId: 'rec-1', choice: 'yes' }, ctx)

    expect(res.isError).toBe(true)
    expect(deps.enqueueRecordingJob).not.toHaveBeenCalled()
    expect(deps.deletePending).not.toHaveBeenCalled()
    const data = String(res.data)
    expect(data).toContain('"yes"')                 // names the value
    expect(data).toContain('tpl-default')           // lists the default blueprint id
    expect(data).toContain('ingest-only')
    expect(data).toContain('cancel')
    expect(data).toMatch(/will fail the same way/i) // retry verdict
    expect(data).toMatch(/nothing was charged/i)
  })

  it('says which blueprint id to use even when no workspace default is set', async () => {
    const deps = makeDeps({
      getPending: vi.fn(async () => ({
        recordingId: 'rec-1',
        channelSessionKey: 'slack:C123:u-1',
        defaultBlueprintSlug: null,
      })),
    })
    const res = await createConfirmRecordingProcessingTool(deps).execute(
      { recordingId: 'rec-1', choice: 'the default' },
      ctx,
    )
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('no default blueprint set')
    expect(deps.enqueueRecordingJob).not.toHaveBeenCalled()
  })

  it('accepts an unfamiliar but id-shaped choice (blueprint ids are not enumerable here)', async () => {
    const deps = makeDeps()
    const res = await createConfirmRecordingProcessingTool(deps).execute(
      { recordingId: 'rec-1', choice: 'quarterly-review' },
      ctx,
    )
    expect(res.isError).toBeFalsy()
    expect(deps.enqueueRecordingJob).toHaveBeenCalledWith(
      expect.objectContaining({ blueprintSlug: 'quarterly-review' }),
    )
  })

  it('an enqueue failure says processing did NOT start and nothing was charged', async () => {
    const deps = makeDeps({
      enqueueRecordingJob: vi.fn(async () => {
        throw new Error('recording_jobs insert rejected')
      }),
    })
    const res = await createConfirmRecordingProcessingTool(deps).execute(
      { recordingId: 'rec-1', choice: 'tpl-default' },
      ctx,
    )
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('recording_jobs insert rejected')
    expect(String(res.data)).toMatch(/did NOT start/)
    expect(deps.deletePending).not.toHaveBeenCalled()
  })

  it('a failure AFTER the enqueue says processing DID start and forbids a re-confirm', async () => {
    const deps = makeDeps({
      deletePending: vi.fn(async () => {
        throw new Error('pending row delete failed')
      }),
    })
    const res = await createConfirmRecordingProcessingTool(deps).execute(
      { recordingId: 'rec-1', choice: 'ingest-only' },
      ctx,
    )
    expect(deps.enqueueRecordingJob).toHaveBeenCalled()
    expect(res.isError).toBe(true)
    const data = String(res.data)
    expect(data).toMatch(/Processing DID start/)
    expect(data).not.toMatch(/Nothing was saved or changed/)
    expect(data).toMatch(/do NOT call this tool again/i)
  })

  it('a lookup failure is separated from "no pending recording"', async () => {
    const deps = makeDeps({
      getPending: vi.fn(async () => {
        throw new Error('ETIMEDOUT reading pending_recording_confirmations')
      }),
    })
    const res = await createConfirmRecordingProcessingTool(deps).execute(
      { recordingId: 'rec-1', choice: 'cancel' },
      ctx,
    )
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('pending-confirmation lookup')
    expect(String(res.data)).toMatch(/retry once/i)
  })

  it('a missing pending row names the id and forbids the blind retry', async () => {
    const deps = makeDeps({ getPending: vi.fn(async () => null) })
    const res = await createConfirmRecordingProcessingTool(deps).execute(
      { recordingId: 'rec-gone', choice: 'cancel' },
      ctx,
    )
    expect(String(res.data)).toContain('rec-gone')
    expect(String(res.data)).toMatch(/Do NOT retry this exact id/i)
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
