import { describe, expect, it } from 'vitest'
import { createComputerTools } from '../tools.js'
import type { BrowserProvider, BrowserSnapshot } from '../types.js'
import type { Tool, ToolContext } from '../../tools/types.js'

function fixture() {
  let scan = 0
  const actions: string[] = []
  let documentId: string | undefined = 'document-1'
  let nodeIdentity = true
  let replacement = false
  const snapshot = (): BrowserSnapshot => ({
    documentId,
    url: 'https://example.com', title: 'Mail',
    nodes: [
      { nodeId: nodeIdentity ? (replacement ? 'replacement-email' : 'email') : undefined, ref: `provider-${scan}-email`, role: 'textbox', name: 'Email', value: scan > 1 ? 'updated' : '' },
      { nodeId: nodeIdentity ? 'send' : undefined, ref: `provider-${scan}-send`, role: 'button', name: 'Send' },
    ],
  })
  const provider: BrowserProvider = {
    kind: 'cloud',
    async navigate(_ctx, url) { return { url } },
    async snapshot() { ++scan; return snapshot() },
    async click(_ctx, ref) { actions.push(`click:${ref}`) },
    async type(_ctx, ref) { actions.push(`type:${ref}`) },
    async currentUrl() { return { url: snapshot().url, title: snapshot().title } },
    async stop() {},
  }
  const context: ToolContext = {
    userId: 'u', assistantId: 'a', sessionId: 's', appId: 'app', channelType: 'web',
    channelId: 'c', workspaceId: 'w', abortSignal: new AbortController().signal,
  }
  const tools = createComputerTools({ local: provider, cloud: provider, cloudAvailable: () => true })
  const run = (tool: Tool, input: Record<string, unknown> = {}) => tool.execute(tool.inputSchema.parse(input), context)
  return {
    tools, run, actions,
    setDocument: (id: string | undefined) => { documentId = id },
    omitNodeIds: () => { nodeIdentity = false },
    replaceEmail: () => { replacement = true },
  }
}

describe('snapshot observation tool integration', () => {
  it('returns a delta after click and remaps both click and type to current provider refs', async () => {
    const { tools, run, actions } = fixture()
    expect((await run(tools.browserNavigate, { url: 'https://example.com' })).data).toContain('v1 full')
    const clicked = await run(tools.browserClick, { ref: '@e2', observation: 'diff' })
    expect(clicked.data).toContain('v2 diff from v1')
    expect(clicked.data).toContain('~ [0] @e1 textbox "Email" value="updated"')
    expect(clicked.data).not.toMatch(/nodeId|documentId|document-1|provider-/)
    await run(tools.browserType, { ref: '@e1', text: 'hello' })
    await run(tools.browserClick, { ref: '@e2', observation: 'diff' })
    expect(actions).toEqual(['click:provider-1-send', 'type:provider-2-email', 'click:provider-2-send'])
    expect(tools.getSessionTrace('s').at(-1)?.action).toBe('submit')
    // Match the inline full-mode scope so the unchanged view can remain a delta.
    const unchanged = await run(tools.browserSnapshot, { mode: 'full' })
    expect(unchanged.data).toContain('diff from v3')
    expect(unchanged.data).toContain('No changes.')
  })

  it.each(['document', 'node'] as const)('returns full without %s identity and rejects refs from earlier scans', async kind => {
    const f = fixture()
    if (kind === 'document') f.setDocument(undefined)
    else f.omitNodeIds()
    await f.run(f.tools.browserSnapshot)
    const clicked = await f.run(f.tools.browserClick, { ref: '@e2', observation: 'diff' })
    expect(clicked.data).toContain('v2 full')
    expect((await f.run(f.tools.browserType, { ref: '@e1', text: 'no' })).isError).toBe(true)
    expect((await f.run(f.tools.browserClick, { ref: '@e2' })).isError).toBe(true)
    expect(f.actions).toEqual(['click:provider-1-send'])
  })

  it('invalidates refs for same-URL new documents and for replaced same-name DOM nodes', async () => {
    const f = fixture()
    await f.run(f.tools.browserSnapshot)
    f.replaceEmail()
    const replaced = await f.run(f.tools.browserSnapshot, { observation: 'diff' })
    expect(replaced.data).toContain('- [0] @e1 textbox "Email"')
    expect(replaced.data).toContain('+ [0] @e3 textbox "Email"')
    expect((await f.run(f.tools.browserType, { ref: '@e1', text: 'no' })).isError).toBe(true)
    await f.run(f.tools.browserType, { ref: '@e3', text: 'yes' })
    f.setDocument('document-2')
    expect((await f.run(f.tools.browserSnapshot, { observation: 'diff' })).data).toContain('v3 full')
    expect((await f.run(f.tools.browserClick, { ref: '@e2' })).isError).toBe(true)
    expect((await f.run(f.tools.browserType, { ref: '@e3', text: 'no' })).isError).toBe(true)
    expect(f.actions).toEqual(['type:provider-2-email'])
  })

  it('rejects guessed refs outside the returned page and expires the earlier page', async () => {
    const f = fixture()
    const first = await f.run(f.tools.browserSnapshot, { limit: 1 })
    expect(first.data).toContain('@e1 textbox')
    expect(first.data).not.toContain('@e2')
    expect((await f.run(f.tools.browserClick, { ref: '@e2' })).isError).toBe(true)
    const next = await f.run(f.tools.browserSnapshot, { offset: 1, limit: 1 })
    expect(next.data).toContain('@e4 button')
    expect((await f.run(f.tools.browserType, { ref: '@e1', text: 'no' })).isError).toBe(true)
    expect((await f.run(f.tools.browserType, { ref: '@e3', text: 'no' })).isError).toBe(true)
    await f.run(f.tools.browserClick, { ref: '@e4' })
    expect(f.actions).toEqual(['click:provider-2-send'])
  })

  it('invalidates refs on navigation and backend changes', async () => {
    const f = fixture()
    await f.run(f.tools.browserSnapshot)
    await f.run(f.tools.browserNavigate, { url: 'https://example.com' })
    expect((await f.run(f.tools.browserClick, { ref: '@e2' })).isError).toBe(true)
    f.tools.setSessionBackendOverride('s', 'local')
    expect((await f.run(f.tools.browserType, { ref: '@e3', text: 'no' })).isError).toBe(true)
    expect(f.actions).toEqual([])
  })
})
