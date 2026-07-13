import { describe, it, expect } from 'vitest'
import { createComputeTools, type SandboxFilesPort } from '../compute-tools.js'
import { createSandboxOrchestrator, createInMemorySandboxTaskStore } from '../orchestrator.js'
import { StubSandboxProvider } from '../providers/stub.js'
import type { Tool, ToolContext } from '../../tools/types.js'

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

/** Files port faking per-workspace storage — the RLS stand-in. */
function fakeFilesPort(): SandboxFilesPort & {
  store: Map<string, Map<string, Uint8Array>>
  writes: Array<{ workspaceId: string; path: string; bytes: Uint8Array }>
} {
  const store = new Map<string, Map<string, Uint8Array>>()
  const writes: Array<{ workspaceId: string; path: string; bytes: Uint8Array }> = []
  return {
    store,
    writes,
    async readBytes(ctx, fileIdOrPath) {
      const bytes = store.get(ctx.workspaceId)?.get(fileIdOrPath)
      return bytes ? { bytes, name: fileIdOrPath } : null
    },
    async writeBytes(ctx, params) {
      writes.push({ workspaceId: ctx.workspaceId, path: params.path, bytes: params.bytes })
      return { fileId: `file-${writes.length}`, path: params.path }
    },
  }
}

function build(opts: { plan?: string; files?: SandboxFilesPort | null } = {}) {
  const provider = new StubSandboxProvider()
  const taskStore = createInMemorySandboxTaskStore()
  const orchestrator = createSandboxOrchestrator({ provider, taskStore })
  const files = opts.files === undefined ? fakeFilesPort() : opts.files
  const tools = createComputeTools({
    provider,
    binding: orchestrator.binding,
    files,
    getWorkspacePlan: async () => opts.plan ?? 'pro',
  })
  return { provider, tools, files }
}

async function run(tool: Tool, input: Record<string, unknown>, ctx = toolContext()) {
  return tool.execute(tool.inputSchema.parse(input), ctx)
}

describe('[COMP:sandbox/python-exec] runPython — isolated compute (§4.7)', () => {
  it('runs computation and reports stdout/exit code', async () => {
    const provider = new StubSandboxProvider({ pythonResults: [{ stdout: '42\n', stderr: '', exitCode: 0 }] })
    const orchestrator = createSandboxOrchestrator({ provider, taskStore: createInMemorySandboxTaskStore() })
    const tools = createComputeTools({
      provider,
      binding: orchestrator.binding,
      files: null,
      getWorkspacePlan: async () => 'pro',
    })
    const res = await run(tools.runPython, { code: 'print(6*7)' })
    expect(res.isError).toBeFalsy()
    expect(String(res.data)).toContain('42')
  })

  it('is egress-denied: opening a socket fails as network-unreachable', async () => {
    const { tools } = build()
    const res = await run(tools.runPython, { code: 'import socket; socket.socket().connect(("1.1.1.1", 443))' })
    expect(res.isError).toBe(true)
    expect(String(res.data)).toMatch(/Network is unreachable|egress denied/i)
  })

  it('passes the provider ONLY code + timeout — no browser handle, no tool surface in scope (§4.13)', async () => {
    const { provider, tools } = build()
    await run(tools.runPython, { code: 'print(1)' })
    const [sbx] = [...provider.sandboxes.values()]
    expect(sbx.pythonRuns).toHaveLength(1)
    expect(Object.keys(sbx.pythonRuns[0]).sort()).toEqual(['code', 'timeoutMs'])
  })

  it('is default-on for paid plans and OFF for free (§4.7 C2)', async () => {
    const paid = build({ plan: 'pro' })
    expect((await run(paid.tools.runPython, { code: 'print(1)' })).isError).toBeFalsy()

    const free = build({ plan: 'free' })
    const res = await run(free.tools.runPython, { code: 'print(1)' })
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('paid plans')
  })

  it('hard-blocks on autonomous paths when unattended computer-use is off (Barrier 2)', async () => {
    const { tools, provider } = build()
    const res = await run(tools.runPython, { code: 'print(1)' }, toolContext({ channelType: 'workflow' }))
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('autonomous')
    expect(provider.sandboxes.size).toBe(0)
  })
})

describe('[COMP:sandbox/file-bridge] loadFromWorkspace / saveToWorkspace (§4.12)', () => {
  it('round-trips: load a workspace file into scratch, python transforms, save the artifact back', async () => {
    const files = fakeFilesPort()
    files.store.set('ws-1', new Map([['deals.csv', new TextEncoder().encode('a,b\n1,2')]]))
    const { provider, tools } = build({ files })

    const loaded = await run(tools.loadFromWorkspace, { file: 'deals.csv' })
    expect(loaded.isError).toBeUndefined()
    expect(String(loaded.data)).toContain('deals.csv')

    const [sbx] = [...provider.sandboxes.values()]
    // Simulate a python-produced artifact in the shared scratch.
    sbx.scratch.set('out.json', new TextEncoder().encode('{"sum":3}'))

    const saved = await run(tools.saveToWorkspace, { path: 'out.json', title: 'Deal sums' })
    expect(saved.isError).toBeUndefined()
    expect(files.writes).toHaveLength(1)
    expect(files.writes[0].workspaceId).toBe('ws-1')
    expect(files.writes[0].path).toMatch(/^computer\/artifacts\//)
    expect(new TextDecoder().decode(files.writes[0].bytes)).toBe('{"sum":3}')
  })

  it('is workspace-scoped by construction: a workspace-W task cannot load workspace-V files (§4.12)', async () => {
    const files = fakeFilesPort()
    files.store.set('ws-OTHER', new Map([['secrets.csv', new TextEncoder().encode('leak')]]))
    const { tools } = build({ files })

    // The tool has NO workspace parameter for the model to supply…
    expect(Object.keys((tools.loadFromWorkspace.inputSchema as unknown as { shape: Record<string, unknown> }).shape)).toEqual(['file'])
    // …and identity comes from the ToolContext, so ws-1 simply cannot see it.
    const res = await run(tools.loadFromWorkspace, { file: 'secrets.csv' }, toolContext({ workspaceId: 'ws-1' }))
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('No workspace file')
  })

  it('saveToWorkspace keeps its confirm-by-default when no policy resolver is wired', async () => {
    const { tools } = build()
    expect(await tools.saveToWorkspace.resolveConfirmation!(toolContext(), { path: 'x' })).toBe(true)
  })

  it('reports honestly when file storage is not configured', async () => {
    const { tools } = build({ files: null })
    const res = await run(tools.loadFromWorkspace, { file: 'x.csv' })
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('not configured')
  })
})
