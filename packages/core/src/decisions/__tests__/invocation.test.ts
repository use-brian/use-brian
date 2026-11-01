import { describe, expect, it, vi } from 'vitest'
import { withDecisionInvocation } from '../invocation.js'

describe('[COMP:decisions/hydra] terminal invocation boundary', () => {
  it('terminates at the deadline even when admission never settles', async () => {
    vi.useFakeTimers()
    try {
      const start = Date.now()
      const run = withDecisionInvocation({ deadlineAt: start + 100, call: () => new Promise(() => {}) })
      const refusal = expect(run).rejects.toMatchObject({ kind: 'timeout' })
      await Promise.all([refusal, vi.advanceTimersByTimeAsync(100)])
      expect(Date.now() - start).toBe(100)
    } finally { vi.useRealTimers() }
  })

  it('prevents late admission from starting a dispatch or accounting callback', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const admission = new Promise<void>(resolve => { release = resolve })
    const effect = vi.fn()
    try {
      const run = withDecisionInvocation({ deadlineAt: Date.now() + 100, call: async invocation => {
        await admission
        invocation.assertActive()
        effect()
        return 'verdict'
      } })
      const refusal = expect(run).rejects.toMatchObject({ kind: 'timeout' })
      await Promise.all([refusal, vi.advanceTimersByTimeAsync(100)])
      release(); await vi.runAllTimersAsync()
      expect(effect).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('only tightens a resolved profile budget and includes time spent resolving it', async () => {
    vi.useFakeTimers()
    try {
      const start = Date.now()
      const run = withDecisionInvocation({ deadlineAt: start + 1000, call: async invocation => {
        await new Promise(resolve => setTimeout(resolve, 60))
        invocation.tightenDeadline(start + 100)
        invocation.tightenDeadline(start + 5000)
        return new Promise(() => {})
      } })
      const refusal = expect(run).rejects.toMatchObject({ kind: 'timeout' })
      await Promise.all([refusal, vi.advanceTimersByTimeAsync(100)])
      expect(Date.now() - start).toBe(100)
    } finally { vi.useRealTimers() }
  })

  it('cancels pending work without invoking a later continuation', async () => {
    const controller = new AbortController()
    const run = withDecisionInvocation({ signal: controller.signal, call: () => new Promise(() => {}) })
    const refusal = expect(run).rejects.toMatchObject({ kind: 'cancelled' })
    controller.abort(); await refusal
  })
})
