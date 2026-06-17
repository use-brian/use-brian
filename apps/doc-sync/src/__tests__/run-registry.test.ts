import { describe, it, expect, vi } from 'vitest'
import { createRunRegistry } from '../run-registry.js'
import type { AssistantRunState } from '@sidanclaw/doc-model'

const actor = { id: 'u1', name: 'Alice', color: '#34D3FF' }

function setup(start = 1_000) {
  let t = start
  const clock = () => t
  const advance = (ms: number) => {
    t += ms
  }
  const publish = vi.fn<(p: string, s: AssistantRunState | null) => void>()
  const reg = createRunRegistry({ publish, now: clock, ttlMs: 100 })
  return { reg, publish, advance }
}

describe('[COMP:doc-sync/run-registry] Assistant run registry', () => {
  it('start opens a run, stamps times, and publishes it', () => {
    const { reg, publish } = setup(1_000)
    const state = reg.start({ pageId: 'p', actor, channel: 'telegram' })
    expect(state).toMatchObject({
      pageId: 'p',
      status: 'running',
      actor,
      channel: 'telegram',
      startedAt: 1_000,
      expiresAt: 1_100,
    })
    expect(reg.size).toBe(1)
    expect(publish).toHaveBeenCalledWith('p', state)
  })

  it('start refreshes expiry but preserves the original startedAt', () => {
    const { reg, advance } = setup(1_000)
    reg.start({ pageId: 'p', actor, channel: 'web' })
    advance(50)
    const again = reg.start({ pageId: 'p', actor, channel: 'web' })
    expect(again.startedAt).toBe(1_000) // unchanged
    expect(again.expiresAt).toBe(1_150) // refreshed from now=1050
  })

  it('progress heartbeats an open run, refreshes expiry, and merges step', () => {
    const { reg, publish, advance } = setup(1_000)
    reg.start({ pageId: 'p', actor, channel: 'doc' })
    advance(30)
    const state = reg.progress({
      pageId: 'p',
      step: { op: 'add', blockType: 'heading', count: 2 },
      toolName: 'patchPage',
    })
    expect(state).toMatchObject({
      startedAt: 1_000,
      expiresAt: 1_130,
      step: { op: 'add', blockType: 'heading', count: 2 },
      toolName: 'patchPage',
    })
    expect(publish).toHaveBeenLastCalledWith('p', state)
  })

  it('progress without an open run is a no-op (never resurrects a banner)', () => {
    const { reg, publish } = setup()
    const result = reg.progress({ pageId: 'ghost', step: { op: 'edit' } })
    expect(result).toBeNull()
    expect(reg.size).toBe(0)
    expect(publish).not.toHaveBeenCalled()
  })

  it('end clears the run and publishes null; idempotent', () => {
    const { reg, publish } = setup()
    reg.start({ pageId: 'p', actor, channel: 'slack' })
    publish.mockClear()
    reg.end('p')
    expect(reg.get('p')).toBeNull()
    expect(reg.size).toBe(0)
    expect(publish).toHaveBeenCalledWith('p', null)
    publish.mockClear()
    reg.end('p') // second end — nothing to clear
    expect(publish).not.toHaveBeenCalled()
  })

  it('sweep drops + publishes-clear only runs past their TTL', () => {
    const { reg, publish, advance } = setup(1_000)
    reg.start({ pageId: 'stale', actor, channel: 'web' })
    advance(60)
    reg.start({ pageId: 'fresh', actor, channel: 'web' }) // expiresAt = 1_160
    advance(50) // now = 1_110 → stale (1_100) expired, fresh (1_160) alive
    publish.mockClear()
    const cleared = reg.sweep()
    expect(cleared).toEqual(['stale'])
    expect(reg.get('stale')).toBeNull()
    expect(reg.get('fresh')).not.toBeNull()
    expect(publish).toHaveBeenCalledExactlyOnceWith('stale', null)
  })

  it('republish re-emits the current state (late-joiner seeding)', () => {
    const { reg, publish } = setup()
    const state = reg.start({ pageId: 'p', actor, channel: 'doc' })
    publish.mockClear()
    reg.republish('p')
    expect(publish).toHaveBeenCalledWith('p', state)
    reg.republish('absent')
    expect(publish).toHaveBeenLastCalledWith('absent', null)
  })
})
