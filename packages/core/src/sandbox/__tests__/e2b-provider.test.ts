import { describe, it, expect } from 'vitest'
import { createE2bCloudProvider, SCRATCH_DIR } from '../providers/e2b/index.js'
import { BU_DRIVER_PY, mapBrowserUseHistory } from '../providers/e2b/bu-driver.js'
import { parseSnapshotOutput, cli, PART_SEPARATOR, SANDBOX_SESSION_NAME } from '../providers/e2b/agent-browser-cli.js'
import {
  TAKEOVER_INPUT_HELPER_MJS,
  TAKEOVER_INPUT_HELPER_PATH,
} from '../providers/e2b/takeover-input.js'
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
      getHost(port) {
        return `${port}-${id}.e2b.test`
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
      // Multi-verb ops arrive CHAINED (one exec per op — the round-trip
      // economy); the fake answers with sentinel-separated parts.
      if (cmd.includes(cli.snapshot())) {
        return {
          stdout: `@e1 link "Front page"\n@e2 button "More"\n${PART_SEPARATOR}\nhttps://news.ycombinator.com/\n${PART_SEPARATOR}\nHacker News\n`,
          stderr: '',
          exitCode: 0,
        }
      }
      if (cmd.includes(cli.getUrl())) {
        return { stdout: `${PART_SEPARATOR}\nhttps://news.ycombinator.com/\n`, stderr: '', exitCode: 0 }
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
    expect(cmds.some((c) => c.includes(cli.open('https://news.ycombinator.com/')))).toBe(true)
    expect(cmds).toContain(cli.click('@e1'))
    expect(cmds).toContain(cli.fill('@e2', 'hello'))
    // One exec per op: navigate (open+get url) and snapshot (snap+url+title)
    // each ran as a single chained command.
    expect(cmds.filter((c) => c.includes('agent-browser')).length).toBe(4)
    expect(snap.url).toBe('https://news.ycombinator.com/')
    expect(snap.title).toBe('Hacker News')
    expect(snap.nodes).toEqual([
      { ref: '@e1', role: 'link', name: 'Front page' },
      { ref: '@e2', role: 'button', name: 'More' },
    ])
    // Every browser command runs under the FIXED session name — the one the
    // template snapshot pre-warmed a daemon for (a per-sandbox name would
    // orphan the warm Chromium and relaunch cold).
    expect(commands.every((c) => c.envs?.AGENT_BROWSER_SESSION_NAME === SANDBOX_SESSION_NAME)).toBe(true)
  })

  it('appends the dormant BYOP proxy flag to open only when a proxy is configured (§4.6)', async () => {
    const { runtime, commands } = fakeRuntime((cmd) =>
      cmd.includes(cli.getUrl())
        ? { stdout: `${PART_SEPARATOR}\nhttps://x.test/`, stderr: '', exitCode: 0 }
        : undefined,
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

  it('take-over input dispatches TRUSTED events through the CDP helper, never DOM synthesis (§4.8)', async () => {
    const { runtime, commands, files } = fakeRuntime((cmd) =>
      cmd === cli.getCdpUrl() ? { stdout: 'http://127.0.0.1:9222\n', stderr: '', exitCode: 0 } : undefined,
    )
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    const takeover = provider.browser(sandboxId).takeover()

    await takeover.input({ kind: 'click', x: 100, y: 200 })
    await takeover.input({ kind: 'key', text: 'Enter' })
    await takeover.input({ kind: 'scroll', deltaY: 120 })

    // The helper landed in the sandbox once and speaks raw CDP input.
    const helper = new TextDecoder().decode(files.get(TAKEOVER_INPUT_HELPER_PATH))
    expect(helper).toBe(TAKEOVER_INPUT_HELPER_MJS)
    expect(helper).toContain('Input.dispatchMouseEvent')
    expect(helper).toContain('Input.insertText')
    expect(helper).not.toContain('elementFromPoint')

    // One endpoint resolve serves all three dispatches (cached per sandbox).
    expect(commands.filter((c) => c.cmd === cli.getCdpUrl()).length).toBe(1)
    const dispatches = commands.filter((c) => c.cmd.startsWith(`node ${TAKEOVER_INPUT_HELPER_PATH}`))
    expect(dispatches.length).toBe(3)
    expect(dispatches[0].cmd).toContain("'http://127.0.0.1:9222'")
    expect(dispatches[0].cmd).toContain('"kind":"click"')
    expect(dispatches[1].cmd).toContain('"text":"Enter"')
    expect(dispatches[2].cmd).toContain('"deltaY":120')
  })

  it('take-over input surfaces dispatch failures and re-resolves the CDP endpoint after one', async () => {
    let fail = true
    const { runtime, commands } = fakeRuntime((cmd) => {
      if (cmd === cli.getCdpUrl()) return { stdout: 'ws://127.0.0.1:9222/devtools/browser/x\n', stderr: '', exitCode: 0 }
      if (cmd.startsWith('node ')) {
        if (fail) {
          fail = false
          return { stdout: '', stderr: 'no page target', exitCode: 2 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return undefined
    })
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    const takeover = provider.browser(sandboxId).takeover()

    await expect(takeover.input({ kind: 'click', x: 1, y: 1 })).rejects.toThrow(/no page target/)
    await takeover.input({ kind: 'click', x: 1, y: 1 }) // recovers
    // The failure invalidated the cached endpoint — resolved twice in total.
    expect(commands.filter((c) => c.cmd === cli.getCdpUrl()).length).toBe(2)
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
      cmd.includes(cli.getUrl())
        ? { stdout: `${PART_SEPARATOR}\nhttps://x.test/`, stderr: '', exitCode: 0 }
        : undefined,
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

/** A saved browser-use AgentHistoryList (0.13 shape) — one exploration run. */
const BU_HISTORY = {
  history: [
    {
      model_output: { action: [{ go_to_url: { url: 'https://www.google.com/travel/flights' } }] },
      result: [{ extracted_content: null, is_done: false }],
      state: { url: 'about:blank', interacted_element: [null] },
    },
    {
      model_output: {
        action: [
          { click_element_by_index: { index: 12 } },
          { input_text: { index: 13, text: 'PVG' } },
        ],
      },
      result: [{}, {}],
      state: {
        url: 'https://www.google.com/travel/flights',
        interacted_element: [
          { tag_name: 'div', attributes: { 'aria-label': 'Premium economy' } },
          { tag_name: 'input', attributes: { placeholder: 'Where from?' } },
        ],
      },
    },
    {
      // Not replayable at the distiller's altitude — must be skipped without
      // leaving a numbering gap.
      model_output: { action: [{ wait: { seconds: 2 } }] },
      result: [{}],
      state: { url: 'https://www.google.com/travel/flights', interacted_element: [null] },
    },
    {
      model_output: { action: [{ scroll: { down: true, num_pages: 0.5 } }] },
      result: [{}],
      state: { url: 'https://www.google.com/travel/flights', interacted_element: [null] },
    },
    {
      model_output: { action: [{ extract_structured_data: { query: 'premium economy prices' } }] },
      result: [{ extracted_content: 'CX premium economy from HK$9,876' }],
      state: { url: 'https://www.google.com/travel/flights/search', interacted_element: [null] },
    },
    {
      model_output: { action: [{ done: { text: 'Cheapest CX premium economy: HK$9,876', success: true } }] },
      result: [{ extracted_content: 'Cheapest CX premium economy: HK$9,876', is_done: true }],
      state: { url: 'https://www.google.com/travel/flights/search', interacted_element: [null] },
    },
  ],
}

describe('[COMP:sandbox/e2b-cloud] runBrowserUse — the 0.13 python driver lane', () => {
  it('materializes the driver, attaches over CDP, and threads the LLM key per-run only', async () => {
    let filesRef: Map<string, Uint8Array> | undefined
    const { runtime, commands, files } = fakeRuntime((cmd) => {
      if (cmd === cli.getCdpUrl()) return { stdout: 'http://127.0.0.1:9222\n', stderr: '', exitCode: 0 }
      if (cmd.includes(`.bu/driver.py`)) {
        // The "driver ran": it saves the history + final answer like the real one.
        filesRef?.set(`${SCRATCH_DIR}/.bu/history.json`, new TextEncoder().encode(JSON.stringify(BU_HISTORY)))
        filesRef?.set(`${SCRATCH_DIR}/.bu/output.txt`, new TextEncoder().encode('Cheapest CX premium economy: HK$9,876\n'))
        return { stdout: 'INFO noisy browser-use logging', stderr: '', exitCode: 0 }
      }
      return undefined
    })
    filesRef = files
    const provider = createE2bCloudProvider(runtime, {
      browserUse: { apiKeyEnvName: 'ANTHROPIC_API_KEY', apiKey: 'sk-ant-test', model: 'test-model' },
    })
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    const res = await provider.runBrowserUse(sandboxId, { goal: 'find the flight price', maxSteps: 25 })

    // The final answer comes from the driver's output FILE, never the noisy stdout.
    expect(res.output).toBe('Cheapest CX premium economy: HK$9,876')
    expect(res.trace.map((t) => t.action)).toEqual(['open', 'click', 'fill', 'scroll', 'extract', 'done'])

    const exec = commands.find((c) => c.cmd.includes('.bu/driver.py'))
    expect(exec?.cmd).toContain('python3')
    // The exploration LLM needs egress — this lane is NOT unshare-wrapped.
    expect(exec?.cmd).not.toContain('unshare')
    // Env contract: CDP attach + paths + budget + model + the per-run key
    // (the documented no-ambient-secrets exception).
    expect(exec?.envs).toMatchObject({
      BU_CDP_URL: 'http://127.0.0.1:9222',
      BU_GOAL_PATH: `${SCRATCH_DIR}/.bu/goal.txt`,
      BU_TRACE_PATH: `${SCRATCH_DIR}/.bu/history.json`,
      BU_OUT_PATH: `${SCRATCH_DIR}/.bu/output.txt`,
      BU_MAX_STEPS: '25',
      BU_MODEL: 'test-model',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    })
    // Goal + driver traveled as scratch files, never shell-interpolated.
    expect(new TextDecoder().decode(files.get(`${SCRATCH_DIR}/.bu/goal.txt`))).toBe('find the flight price')
    expect(new TextDecoder().decode(files.get(`${SCRATCH_DIR}/.bu/driver.py`))).toBe(BU_DRIVER_PY)
    // The sandbox-create path stayed secret-free — the key exists ONLY on the
    // driver exec, never on any other command.
    for (const c of commands) {
      if (!c.cmd.includes('.bu/driver.py')) expect(c.envs?.ANTHROPIC_API_KEY).toBeUndefined()
    }
  })

  it('refuses honestly when no exploration LLM is configured (no argparse death in the VM)', async () => {
    const { runtime } = fakeRuntime()
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    await expect(provider.runBrowserUse(sandboxId, { goal: 'x' })).rejects.toThrow(/not configured/i)
  })

  it('surfaces the stderr TAIL on a dead driver and re-resolves the CDP endpoint next call', async () => {
    let fail = true
    const { runtime, commands } = fakeRuntime((cmd) => {
      if (cmd === cli.getCdpUrl()) return { stdout: 'http://127.0.0.1:9222\n', stderr: '', exitCode: 0 }
      if (cmd.includes('.bu/driver.py')) {
        if (fail) {
          fail = false
          return {
            stdout: '',
            stderr: `Traceback (most recent call last):\n${'  ...\n'.repeat(200)}RuntimeError: no LLM API key in the driver environment`,
            exitCode: 1,
          }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return undefined
    })
    const provider = createE2bCloudProvider(runtime, {
      browserUse: { apiKeyEnvName: 'GOOGLE_API_KEY', apiKey: 'g-key', model: 'flash-test' },
    })
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    // Tail, not head: the traceback's LAST line is the real diagnostic.
    await expect(provider.runBrowserUse(sandboxId, { goal: 'x' })).rejects.toThrow(
      /RuntimeError: no LLM API key/,
    )
    // The failure dropped the cached CDP endpoint — the retry re-resolves it.
    await provider.runBrowserUse(sandboxId, { goal: 'x' }).catch(() => undefined)
    expect(commands.filter((c) => c.cmd === cli.getCdpUrl()).length).toBe(2)
  })
})

describe('[COMP:sandbox/e2b-cloud] mapBrowserUseHistory — history → distiller trace', () => {
  it('maps the 0.13 saved history into BuTraceSteps with element labels', () => {
    const { trace, output } = mapBrowserUseHistory(BU_HISTORY)
    expect(trace).toEqual([
      { step: 1, action: 'open', url: 'https://www.google.com/travel/flights' },
      {
        step: 2,
        action: 'click',
        url: 'https://www.google.com/travel/flights',
        label: 'Premium economy',
      },
      {
        step: 3,
        action: 'fill',
        url: 'https://www.google.com/travel/flights',
        label: 'Where from?',
        text: 'PVG',
      },
      { step: 4, action: 'scroll', url: 'https://www.google.com/travel/flights', detail: '400' },
      {
        step: 5,
        action: 'extract',
        url: 'https://www.google.com/travel/flights/search',
        text: 'CX premium economy from HK$9,876',
      },
      { step: 6, action: 'done', text: 'Cheapest CX premium economy: HK$9,876' },
    ])
    expect(output).toBe('Cheapest CX premium economy: HK$9,876')
  })

  it('accepts a bare item array and maps search actions to an open of the results page', () => {
    const { trace } = mapBrowserUseHistory([
      {
        model_output: { action: [{ search_google: { query: 'cx pvg sfo' } }] },
        result: [{}],
        state: { url: 'about:blank', interacted_element: [null] },
      },
    ])
    expect(trace).toEqual([
      { step: 1, action: 'open', url: 'https://www.google.com/search?q=cx%20pvg%20sfo' },
    ])
  })

  it('keeps clicks without a find()-able label as label:null for the distiller to drop', () => {
    const { trace } = mapBrowserUseHistory([
      {
        model_output: { action: [{ click_element_by_index: { index: 3 } }] },
        result: [{}],
        state: { url: 'https://x.test/', interacted_element: [{ tag_name: 'div', attributes: { class: 'btn' } }] },
      },
    ])
    expect(trace).toEqual([{ step: 1, action: 'click', url: 'https://x.test/', label: null }])
  })

  it('never throws on garbage or schema drift', () => {
    expect(mapBrowserUseHistory(null).trace).toEqual([])
    expect(mapBrowserUseHistory('nope').trace).toEqual([])
    expect(mapBrowserUseHistory({ history: [{ model_output: null }, 42, { result: 'x' }] }).trace).toEqual([])
    expect(
      mapBrowserUseHistory({ history: [{ model_output: { action: [{ brand_new_verb: { a: 1 } }] }, state: {}, result: [] }] })
        .trace,
    ).toEqual([])
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
