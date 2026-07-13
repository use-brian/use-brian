import { describe, it, expect } from 'vitest'
import { createE2bCloudProvider, SCRATCH_DIR } from '../providers/e2b/index.js'
import { parseSnapshotOutput, cli } from '../providers/e2b/agent-browser-cli.js'
import type { E2bCommandResult, E2bRuntime, E2bSandboxHandle } from '../providers/e2b/runtime.js'

/**
 * Fake E2bRuntime — records every command/file op so tests assert the
 * provider's CONTRACTS (unshare-wrapped python, no ambient env, agent-browser
 * verbs) without a real E2B key. The real-runtime path is integration-gated.
 */
function fakeRuntime(respond?: (cmd: string) => E2bCommandResult | undefined) {
  const commands: Array<{ sandboxId: string; cmd: string; envs?: Record<string, string> }> = []
  const files = new Map<string, Uint8Array>()
  const created: Array<Record<string, unknown>> = []
  let counter = 0

  function handle(id: string): E2bSandboxHandle {
    return {
      id,
      async runCommand(cmd, opts) {
        commands.push({ sandboxId: id, cmd, envs: opts?.envs })
        return respond?.(cmd) ?? { stdout: '', stderr: '', exitCode: 0 }
      },
      async writeFile(path, bytes) {
        files.set(path, bytes)
      },
      async readFile(path) {
        const bytes = files.get(path)
        if (!bytes) throw new Error(`no file ${path}`)
        return bytes
      },
      async listDir(path) {
        return [...files.keys()]
          .filter((p) => p.startsWith(`${path}/`))
          .map((p) => ({ name: p.slice(path.length + 1), path: p, isDir: false }))
      },
      async pause() {},
      async kill() {},
    }
  }

  const runtime: E2bRuntime = {
    async create(opts) {
      created.push(opts as Record<string, unknown>)
      return handle(`e2b-${++counter}`)
    },
    async connect(sandboxId) {
      return handle(sandboxId)
    },
  }
  return { runtime, commands, files, created }
}

describe('[COMP:sandbox/e2b-cloud] E2BCloudProvider', () => {
  it('creates sandboxes with task metadata and NO ambient secrets (no envs forwarded)', async () => {
    const { runtime, created } = fakeRuntime()
    const provider = createE2bCloudProvider(runtime, { templateId: 'sidanclaw-computer' })
    await provider.create({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      region: 'asia-east1',
      egressAllowlist: ['api.example.com'],
      maxLifetimeSeconds: 1800,
    })
    expect(created[0]).toMatchObject({
      templateId: 'sidanclaw-computer',
      timeoutMs: 1800 * 1000,
      metadata: {
        workspaceId: 'ws-1',
        taskId: 'task-1',
        region: 'asia-east1',
        egressAllowlist: 'api.example.com',
      },
    })
    // The no-ambient-secrets invariant (§8): create carries no env map at all.
    expect('envs' in (created[0] as object)).toBe(false)
  })

  it('drives browsing through agent-browser verbs, never raw model bash (§4.11)', async () => {
    const { runtime, commands } = fakeRuntime((cmd) => {
      if (cmd === cli.getUrl()) return { stdout: 'https://news.ycombinator.com/\n', stderr: '', exitCode: 0 }
      if (cmd === cli.getTitle()) return { stdout: 'Hacker News\n', stderr: '', exitCode: 0 }
      if (cmd === cli.snapshot()) {
        return { stdout: '@e1 link "Front page"\n@e2 button "More"\n', stderr: '', exitCode: 0 }
      }
      return undefined
    })
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    const browser = provider.browser(sandboxId)

    await browser.navigate('https://news.ycombinator.com/')
    const snap = await browser.snapshot()
    await browser.click('@e1')
    await browser.type('@e2', 'hello')

    const cmds = commands.map((c) => c.cmd)
    expect(cmds).toContain(cli.open('https://news.ycombinator.com/'))
    expect(cmds).toContain(cli.click('@e1'))
    expect(cmds).toContain(cli.fill('@e2', 'hello'))
    expect(snap.nodes).toEqual([
      { ref: '@e1', role: 'link', name: 'Front page' },
      { ref: '@e2', role: 'button', name: 'More' },
    ])
    // Every browser command runs under the per-sandbox session identity.
    expect(commands.every((c) => c.envs?.AGENT_BROWSER_SESSION_NAME === `sbx-${sandboxId}`)).toBe(true)
  })

  it('appends the dormant BYOP proxy flag to open only when a proxy is configured (§4.6)', async () => {
    const { runtime, commands } = fakeRuntime((cmd) =>
      cmd === cli.getUrl() ? { stdout: 'https://x.test/', stderr: '', exitCode: 0 } : undefined,
    )
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({
      workspaceId: 'w',
      taskId: 't',
      proxyUrl: 'http://proxy.example:8080',
    })
    await provider.browser(sandboxId).navigate('https://x.test/')
    expect(commands.some((c) => c.cmd.includes("-p 'http://proxy.example:8080'"))).toBe(true)
  })

  it('runPython always wraps in an unshared network namespace + isolated mode (§4.7)', async () => {
    const { runtime, commands, files } = fakeRuntime((cmd) => {
      if (cmd === 'command -v unshare') return { stdout: '/usr/bin/unshare\n', stderr: '', exitCode: 0 }
      if (cmd.includes('unshare -rn python3 -I')) {
        return { stdout: '42\n', stderr: '', exitCode: 0 }
      }
      return undefined
    })
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    const result = await provider.runPython(sandboxId, { code: 'print(6*7)' })

    expect(result).toEqual({ stdout: '42\n', stderr: '', exitCode: 0 })
    const exec = commands.find((c) => c.cmd.includes('python3'))
    expect(exec?.cmd).toMatch(/unshare -rn python3 -I/)
    // The code travelled as a scratch file, not shell-interpolated.
    const written = [...files.keys()].find((p) => p.startsWith(`${SCRATCH_DIR}/.exec-`))
    expect(written).toBeTruthy()
    expect(new TextDecoder().decode(files.get(written as string))).toBe('print(6*7)')
  })

  it('refuses to run python at all when the template lacks unshare (fail-closed egress contract)', async () => {
    const { runtime } = fakeRuntime((cmd) =>
      cmd === 'command -v unshare' ? { stdout: '', stderr: '', exitCode: 1 } : undefined,
    )
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    await expect(provider.runPython(sandboxId, { code: 'print(1)' })).rejects.toThrow(/egress-denied|isolation/i)
  })

  it('bridge round-trips scratch bytes and pulls the downloads dir', async () => {
    const { runtime } = fakeRuntime()
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })

    await provider.bridge.load(sandboxId, { path: 'input.csv', bytes: new TextEncoder().encode('a,b') })
    const back = await provider.bridge.save(sandboxId, { path: 'input.csv' })
    expect(new TextDecoder().decode(back.bytes)).toBe('a,b')

    await provider.bridge.load(sandboxId, {
      path: '/home/user/downloads/out.pdf',
      bytes: new TextEncoder().encode('%PDF'),
    })
    const downloads = await provider.bridge.pullDownloads(sandboxId)
    expect(downloads.map((d) => d.path)).toEqual(['/home/user/downloads/out.pdf'])
  })

  it('injects auth state via AGENT_BROWSER_STATE only after writing it, captures via state save', async () => {
    const { runtime, commands, files } = fakeRuntime((cmd) =>
      cmd === cli.getUrl() ? { stdout: 'https://x.test/', stderr: '', exitCode: 0 } : undefined,
    )
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    const browser = provider.browser(sandboxId)

    // Before an inject, no AGENT_BROWSER_STATE — the daemon hard-fails its
    // launch on a missing state file (validated in-sandbox 2026-07-13).
    await browser.navigate('https://x.test/')
    expect(commands.every((c) => !c.envs?.AGENT_BROWSER_STATE)).toBe(true)

    await browser.injectStorageState({
      site: 'x.test',
      cookies: [{ name: 'sc', value: '1' }],
      localStorage: { 'https://x.test': { k: 'v' } },
      capturedAt: '2026-07-13T00:00:00Z',
    })
    const injectPath = `/home/user/.agent-browser/inject-sbx-${sandboxId}.json`
    const state = JSON.parse(new TextDecoder().decode(files.get(injectPath) as Uint8Array)) as {
      cookies: unknown
      origins: unknown
    }
    expect(state.cookies).toEqual([{ name: 'sc', value: '1' }])
    expect(state.origins).toEqual([{ origin: 'https://x.test', localStorage: [{ name: 'k', value: 'v' }] }])
    // Any daemon predating the state file is dropped so the next command
    // relaunches with the injected auth.
    expect(commands.some((c) => c.cmd === 'agent-browser close --all')).toBe(true)

    await browser.navigate('https://x.test/')
    expect(commands[commands.length - 1]?.envs?.AGENT_BROWSER_STATE).toBe(injectPath)

    const capturePath = `/home/user/.agent-browser/capture-sbx-${sandboxId}.json`
    files.set(capturePath, new TextEncoder().encode(JSON.stringify({ cookies: [{ name: 'sc', value: '2' }], origins: [] })))
    const bundle = await browser.captureStorageState('x.test')
    expect(commands.some((c) => c.cmd === cli.stateSave(capturePath))).toBe(true)
    expect(bundle.cookies).toEqual([{ name: 'sc', value: '2' }])
  })

  it('maps agent-browser failures to stale_ref vs backend_error', async () => {
    const { runtime } = fakeRuntime((cmd) => {
      if (cmd === cli.click('@e9')) {
        return { stdout: '', stderr: 'Error: no element with ref @e9 (stale snapshot)', exitCode: 1 }
      }
      if (cmd === cli.click('@e1')) return { stdout: '', stderr: 'daemon crashed', exitCode: 1 }
      return undefined
    })
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    const browser = provider.browser(sandboxId)
    await expect(browser.click('@e9')).rejects.toMatchObject({ code: 'stale_ref' })
    await expect(browser.click('@e1')).rejects.toMatchObject({ code: 'backend_error' })
  })
})

describe('[COMP:sandbox/browser-driver] agent-browser snapshot parsing', () => {
  const page = { url: 'https://x.test/', title: 'X' }

  it('parses the text list shape', () => {
    const out = parseSnapshotOutput(
      `@e1 button "Send"\n- @e2 link "Jane \\"JD\\" Doe"\n@e3 textbox "Message" value="draft" [disabled]\nnoise line\n`,
      page,
    )
    expect(out.nodes).toEqual([
      { ref: '@e1', role: 'button', name: 'Send' },
      { ref: '@e2', role: 'link', name: 'Jane "JD" Doe' },
      { ref: '@e3', role: 'textbox', name: 'Message', value: 'draft', disabled: true },
    ])
  })

  it('parses the ariaSnapshot YAML the shipping CLI emits (role first, ref in brackets)', () => {
    // Verbatim from a real sandbox (agent-browser + Chrome 150, 2026-07-13).
    const out = parseSnapshotOutput(
      `- heading "Example Domain" [level=1, ref=e1]\n- link "Learn more" [ref=e2]\n- button "Save" [disabled, ref=e3]\n- textbox [ref=e4]\n`,
      page,
    )
    expect(out.nodes).toEqual([
      { ref: '@e1', role: 'heading', name: 'Example Domain' },
      { ref: '@e2', role: 'link', name: 'Learn more' },
      { ref: '@e3', role: 'button', name: 'Save', disabled: true },
      { ref: '@e4', role: 'textbox', name: '' },
    ])
  })

  it('parses the JSON shape (nodes or elements, bare or @-prefixed refs)', () => {
    const out = parseSnapshotOutput(
      JSON.stringify({ elements: [{ ref: 'e1', role: 'button', label: 'Send', disabled: true }] }),
      page,
    )
    expect(out.nodes).toEqual([{ ref: '@e1', role: 'button', name: 'Send', disabled: true }])
  })

  it('never throws on garbage output', () => {
    expect(parseSnapshotOutput('', page).nodes).toEqual([])
    expect(parseSnapshotOutput('{broken json', page).nodes).toEqual([])
  })
})
