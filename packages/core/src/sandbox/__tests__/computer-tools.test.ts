import { describe, it, expect } from 'vitest'
import { createComputerTools, SEND_LIKE_LABEL_PATTERN, type ComputerToolProfiles } from '../tools.js'
import { createLocalBrowserProvider } from '../local-browser-provider.js'
import { createInMemoryBrowserProfileStore } from '../profiles.js'
import type { Tool, ToolContext } from '../../tools/types.js'
import type { BrowserProvider, RelayCommandResult } from '../types.js'

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

/** A fake BrowserProvider that records calls and serves a scripted snapshot. */
function fakeProvider(kind: 'local' | 'cloud'): BrowserProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    kind,
    calls,
    async navigate(_ctx, url) {
      calls.push(`navigate:${url}`)
      return { url }
    },
    async snapshot() {
      calls.push('snapshot')
      return {
        url: 'https://www.linkedin.com/messaging/',
        title: 'Messaging',
        nodes: [
          { ref: '@e1', role: 'textbox', name: 'Write a message' },
          { ref: '@e2', role: 'button', name: 'Send' },
          { ref: '@e3', role: 'link', name: 'Jane Doe' },
        ],
      }
    },
    async click(_ctx, ref) {
      calls.push(`click:${ref}`)
    },
    async type(_ctx, ref, text) {
      calls.push(`type:${ref}:${text}`)
    },
    async currentUrl() {
      calls.push('currentUrl')
      return { url: 'https://www.linkedin.com/messaging/', title: 'Messaging' }
    },
    async stop() {
      calls.push('stop')
    },
  }
}

async function run(tool: Tool, input: Record<string, unknown>, ctx = toolContext()) {
  return tool.execute(tool.inputSchema.parse(input), ctx)
}

/** Profiles plumbing with one usable profile (enabled for asst-1, cleared). */
async function profilesWith(
  entries: Array<{ name: string; defaultBackend?: 'local' | 'cloud'; enabled?: boolean }>,
): Promise<ComputerToolProfiles> {
  const store = createInMemoryBrowserProfileStore()
  for (const entry of entries) {
    await store.create({
      workspaceId: 'ws-1',
      ownerUserId: 'user-1',
      name: entry.name,
      clearance: 'confidential',
      defaultBackend: entry.defaultBackend ?? 'cloud',
      enabledAssistantIds: entry.enabled === false ? [] : ['asst-1'],
    })
  }
  return { store, assistantClearance: async () => 'confidential' }
}

describe('[COMP:sandbox/browser-tools] Computer tool surface', () => {
  it('backend seeds from the profile’s defaultBackend (R2-3): a local-default profile browses locally even with cloud available', async () => {
    const local = fakeProvider('local')
    const cloud = fakeProvider('cloud')
    const tools = createComputerTools({
      local,
      cloud,
      cloudAvailable: () => true,
      profiles: await profilesWith([{ name: 'Personal', defaultBackend: 'local' }]),
    })

    await run(tools.browserNavigate, { url: 'https://www.linkedin.com/messaging/' })
    // Navigate carries its own follow-up snapshot (one model turn per step).
    expect(local.calls).toEqual(['navigate:https://www.linkedin.com/messaging/', 'snapshot'])
    expect(cloud.calls).toEqual([])
  })

  it('defaults to cloud when available and no profile says otherwise', async () => {
    const local = fakeProvider('local')
    const cloud = fakeProvider('cloud')
    const tools = createComputerTools({ local, cloud, cloudAvailable: () => true })
    await run(tools.browserNavigate, { url: 'https://news.ycombinator.com/' })
    expect(cloud.calls).toEqual(['navigate:https://news.ycombinator.com/', 'snapshot'])
    expect(local.calls).toEqual([])
  })

  it('navigate returns the page elements inline and caches labels for the send gate', async () => {
    const tools = createComputerTools({ local: fakeProvider('local'), cloud: fakeProvider('cloud') })
    const ctx = toolContext()
    const res = await run(tools.browserNavigate, { url: 'https://www.linkedin.com/messaging/' }, ctx)
    expect(String(res.data)).toContain('@e2 button "Send"')
    // The inline snapshot fed the send gate: a send-like label needs approval.
    expect(await tools.browserClick.resolveConfirmation!(ctx, { ref: '@e2' })).toBe(true)
    expect(await tools.browserClick.resolveConfirmation!(ctx, { ref: '@e3' })).toBe(false)
  })

  it('the live toggle wins over the profile default for the session (R2-3)', async () => {
    const local = fakeProvider('local')
    const cloud = fakeProvider('cloud')
    const tools = createComputerTools({
      local,
      cloud,
      cloudAvailable: () => true,
      profiles: await profilesWith([{ name: 'Personal', defaultBackend: 'cloud' }]),
    })
    tools.setSessionBackendOverride('sess-1', 'local')
    await run(tools.browserNavigate, { url: 'https://news.ycombinator.com/' })
    expect(local.calls).toEqual(['navigate:https://news.ycombinator.com/', 'snapshot'])
    expect(cloud.calls).toEqual([])
    expect(tools.getSessionBackend('sess-1')).toBe('local')
  })

  it('several enabled profiles force the model to NAME one; the named profile resolves (R2-10)', async () => {
    const local = fakeProvider('local')
    const cloud = fakeProvider('cloud')
    const tools = createComputerTools({
      local,
      cloud,
      cloudAvailable: () => true,
      profiles: await profilesWith([
        { name: 'Personal IG', defaultBackend: 'local' },
        { name: 'Company IG', defaultBackend: 'cloud' },
      ]),
    })
    const ambiguous = await run(tools.browserNavigate, { url: 'https://www.instagram.com/' })
    expect(ambiguous.isError).toBe(true)
    expect(String(ambiguous.data)).toContain('Personal IG')
    expect(String(ambiguous.data)).toContain('Company IG')
    expect(local.calls).toEqual([])
    expect(cloud.calls).toEqual([])

    const named = await run(tools.browserNavigate, { url: 'https://www.instagram.com/', profile: 'Personal IG' })
    expect(named.isError ?? false).toBe(false)
    expect(local.calls).toEqual(['navigate:https://www.instagram.com/', 'snapshot'])
  })

  it('keeps follow-up ops on the backend the last navigation picked', async () => {
    const local = fakeProvider('local')
    const cloud = fakeProvider('cloud')
    const tools = createComputerTools({
      local,
      cloud,
      cloudAvailable: () => true,
      profiles: await profilesWith([{ name: 'Personal', defaultBackend: 'local' }]),
    })
    await run(tools.browserNavigate, { url: 'https://www.linkedin.com/messaging/' })
    await run(tools.browserSnapshot, {})
    await run(tools.browserType, { ref: '@e1', text: 'hello' })
    expect(local.calls).toEqual([
      'navigate:https://www.linkedin.com/messaging/',
      'snapshot', // navigate's inline snapshot
      'snapshot',
      'type:@e1:hello',
    ])
    expect(cloud.calls).toEqual([])
  })

  it('serializes tool calls to P1.2 relay command envelopes through the local provider', async () => {
    const sent: Array<{ userId: string; op: string; args?: Record<string, unknown> }> = []
    const local = createLocalBrowserProvider({
      transport: {
        async send(params) {
          sent.push(params)
          const responses: Record<string, RelayCommandResult> = {
            navigate: { ok: true, data: { url: 'https://www.linkedin.com/messaging/' } },
            snapshot: {
              ok: true,
              data: { url: 'https://x.test/', title: 't', nodes: [{ ref: '@e1', role: 'button', name: 'Send' }] },
            },
            type: { ok: true },
            currentUrl: { ok: true, data: { url: 'https://x.test/', title: 't' } },
          }
          return responses[params.op] ?? { ok: true }
        },
      },
    })
    const tools = createComputerTools({ local, cloud: fakeProvider('cloud') })
    await run(tools.browserNavigate, { url: 'https://www.linkedin.com/messaging/' })
    await run(tools.browserSnapshot, {})
    await run(tools.browserType, { ref: '@e1', text: 'hi there' })
    await run(tools.browserCurrentUrl, {})
    expect(sent.map((s) => s.op)).toEqual(['navigate', 'snapshot', 'snapshot', 'type', 'currentUrl'])
    expect(sent[0]).toMatchObject({ userId: 'user-1', args: { url: 'https://www.linkedin.com/messaging/' } })
    expect(sent[3]).toMatchObject({ args: { ref: '@e1', text: 'hi there' } })
  })

  it('surfaces the clear no-extension error through the tool result (P1.4)', async () => {
    const local = createLocalBrowserProvider({
      transport: { send: async () => ({ ok: false, error: 'none', code: 'no_extension' }) },
    })
    const tools = createComputerTools({ local, cloud: fakeProvider('cloud') })
    const res = await run(tools.browserSnapshot, {})
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('Use Brian extension')
    expect(res.meta?.code).toBe('no_extension')
  })

  it('renders the snapshot as a token-cheap ref list and caches labels for the send gate', async () => {
    const tools = createComputerTools({ local: fakeProvider('local'), cloud: fakeProvider('cloud') })
    const res = await run(tools.browserSnapshot, {})
    expect(String(res.data)).toContain('@e2 button "Send"')
    expect(String(res.data)).toContain('URL: https://www.linkedin.com/messaging/')
  })

  describe('send gate (P1.7 / §8 no unattended state-change)', () => {
    async function gateFor(input: { ref: string; intent?: string }, snapshotFirst = true) {
      const tools = createComputerTools({ local: fakeProvider('local'), cloud: fakeProvider('cloud') })
      const ctx = toolContext()
      if (snapshotFirst) await run(tools.browserSnapshot, {}, ctx)
      return {
        needsConfirmation: await tools.browserClick.resolveConfirmation!(ctx, input),
        tools,
        ctx,
      }
    }

    it('gates a click on a send-like label (the "Send" button) even without a declared intent', async () => {
      const { needsConfirmation } = await gateFor({ ref: '@e2' })
      expect(needsConfirmation).toBe(true)
    })

    it('gates any click the model declares intent:"submit" for', async () => {
      const { needsConfirmation } = await gateFor({ ref: '@e3', intent: 'submit' })
      expect(needsConfirmation).toBe(true)
    })

    it('does not gate composing clicks (opening a thread by a person link)', async () => {
      const { needsConfirmation } = await gateFor({ ref: '@e3' })
      expect(needsConfirmation).toBe(false)
    })

    it('fails closed: an unknown ref (no snapshot cached) requires confirmation', async () => {
      const { needsConfirmation } = await gateFor({ ref: '@e9' }, false)
      expect(needsConfirmation).toBe(true)
    })

    it('previews the send with the target label and the last typed message', async () => {
      const tools = createComputerTools({ local: fakeProvider('local'), cloud: fakeProvider('cloud') })
      const ctx = toolContext()
      await run(tools.browserSnapshot, {}, ctx)
      await run(tools.browserType, { ref: '@e1', text: 'Hey Jane, congrats on the launch!' }, ctx)
      const lines = await tools.browserClick.describeConfirmation!({ ref: '@e2' }, ctx)
      expect(lines?.[0]).toBe('Click "Send" in the browser')
      expect(lines?.[1]).toContain('Hey Jane, congrats on the launch!')
    })

    it('the pattern covers the spec verbs', () => {
      for (const label of ['Send', 'Post now', 'Submit order', 'Buy', 'Pay', 'Confirm', 'Delete message', 'Apply']) {
        expect(SEND_LIKE_LABEL_PATTERN.test(label)).toBe(true)
      }
      for (const label of ['Write a message', 'Jane Doe', 'Open thread', 'Search']) {
        expect(SEND_LIKE_LABEL_PATTERN.test(label)).toBe(false)
      }
    })
  })

  describe('autonomous-path hard block (Barrier 2 default posture)', () => {
    it('refuses every browser tool on a headless channel when unattended mode is off', async () => {
      const local = fakeProvider('local')
      const tools = createComputerTools({ local, cloud: fakeProvider('cloud') })
      const cronCtx = toolContext({ channelType: 'workflow' })
      for (const tool of [tools.browserNavigate, tools.browserSnapshot, tools.browserClick, tools.browserType, tools.browserCurrentUrl]) {
        const res = await tool.execute(
          tool.inputSchema.parse(
            tool.name === 'browserNavigate'
              ? { url: 'https://example.com/' }
              : tool.name === 'browserClick'
                ? { ref: '@e1' }
                : tool.name === 'browserType'
                  ? { ref: '@e1', text: 'x' }
                  : {},
          ),
          cronCtx,
        )
        expect(res.isError).toBe(true)
        expect(String(res.data)).toContain('autonomous')
      }
      expect(local.calls).toEqual([])
    })

    it('allows headless browsing only when unattended computer-use is enabled AND the plan is paid', async () => {
      const local = fakeProvider('local')
      const tools = createComputerTools({
        local,
        cloud: fakeProvider('cloud'),
        unattendedEnabled: () => true,
        getWorkspacePlan: async () => 'pro',
      })
      const res = await run(tools.browserSnapshot, {}, toolContext({ channelType: 'workflow' }))
      expect(res.isError).toBeUndefined()
      expect(local.calls).toEqual(['snapshot'])
    })

    it('free plan stays blocked even with the unattended flag on (R2-8: paid-gated)', async () => {
      const local = fakeProvider('local')
      const tools = createComputerTools({
        local,
        cloud: fakeProvider('cloud'),
        unattendedEnabled: () => true,
        getWorkspacePlan: async () => 'free',
      })
      const res = await run(tools.browserSnapshot, {}, toolContext({ channelType: 'workflow' }))
      expect(res.isError).toBe(true)
      expect(String(res.data)).toContain('paid plans')
      expect(local.calls).toEqual([])
    })

    it('a missing plan resolver fails closed on unattended paths', async () => {
      const local = fakeProvider('local')
      const tools = createComputerTools({
        local,
        cloud: fakeProvider('cloud'),
        unattendedEnabled: () => true,
      })
      const res = await run(tools.browserSnapshot, {}, toolContext({ channelType: 'workflow' }))
      expect(res.isError).toBe(true)
      expect(local.calls).toEqual([])
    })
  })

  describe('safety fuse (P1.8)', () => {
    it('caps per-session browser calls', async () => {
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud: fakeProvider('cloud'),
        fuse: { maxCallsPerSession: 2 },
      })
      const ctx = toolContext()
      await run(tools.browserSnapshot, {}, ctx)
      await run(tools.browserCurrentUrl, {}, ctx)
      const res = await run(tools.browserSnapshot, {}, ctx)
      expect(res.isError).toBe(true)
      expect(String(res.data)).toContain('safety cap')
    })

    it('caps per-session wall clock', async () => {
      let t = 1_000_000
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud: fakeProvider('cloud'),
        fuse: { maxWallMsPerSession: 60_000 },
        now: () => t,
      })
      const ctx = toolContext()
      await run(tools.browserSnapshot, {}, ctx)
      t += 61_000
      const res = await run(tools.browserCurrentUrl, {}, ctx)
      expect(res.isError).toBe(true)
      expect(String(res.data)).toContain('wall-clock')
    })

    it('the fuse is EPISODE-scoped: an idle gap resets both caps instead of bricking the session forever', async () => {
      let t = 1_000_000
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud: fakeProvider('cloud'),
        fuse: { maxCallsPerSession: 2, maxWallMsPerSession: 60_000, idleResetMs: 120_000 },
        now: () => t,
      })
      const ctx = toolContext()
      await run(tools.browserSnapshot, {}, ctx)
      await run(tools.browserCurrentUrl, {}, ctx)
      // Call cap hit — the stretch is fused.
      const fused = await run(tools.browserSnapshot, {}, ctx)
      expect(fused.isError).toBe(true)
      // The user walks away; a later stretch browses again.
      t += 121_000
      const revived = await run(tools.browserSnapshot, {}, ctx)
      expect(revived.isError ?? false).toBe(false)
      // And the wall clock restarted with the new episode, not the old one.
      t += 59_000
      const withinWall = await run(tools.browserCurrentUrl, {}, ctx)
      expect(withinWall.isError ?? false).toBe(false)
    })
  })

  describe('captcha posture (§5): one attempt, then hand the human the live view', () => {
    function captchaProvider(kind: 'local' | 'cloud'): BrowserProvider & { calls: string[] } {
      const provider = fakeProvider(kind)
      provider.snapshot = async () => {
        provider.calls.push('snapshot')
        return {
          url: 'https://www.google.com/sorry/index',
          title: 'Unusual traffic',
          nodes: [{ ref: '@e1', role: 'checkbox', name: "I'm not a robot" }],
        }
      }
      return provider
    }

    it('first sighting: advises ONE attempt and carries the take-over link', async () => {
      const cloud = captchaProvider('cloud')
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud,
        cloudAvailable: () => true,
        takeoverLinkFor: () => 'https://app.test/w/ws-1/computer/sess-1',
      })
      const res = await run(tools.browserNavigate, { url: 'https://www.google.com/search?q=x' })
      expect(String(res.data)).toContain('human-verification challenge')
      expect(String(res.data)).toContain('ONCE')
      expect(String(res.data)).toContain('https://app.test/w/ws-1/computer/sess-1')
    })

    it('second consecutive sighting: STOP + hand off, and the sandbox pauses for the take-over wait', async () => {
      let paused = 0
      const cloud = captchaProvider('cloud')
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud,
        cloudAvailable: () => true,
        takeoverLinkFor: () => 'https://app.test/w/ws-1/computer/sess-1',
        onCloudLoginWall: async () => {
          paused += 1
        },
      })
      const ctx = toolContext()
      await run(tools.browserNavigate, { url: 'https://www.google.com/search?q=x' }, ctx)
      const second = await run(tools.browserSnapshot, {}, ctx)
      expect(String(second.data)).toContain('STOP')
      expect(String(second.data)).toContain('https://app.test/w/ws-1/computer/sess-1')
      expect(paused).toBe(1)
    })

    it('a LATE login wall (several clicks after navigate) carries the take-over link and pauses', async () => {
      let paused = 0
      const cloud = fakeProvider('cloud')
      cloud.snapshot = async () => {
        cloud.calls.push('snapshot')
        return {
          url: 'https://www.linkedin.com/login?redirect=x',
          title: 'Sign in',
          nodes: [{ ref: '@e1', role: 'textbox', name: 'Email' }],
        }
      }
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud,
        cloudAvailable: () => true,
        takeoverLinkFor: () => 'https://app.test/w/ws-1/computer/sess-1',
        onCloudLoginWall: async () => {
          paused += 1
        },
      })
      const ctx = toolContext()
      const res = await run(tools.browserSnapshot, {}, ctx)
      expect(String(res.data)).toContain('asking for a login')
      expect(String(res.data)).toContain('https://app.test/w/ws-1/computer/sess-1')
      expect(paused).toBe(1)
    })

    it('a DataDome device-check interstitial (original URL, site title, challenge iframe only) is detected', async () => {
      // Klook 2026-07-19: DataDome serves the challenge at the ORIGINAL url
      // with the site's own title — only the iframe's accessible name gives
      // it away. The old node pattern missed it, so the model silently gave
      // up on the site instead of offering the take-over link.
      const cloud = fakeProvider('cloud')
      cloud.snapshot = async () => {
        cloud.calls.push('snapshot')
        return {
          url: 'https://www.klook.com/zh-HK/activity/103233?package_id=351986',
          title: 'klook.com',
          nodes: [
            { ref: '@e1', role: 'Iframe', name: 'DataDome Device Check' },
            { ref: '@e2', role: 'button', name: 'Contact us' },
          ],
        }
      }
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud,
        cloudAvailable: () => true,
        takeoverLinkFor: () => 'https://app.test/w/ws-1/computer/sess-1',
      })
      const res = await run(tools.browserNavigate, { url: 'https://s.klook.com/c/V1Molp7O30' })
      expect(String(res.data)).toContain('human-verification challenge')
      expect(String(res.data)).toContain('https://app.test/w/ws-1/computer/sess-1')
    })

    it('a captcha-free snapshot resets the counter', async () => {
      const cloud = captchaProvider('cloud')
      const clean = fakeProvider('cloud')
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud,
        cloudAvailable: () => true,
        takeoverLinkFor: () => 'https://app.test/live',
      })
      const ctx = toolContext()
      await run(tools.browserNavigate, { url: 'https://www.google.com/search?q=x' }, ctx)
      // The challenge clears (user solved it / page moved on).
      cloud.snapshot = clean.snapshot
      const ok = await run(tools.browserSnapshot, {}, ctx)
      expect(String(ok.data)).not.toContain('human-verification')
      // A later challenge starts at "try once" again, not at "STOP".
      cloud.snapshot = captchaProvider('cloud').snapshot
      const again = await run(tools.browserSnapshot, {}, ctx)
      expect(String(again.data)).toContain('ONCE')
      expect(String(again.data)).not.toContain('STOP')
    })
  })

  describe('L1/L2 policy hook', () => {
    it('block policy refuses execution with a pointer to the settings surface', async () => {
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud: fakeProvider('cloud'),
        resolvePolicy: async () => 'block',
      })
      const res = await run(tools.browserNavigate, { url: 'https://example.com/' })
      expect(res.isError).toBe(true)
      expect(String(res.data)).toContain('blocked by tool policy')
    })

    it('ask policy forces confirmation on any browser tool', async () => {
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud: fakeProvider('cloud'),
        resolvePolicy: async () => 'ask',
      })
      expect(await tools.browserType.resolveConfirmation!(toolContext(), { ref: '@e1', text: 'x' })).toBe(true)
    })
  })

  it('rejects non-http(s) URLs before touching any backend', async () => {
    const local = fakeProvider('local')
    const tools = createComputerTools({ local, cloud: fakeProvider('cloud') })
    const res = await run(tools.browserNavigate, { url: 'file:///etc/passwd' })
    expect(res.isError).toBe(true)
    expect(local.calls).toEqual([])
  })

  it('audits every action as a metadata-only event (op + backend + host, no content)', async () => {
    const events: Array<Record<string, unknown>> = []
    const tools = createComputerTools({
      local: fakeProvider('local'),
      cloud: fakeProvider('cloud'),
      onEvent: (evt) => void events.push(evt as unknown as Record<string, unknown>),
    })
    const ctx = toolContext()
    await run(tools.browserNavigate, { url: 'https://www.linkedin.com/messaging/' }, ctx)
    await run(tools.browserSnapshot, {}, ctx)
    await run(tools.browserType, { ref: '@e1', text: 'SECRET DRAFT' }, ctx)
    // Navigate's inline snapshot audits too — auto never means invisible.
    expect(events.map((e) => e.op)).toEqual(['navigate', 'snapshot', 'snapshot', 'type'])
    expect(events[0]).toMatchObject({ op: 'navigate', backend: 'local', host: 'www.linkedin.com', ok: true })
    // No event ever carries typed text or page content.
    expect(JSON.stringify(events)).not.toContain('SECRET DRAFT')
  })
})
