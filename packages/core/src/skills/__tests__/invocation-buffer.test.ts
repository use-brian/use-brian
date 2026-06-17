/**
 * Tests for the per-turn skill invocation buffer (CL-8).
 * Component tag: [COMP:skills/invocation-buffer].
 *
 * Verifies:
 *   - add → flush('success') bumps `succeeded` exactly once per buffered id
 *   - duplicate pushes within a turn dedupe (single bump per id)
 *   - flush('error') does NOT touch counters
 *   - clear() empties without writing
 *   - flush empties the buffer regardless of outcome — second flush no-ops
 *   - empty / whitespace ids are dropped
 *   - sink errors propagate so the caller can log
 *   - V1 does not invoke `incrementUserCorrectedAfter` (deferred to V1.1)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createSkillInvocationBuffer,
  type SkillInvocationSink,
} from '../invocation-buffer.js'

function makeSink(over?: Partial<SkillInvocationSink>): {
  sink: SkillInvocationSink
  succeeded: ReturnType<typeof vi.fn>
  corrected: ReturnType<typeof vi.fn>
} {
  const succeeded = vi.fn().mockResolvedValue(undefined)
  const corrected = vi.fn().mockResolvedValue(undefined)
  const sink: SkillInvocationSink = {
    incrementSucceeded: over?.incrementSucceeded ?? succeeded,
    incrementUserCorrectedAfter: over?.incrementUserCorrectedAfter ?? corrected,
  }
  return { sink, succeeded, corrected }
}

describe('[COMP:skills/invocation-buffer] createSkillInvocationBuffer', () => {
  it('flush("success") bumps succeeded once per unique buffered id', async () => {
    const { sink, succeeded } = makeSink()
    const buf = createSkillInvocationBuffer({ sink })

    buf.addInvocation('row-1')
    buf.addInvocation('row-2')
    buf.addInvocation('row-1') // duplicate within the same turn → dedupes

    await buf.flush('success')

    expect(succeeded).toHaveBeenCalledTimes(2)
    expect(succeeded.mock.calls.map((c) => c[0]).sort()).toEqual(['row-1', 'row-2'])
  })

  it('flush("error") does not touch counters', async () => {
    const { sink, succeeded, corrected } = makeSink()
    const buf = createSkillInvocationBuffer({ sink })

    buf.addInvocation('row-1')
    buf.addInvocation('row-2')

    await buf.flush('error')

    expect(succeeded).not.toHaveBeenCalled()
    expect(corrected).not.toHaveBeenCalled()
  })

  it('empties the buffer after flush — second flush no-ops', async () => {
    const { sink, succeeded } = makeSink()
    const buf = createSkillInvocationBuffer({ sink })

    buf.addInvocation('row-1')
    await buf.flush('success')
    expect(succeeded).toHaveBeenCalledTimes(1)
    expect(buf.getInvocations()).toEqual([])

    // Second flush of an empty buffer.
    await buf.flush('success')
    expect(succeeded).toHaveBeenCalledTimes(1)
  })

  it('clear() drops queued ids without writing', async () => {
    const { sink, succeeded } = makeSink()
    const buf = createSkillInvocationBuffer({ sink })

    buf.addInvocation('row-1')
    buf.addInvocation('row-2')
    expect(buf.getInvocations()).toHaveLength(2)

    buf.clear()
    expect(buf.getInvocations()).toEqual([])

    await buf.flush('success')
    expect(succeeded).not.toHaveBeenCalled()
  })

  it('drops empty-string ids — defensive against bad callers', async () => {
    const { sink, succeeded } = makeSink()
    const buf = createSkillInvocationBuffer({ sink })

    buf.addInvocation('')
    buf.addInvocation('row-1')

    await buf.flush('success')
    expect(succeeded).toHaveBeenCalledTimes(1)
    expect(succeeded).toHaveBeenCalledWith('row-1')
  })

  it('propagates sink errors so the caller can log', async () => {
    const failingSucceeded = vi.fn().mockRejectedValue(new Error('boom'))
    const { sink } = makeSink({ incrementSucceeded: failingSucceeded })
    const buf = createSkillInvocationBuffer({ sink })

    buf.addInvocation('row-1')
    await expect(buf.flush('success')).rejects.toThrow('boom')
  })

  it('V1: does NOT invoke incrementUserCorrectedAfter even with getNextUserMessage', async () => {
    const { sink, corrected } = makeSink()
    const buf = createSkillInvocationBuffer({ sink })

    buf.addInvocation('row-1')
    await buf.flush('success', async () => 'no, that was wrong')

    // The V1.1 cross-turn signal is intentionally deferred — the hook
    // is shaped but not wired. If this assertion ever flips, the V1.1
    // landing should add explicit tests for the cross-turn path.
    expect(corrected).not.toHaveBeenCalled()
  })

  it('preserves insertion order in getInvocations()', () => {
    const { sink } = makeSink()
    const buf = createSkillInvocationBuffer({ sink })

    buf.addInvocation('b')
    buf.addInvocation('a')
    buf.addInvocation('c')

    expect(buf.getInvocations()).toEqual(['b', 'a', 'c'])
  })
})
