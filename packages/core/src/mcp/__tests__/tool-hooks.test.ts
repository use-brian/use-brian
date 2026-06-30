import { describe, it, expect, vi } from 'vitest'
import { buildToolIndex, createMcpSearchTools } from '../tool-search.js'
import type { McpSettingsStore, McpServerConfig } from '../types.js'
import type { EngineHooks } from '../../engine/hooks.js'

// Read-classified tool (`get_*`) → default policy `allow` → no confirmation
// gate, so the dispatch reaches the preflight hook + callMcpTool directly.
const server: McpServerConfig = {
  name: 'cgov',
  url: 'https://cgov.example.com/mcp',
  tools: [
    { name: 'get_drep_profile', description: 'Get detailed profile of a DRep', inputSchema: { type: 'object', properties: { drep_id: { type: 'string' } }, required: ['drep_id'] } },
  ],
}

const ctx = {
  assistantId: 'a1',
  userId: 'u1',
  sessionId: 's1',
  workspaceId: 'w1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c_1',
  abortSignal: new AbortController().signal,
}

const settingsStore: McpSettingsStore = {
  async getPolicy() { return null },
  async setPolicy() {},
  async recordUsage() {},
  async recordUsageAndGetCount() { return { timesAllowed: 0, timesDenied: 0 } },
}

function makeCallTool(hooks?: EngineHooks) {
  // Typed signature (not a bare `vi.fn`) so `mock.calls[0]` is a 4-tuple and
  // the arg-count / 4th-arg assertions below typecheck.
  const callMcpTool = vi.fn(
    async (_serverUrl: string, _toolName: string, _input: Record<string, unknown>, _overrides?: Record<string, string>) => ({ ok: true }),
  )
  const index = buildToolIndex([
    { kind: 'remote', server, serverUrl: server.url, callMcpTool },
  ])
  const tools = createMcpSearchTools({
    index,
    settingsStore,
    assistantId: 'a1',
    userId: 'u1',
    callMcpTool,
    hooks,
  })
  // tools[1] is mcp_call
  return { callTool: tools[1], callMcpTool }
}

function invoke(callTool: ReturnType<typeof makeCallTool>['callTool'], args: Record<string, unknown> = { drep_id: 'drep1abc' }) {
  return callTool.execute({ server: 'cgov', tool: 'get_drep_profile', args }, ctx)
}

describe('[COMP:engine/tool-hooks] preToolUse', () => {
  it('no hook → callMcpTool fires with exactly 3 args (byte-for-byte unchanged)', async () => {
    const { callTool, callMcpTool } = makeCallTool(undefined)
    const result = await invoke(callTool)
    expect(result.isError).toBeFalsy()
    expect(callMcpTool).toHaveBeenCalledTimes(1)
    // The no-hook path must NOT thread a 4th arg.
    expect(callMcpTool.mock.calls[0]).toHaveLength(3)
    expect(callMcpTool.mock.calls[0]).toEqual([
      'https://cgov.example.com/mcp',
      'get_drep_profile',
      { drep_id: 'drep1abc' },
    ])
  })

  it('returning void / continue leaves the call a 3-arg call', async () => {
    const { callTool, callMcpTool } = makeCallTool({ preToolUse: () => undefined })
    await invoke(callTool)
    expect(callMcpTool.mock.calls[0]).toHaveLength(3)

    const cont = makeCallTool({ preToolUse: () => ({ action: 'continue' }) })
    await invoke(cont.callTool)
    expect(cont.callMcpTool.mock.calls[0]).toHaveLength(3)
  })

  it('modify.headers → override threads through as the 4th arg', async () => {
    const preToolUse = vi.fn(() => ({ action: 'modify' as const, headers: { 'X-Tenant': 'acme' } }))
    const { callTool, callMcpTool } = makeCallTool({ preToolUse })
    await invoke(callTool)
    expect(callMcpTool.mock.calls[0]).toHaveLength(4)
    expect(callMcpTool.mock.calls[0][3]).toEqual({ 'X-Tenant': 'acme' })
    // The hook saw the full remote-MCP context.
    expect(preToolUse).toHaveBeenCalledWith(expect.objectContaining({
      source: 'remote_mcp',
      serverUrl: 'https://cgov.example.com/mcp',
      serverName: 'cgov',
      toolName: 'get_drep_profile',
      userId: 'u1',
      assistantId: 'a1',
      sessionId: 's1',
      workspaceId: 'w1',
      input: { drep_id: 'drep1abc' },
    }))
  })

  it('modify.input → rewritten args reach callMcpTool', async () => {
    const { callTool, callMcpTool } = makeCallTool({
      preToolUse: () => ({ action: 'modify', input: { drep_id: 'rewritten' } }),
    })
    await invoke(callTool)
    expect(callMcpTool.mock.calls[0][2]).toEqual({ drep_id: 'rewritten' })
  })

  it('block → callMcpTool never fires, model gets the reason', async () => {
    const { callTool, callMcpTool } = makeCallTool({
      preToolUse: () => ({ action: 'block', reason: 'tenant suspended' }),
    })
    const result = await invoke(callTool)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('blocked by a preflight hook')
    expect(String(result.data)).toContain('tenant suspended')
    expect(callMcpTool).not.toHaveBeenCalled()
  })

  it('preToolUse throwing is fail-closed — call skipped, error surfaced', async () => {
    const { callTool, callMcpTool } = makeCallTool({
      preToolUse: () => { throw new Error('hook bug') },
    })
    const result = await invoke(callTool)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('preflight hook errored')
    expect(callMcpTool).not.toHaveBeenCalled()
  })
})

describe('[COMP:engine/tool-hooks] postToolUse', () => {
  it('observes the result, identity, and elapsed time', async () => {
    const postToolUse = vi.fn()
    const { callTool } = makeCallTool({ postToolUse })
    await invoke(callTool)
    expect(postToolUse).toHaveBeenCalledTimes(1)
    const observed = postToolUse.mock.calls[0][0]
    expect(observed).toMatchObject({
      source: 'remote_mcp',
      serverName: 'cgov',
      toolName: 'get_drep_profile',
      input: { drep_id: 'drep1abc' },
      result: { data: { ok: true }, isError: false },
    })
    expect(typeof observed.elapsedMs).toBe('number')
    expect(observed.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('sees the post-modify input when preToolUse rewrote args', async () => {
    const postToolUse = vi.fn()
    const { callTool } = makeCallTool({
      preToolUse: () => ({ action: 'modify', input: { drep_id: 'rewritten' } }),
      postToolUse,
    })
    await invoke(callTool)
    expect(postToolUse.mock.calls[0][0].input).toEqual({ drep_id: 'rewritten' })
  })

  it('a throwing postToolUse is swallowed — the successful call still returns', async () => {
    const { callTool, callMcpTool } = makeCallTool({
      postToolUse: () => { throw new Error('observer bug') },
    })
    const result = await invoke(callTool)
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({ ok: true })
    expect(callMcpTool).toHaveBeenCalledTimes(1)
  })
})
