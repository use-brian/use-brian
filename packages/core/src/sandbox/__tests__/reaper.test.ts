import { describe, it, expect } from 'vitest'
import { createSandboxReaper, DEFAULT_ABANDONMENT_MS } from '../reaper.js'
import { createSandboxOrchestrator, createInMemorySandboxTaskStore } from '../orchestrator.js'
import { createCloudBrowserProvider } from '../cloud-browser-provider.js'
import { StubSandboxProvider } from '../providers/stub.js'
import type { SessionVault } from '../types.js'

describe('[COMP:sandbox/lifecycle] Sandbox reaper (§4.10)', () => {
  it('kills tasks idle past the abandonment window and runs the daily vault purge', async () => {
    const provider = new StubSandboxProvider()
    const taskStore = createInMemorySandboxTaskStore()
    let t = 1_000_000
    const orchestrator = createSandboxOrchestrator({ provider, taskStore, now: () => t })
    const browser = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
    await browser.navigate({ userId: 'u', workspaceId: 'w', sessionId: 's' }, 'https://example.com/')
    const task = await orchestrator.getActiveTask('s')

    let purges = 0
    const vault: SessionVault = {
      get: async () => null,
      put: async () => {},
      markDead: async () => {},
      touch: async () => {},
      list: async () => [],
      revoke: async () => {},
      purgeInactive: async () => {
        purges += 1
        return 3
      },
    }
    const reaper = createSandboxReaper({ orchestrator, vault, now: () => t })

    // Fresh task: nothing to reap; the purge runs on the first tick of the day.
    const first = await reaper.tick()
    expect(first.reaped).toBe(0)
    expect(first.purged).toBe(3)

    // Abandoned past the window → reaped; the purge does NOT run again within 24h.
    t += DEFAULT_ABANDONMENT_MS + 60_000
    const second = await reaper.tick()
    expect(second.reaped).toBe(1)
    expect(second.purged).toBe(0)
    expect(purges).toBe(1)
    expect(provider.sandboxes.get(task!.sandboxId)?.status).toBe('killed')

    // A day later the purge fires again.
    t += 24 * 60 * 60 * 1000
    const third = await reaper.tick()
    expect(third.purged).toBe(3)
    expect(purges).toBe(2)
  })
})
