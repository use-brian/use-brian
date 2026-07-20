/**
 * Unit tests for the reportBug tool.
 * Component tag: [COMP:tools/report-bug].
 *
 * Verifies createReportBugTool: the tool metadata, and that execute
 * forwards the session/channel context plus the input fields to the
 * bug-report store and returns a confirmation carrying the short id.
 */

import { describe, it, expect, vi } from 'vitest'
import { createReportBugTool, type BugReportStore } from '../report-bug.js'

const ctx = {
  assistantId: 'a-1',
  userId: 'u-1',
  sessionId: 's-1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'c-1',
  workspaceId: 'w-1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:tools/report-bug] createReportBugTool', () => {
  it('exposes a non-read-only, concurrency-safe reportBug tool', () => {
    const tool = createReportBugTool({ create: vi.fn() } as BugReportStore)
    expect(tool.name).toBe('reportBug')
    expect(tool.isReadOnly).toBe(false)
    expect(tool.isConcurrencySafe).toBe(true)
  })

  it('forwards context + input to the store and returns the short report id', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'abcdef12-3456-7890' })
    const tool = createReportBugTool({ create } as BugReportStore)
    const res = await tool.execute(
      { title: 'Login broken', description: 'it fails', severity: 'high' },
      ctx,
    )
    expect(create).toHaveBeenCalledWith({
      assistantId: 'a-1',
      userId: 'u-1',
      sessionId: 's-1',
      channelType: 'web',
      channelId: 'c-1',
      title: 'Login broken',
      description: 'it fails',
      severity: 'high',
    })
    expect(res.data).toContain('abcdef12')
  })
})
