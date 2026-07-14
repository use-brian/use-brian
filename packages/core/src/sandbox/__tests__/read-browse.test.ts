import { describe, it, expect } from 'vitest'
import { createComputerTools, type ComputerToolProfiles } from '../tools.js'
import { createInMemoryBrowserProfileStore } from '../profiles.js'
import type { Tool, ToolContext } from '../../tools/types.js'
import type { BrowserCallContext, BrowserProvider } from '../types.js'

function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'user-1',
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'app-1',
    channelType: 'web',
    channelId: 'chan-1',
    workspaceId: 'ws-1',
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

/**
 * Fake cloud provider that records ops + the exact BrowserCallContext each op
 * ran under (the identity-less assertions read `ctxs`). `navigateGates`
 * lets the serialization test hold a navigate open: when `gated` is true,
 * each navigate awaits its releaser, pushed in call order.
 */
function fakeCloud(opts: { navigateUrl?: (url: string) => string; gated?: boolean } = {}) {
  const calls: string[] = []
  const ctxs: BrowserCallContext[] = []
  const releasers: Array<() => void> = []
  const provider: BrowserProvider = {
    kind: 'cloud',
    async navigate(ctx, url) {
      calls.push(`navigate:${url}`)
      ctxs.push(ctx)
      if (opts.gated) {
        await new Promise<void>((resolve) => releasers.push(resolve))
      }
      return { url: opts.navigateUrl ? opts.navigateUrl(url) : url }
    },
    async snapshot(ctx) {
      calls.push('snapshot')
      ctxs.push(ctx)
      return {
        url: 'https://lu.ma/hk',
        title: 'Luma — Hong Kong',
        nodes: [
          { ref: '@e1', role: 'link', name: 'AI Builders Meetup — Jul 20' },
          { ref: '@e2', role: 'link', name: 'Founder Coffee — Jul 22' },
          { ref: '@e3', role: 'button', name: 'Sign In' },
        ],
      }
    },
    async click() {
      calls.push('click')
    },
    async type() {
      calls.push('type')
    },
    async currentUrl() {
      calls.push('currentUrl')
      return { url: 'https://lu.ma/hk', title: 'Luma — Hong Kong' }
    },
    async stop() {
      calls.push('stop')
    },
  }
  return { provider, calls, ctxs, releasers }
}

function localNever(): BrowserProvider {
  return {
    kind: 'local',
    async navigate() {
      throw new Error('local backend must never be reached by browserReadPage')
    },
    async snapshot() {
      throw new Error('local backend must never be reached by browserReadPage')
    },
    async click() {
      throw new Error('unreachable')
    },
    async type() {
      throw new Error('unreachable')
    },
    async currentUrl() {
      throw new Error('unreachable')
    },
    async stop() {},
  }
}

async function run(tool: Tool, input: Record<string, unknown>, ctx = toolContext()) {
  return tool.execute(tool.inputSchema.parse(input), ctx)
}

/** One usable cloud-default profile signed into lu.ma, enabled for asst-1. */
async function profilesWithLuma(): Promise<ComputerToolProfiles> {
  const store = createInMemoryBrowserProfileStore()
  await store.create({
    workspaceId: 'ws-1',
    ownerUserId: 'user-1',
    name: 'Work',
    clearance: 'confidential',
    defaultBackend: 'cloud',
    enabledAssistantIds: ['asst-1'],
  })
  return { store, assistantClearance: async () => 'confidential' }
}

describe('[COMP:sandbox/read-browse] browserReadPage — the sends-forbidden research reader', () => {
  it('is read-only by flag and exposes no actionable refs in its output', async () => {
    const cloud = fakeCloud()
    const tools = createComputerTools({ local: localNever(), cloud: cloud.provider, cloudAvailable: () => true })
    expect(tools.browserReadPage.isReadOnly).toBe(true)

    const res = await run(tools.browserReadPage, { url: 'https://lu.ma/hk' })
    expect(res.isError).toBeUndefined()
    expect(res.data).toContain('Page: Luma — Hong Kong')
    expect(res.data).toContain('URL: https://lu.ma/hk')
    expect(res.data).toContain('link "AI Builders Meetup — Jul 20"')
    // No @ref tokens — the reader has no click/type surface to use them with.
    expect(res.data).not.toContain('@e1')
    expect(cloud.calls).toEqual(['navigate:https://lu.ma/hk', 'snapshot'])
  })

  it('is cloud-only: refuses honestly when no sandbox backend is configured, never falling back to the local extension', async () => {
    const cloud = fakeCloud()
    const tools = createComputerTools({ local: localNever(), cloud: cloud.provider, cloudAvailable: () => false })
    const res = await run(tools.browserReadPage, { url: 'https://lu.ma/hk' })
    expect(res.isError).toBe(true)
    expect(res.data).toContain('Report the URL itself as the finding')
    expect(cloud.calls).toEqual([])
  })

  it('browses identity-less: no profileId in the call context, even when a usable profile exists and the session already browsed as it', async () => {
    const cloud = fakeCloud()
    const tools = createComputerTools({
      local: localNever(),
      cloud: cloud.provider,
      cloudAvailable: () => true,
      profiles: await profilesWithLuma(),
    })
    // An interactive navigate first — resolves and pins the profile on the
    // shared session state.
    await run(tools.browserNavigate, { url: 'https://lu.ma/settings' })
    const interactiveCtx = cloud.ctxs.at(-1)
    expect(interactiveCtx?.profileId).toBeTruthy()

    cloud.ctxs.length = 0
    const res = await run(tools.browserReadPage, { url: 'https://lu.ma/hk' })
    expect(res.isError).toBeUndefined()
    for (const ctx of cloud.ctxs) {
      expect(ctx.profileId).toBeUndefined()
    }
  })

  it('login wall → the URL is the deliverable: no snapshot, no pause, no Take-Over link', async () => {
    const cloud = fakeCloud({ navigateUrl: () => 'https://www.instagram.com/accounts/login/' })
    let paused = 0
    const tools = createComputerTools({
      local: localNever(),
      cloud: cloud.provider,
      cloudAvailable: () => true,
      takeoverLinkFor: () => 'https://app.example/w/ws-1/computer/sess-1',
      onCloudLoginWall: async () => {
        paused += 1
      },
    })
    const res = await run(tools.browserReadPage, { url: 'https://www.instagram.com/p/abc/' })
    expect(res.isError).toBeUndefined()
    expect(res.data).toContain('behind a login')
    expect(res.data).toContain('Do not retry this URL')
    expect(res.data).not.toContain('https://app.example')
    expect(res.meta).toMatchObject({ loginWall: true })
    expect(cloud.calls).toEqual(['navigate:https://www.instagram.com/p/abc/'])
    expect(paused).toBe(0)
  })

  it('serializes concurrent reads on the same session — worker B cannot navigate between worker A’s navigate and snapshot', async () => {
    const cloud = fakeCloud({ gated: true })
    const tools = createComputerTools({ local: localNever(), cloud: cloud.provider, cloudAvailable: () => true })

    const a = run(tools.browserReadPage, { url: 'https://a.example/one' })
    const b = run(tools.browserReadPage, { url: 'https://b.example/two' })
    await new Promise((r) => setTimeout(r, 0))
    // Only A's navigate has started; B is queued behind the session lock.
    expect(cloud.releasers.length).toBe(1)
    expect(cloud.calls).toEqual(['navigate:https://a.example/one'])

    cloud.releasers[0]()
    await a
    await new Promise((r) => setTimeout(r, 0))
    expect(cloud.releasers.length).toBe(2)
    cloud.releasers[1]()
    await b

    expect(cloud.calls).toEqual([
      'navigate:https://a.example/one',
      'snapshot',
      'navigate:https://b.example/two',
      'snapshot',
    ])
  })

  it('refuses on autonomous (headless-scheduled) paths like every other browser tool', async () => {
    const cloud = fakeCloud()
    const tools = createComputerTools({ local: localNever(), cloud: cloud.provider, cloudAvailable: () => true })
    const res = await run(tools.browserReadPage, { url: 'https://lu.ma/hk' }, toolContext({ channelType: 'cron' }))
    expect(res.isError).toBe(true)
    expect(cloud.calls).toEqual([])
  })

  it('honors the workspace tool policy block', async () => {
    const cloud = fakeCloud()
    const tools = createComputerTools({
      local: localNever(),
      cloud: cloud.provider,
      cloudAvailable: () => true,
      resolvePolicy: async (toolName) => (toolName === 'browserReadPage' ? 'block' : 'allow'),
    })
    const res = await run(tools.browserReadPage, { url: 'https://lu.ma/hk' })
    expect(res.isError).toBe(true)
    expect(res.data).toContain('blocked by tool policy')
    expect(cloud.calls).toEqual([])
  })
})
