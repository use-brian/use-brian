/**
 * E2BCloudProvider — the v1 `SandboxProvider` (§4.3): one task-scoped E2B
 * microVM hosting agent-browser + Python over a shared ephemeral scratch.
 * Structured as a pure adapter over the `E2bRuntime` wrapper (runtime.ts is
 * the only E2B-SDK importer); tests inject a fake runtime, and BYOC/self-host
 * later swap the runtime construction, not this file.
 *
 * Containment contracts implemented HERE (§4.7, §8):
 *  - runPython always executes under an unshared network namespace
 *    (`unshare -rn`) in isolated mode (`python3 -I`) — egress-denied by
 *    construction, fail-closed when the template lacks `unshare`.
 *  - No ambient secrets: nothing from the host env is forwarded into the
 *    sandbox; the only credentials a sandbox ever sees are the session bundle
 *    the orchestrator explicitly injects and — on the `runBrowserUse` lane
 *    only — the exploration LLM key, set per-run on the driver exec (the
 *    agentic loop runs inside the VM and must reach its LLM; documented on
 *    `E2bCloudProviderConfig.browserUse`).
 *  - The BYOP proxy hook (§4.6) is agent-browser's `-p` flag, wired but
 *    dormant (set per-create, never a pool).
 */
import {
  BrowserBackendError,
  type BlockRunHandle,
  type BrowserUseRunResult,
  type BrowserSnapshot,
  type BuTraceStep,
  type RunPythonRequest,
  type RunPythonResult,
  type SandboxBridge,
  type SandboxBrowser,
  type SandboxCreateOptions,
  type SandboxHandle,
  type SandboxProvider,
  type SessionBundle,
  type TakeoverInputEvent,
} from '../../types.js'
import { SANDBOX_SESSION_NAME, SANDBOX_VIEWPORT, chainCommands, cli, parseSnapshotOutput, sessionEnv, splitCommandParts } from './agent-browser-cli.js'
import { BU_DRIVER_PY, mapBrowserUseHistory } from './bu-driver.js'
import {
  TAKEOVER_INPUT_HELPER_MJS,
  TAKEOVER_INPUT_HELPER_PATH,
  takeoverInputCommand,
} from './takeover-input.js'
import {
  TAKEOVER_BRIDGE_PORT,
  TAKEOVER_STREAM_BRIDGE_MJS,
  TAKEOVER_STREAM_BRIDGE_PATH,
  bridgeLaunchCommand,
  bridgeProbeCommand,
} from './takeover-stream.js'
import type { E2bRuntime, E2bSandboxHandle } from './runtime.js'
import { randomBytes } from 'node:crypto'

export const SCRATCH_DIR = '/home/user/scratch'
export const DOWNLOADS_DIR = '/home/user/downloads'
// Sandbox commands run as `user` (HOME=/home/user), NOT root — validated
// in-sandbox 2026-07-13. Auth state moves through explicit files: inject
// writes one that AGENT_BROWSER_STATE loads at daemon launch (missing file
// = hard launch error, so the env is only set after an inject); capture
// runs `state save` into the other and reads it back.
function injectStatePath(sandboxId: string): string {
  return `/home/user/.agent-browser/inject-sbx-${sandboxId}.json`
}
function captureStatePath(sandboxId: string): string {
  return `/home/user/.agent-browser/capture-sbx-${sandboxId}.json`
}

const DEFAULT_MAX_LIFETIME_SECONDS = 3600
const COMMAND_TIMEOUT_MS = 40_000
const PYTHON_DEFAULT_TIMEOUT_MS = 60_000
const SKILL_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_DOWNLOAD_FILES = 20

export type E2bCloudProviderConfig = {
  templateId?: string
  defaultMaxLifetimeSeconds?: number
  /**
   * The LLM the watched browser-use exploration drives (R2-1). Threaded from
   * boot — the model id NEVER lives in this tree (plan §4.14 model routing),
   * and the key is injected per-run onto the driver exec only, the one
   * documented exception to the no-ambient-secrets contract (§8): the
   * exploration's agentic loop runs inside the VM and must reach its LLM.
   * Absent → `runBrowserUse` refuses with an honest configuration error.
   */
  browserUse?: {
    apiKeyEnvName: 'ANTHROPIC_API_KEY' | 'GOOGLE_API_KEY' | 'OPENAI_API_KEY'
    apiKey: string
    model: string
  }
}

type PerSandbox = {
  proxyUrl?: string
  unshareChecked?: boolean
  stateInjected?: boolean
  /** Take-Over trusted input (§4.8): helper written + CDP endpoint cached. */
  takeoverHelperWritten?: boolean
  cdpUrl?: string
  /** Live stream bridge (§5): per-sandbox capability token, stable across re-mints. */
  streamToken?: string
  pythonRunCounter: number
}

export function createE2bCloudProvider(
  runtime: E2bRuntime,
  config: E2bCloudProviderConfig = {},
): SandboxProvider {
  const perSandbox = new Map<string, PerSandbox>()
  const handles = new Map<string, E2bSandboxHandle>()

  function meta(sandboxId: string): PerSandbox {
    let m = perSandbox.get(sandboxId)
    if (!m) {
      m = { pythonRunCounter: 0 }
      perSandbox.set(sandboxId, m)
    }
    return m
  }

  async function handleFor(sandboxId: string): Promise<E2bSandboxHandle> {
    const cached = handles.get(sandboxId)
    if (cached) return cached
    const handle = await runtime.connect(sandboxId)
    handles.set(sandboxId, handle)
    return handle
  }

  async function runBrowserCommand(sandboxId: string, command: string): Promise<string> {
    const handle = await handleFor(sandboxId)
    const res = await handle.runCommand(command, {
      timeoutMs: COMMAND_TIMEOUT_MS,
      envs: {
        // Fixed name (NOT per-sandbox): matches the daemon the template
        // snapshot pre-warmed at build time, so the first command reuses
        // the already-running Chromium instead of paying its cold launch.
        ...sessionEnv(SANDBOX_SESSION_NAME),
        // The daemon launches on the first command and loads auth state
        // from this file; pointing at a missing file fails the launch, so
        // only set it once injectStorageState has written one.
        ...(meta(sandboxId).stateInjected ? { AGENT_BROWSER_STATE: injectStatePath(sandboxId) } : {}),
      },
    })
    if (res.exitCode !== 0) {
      const message = (res.stderr || res.stdout || 'agent-browser command failed').trim()
      const code = /not found|stale|unknown ref|no element/i.test(message) ? 'stale_ref' : 'backend_error'
      throw new BrowserBackendError(message.slice(0, 500), code)
    }
    return res.stdout
  }

  function browser(sandboxId: string): SandboxBrowser {
    return {
      // Multi-verb ops chain into ONE sandbox exec (chainCommands): every
      // E2B command is a network round trip, and browse latency is round
      // trips, not compute.
      navigate: async (url) => {
        const proxy = meta(sandboxId).proxyUrl
        const open = proxy ? `${cli.open(url)} -p '${proxy.replace(/'/g, '')}'` : cli.open(url)
        // Viewport rides the same exec (chained = zero extra round trips) on
        // every navigate: the snapshot's pre-warmed daemon and a
        // vault-injected relaunch both come up at the CLI default size, and
        // re-applying an unchanged viewport is a no-op.
        const out = await runBrowserCommand(
          sandboxId,
          chainCommands(cli.setViewport(SANDBOX_VIEWPORT.width, SANDBOX_VIEWPORT.height), open, cli.getUrl()),
        )
        const parts = splitCommandParts(out)
        const current = (parts[2] ?? '').trim()
        return { url: current || url }
      },
      snapshot: async (): Promise<BrowserSnapshot> => {
        const out = await runBrowserCommand(
          sandboxId,
          chainCommands(cli.snapshot(), cli.getUrl(), cli.getTitle()),
        )
        const [raw, url, title] = splitCommandParts(out)
        return parseSnapshotOutput(raw ?? '', { url: (url ?? '').trim(), title: (title ?? '').trim() })
      },
      click: async (ref) => {
        await runBrowserCommand(sandboxId, cli.click(ref))
      },
      type: async (ref, text) => {
        await runBrowserCommand(sandboxId, cli.fill(ref, text))
      },
      currentUrl: async () => {
        const out = await runBrowserCommand(sandboxId, chainCommands(cli.getUrl(), cli.getTitle()))
        const [url, title] = splitCommandParts(out)
        return { url: (url ?? '').trim(), title: (title ?? '').trim() }
      },
      captureStorageState: async (site): Promise<SessionBundle> => {
        const handle = await handleFor(sandboxId)
        try {
          await runBrowserCommand(sandboxId, cli.stateSave(captureStatePath(sandboxId)))
          const bytes = await handle.readFile(captureStatePath(sandboxId))
          const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
            cookies?: unknown[]
            origins?: Array<{ origin?: string; localStorage?: Array<{ name?: string; value?: string }> }>
          }
          const localStorage: Record<string, Record<string, string>> = {}
          for (const origin of parsed.origins ?? []) {
            if (!origin.origin) continue
            const kv: Record<string, string> = {}
            for (const item of origin.localStorage ?? []) {
              if (typeof item.name === 'string') kv[item.name] = item.value ?? ''
            }
            localStorage[origin.origin] = kv
          }
          return {
            site,
            cookies: parsed.cookies ?? [],
            localStorage: Object.keys(localStorage).length ? localStorage : undefined,
            capturedAt: new Date().toISOString(),
          }
        } catch (err) {
          throw new BrowserBackendError(
            `Could not capture the browser session state: ${err instanceof Error ? err.message : String(err)}`,
            'backend_error',
          )
        }
      },
      injectStorageState: async (bundle): Promise<void> => {
        // Must run BEFORE the first navigate in the sandbox — the daemon
        // loads AGENT_BROWSER_STATE at launch (the orchestrator guarantees
        // the ordering: connect → inject → browse).
        const handle = await handleFor(sandboxId)
        const origins = Object.entries(bundle.localStorage ?? {}).map(([origin, kv]) => ({
          origin,
          localStorage: Object.entries(kv).map(([name, value]) => ({ name, value })),
        }))
        const state = JSON.stringify({ cookies: bundle.cookies, origins })
        await handle.runCommand(`mkdir -p /home/user/.agent-browser`, { timeoutMs: 10_000 })
        await handle.writeFile(injectStatePath(sandboxId), new TextEncoder().encode(state))
        // If a daemon is already up it predates the state file — drop it so
        // the next command relaunches with the injected auth. No-op when
        // nothing is running.
        await handle
          .runCommand('agent-browser close --all', { timeoutMs: 10_000 })
          .catch(() => undefined)
        meta(sandboxId).stateInjected = true
      },
      takeover: () => {
        let closed = false
        let frameCounter = 0
        return {
          nextFrame: async () => {
            if (closed) return null
            const framePath = `/tmp/takeover-frame-${frameCounter++ % 2}.png`
            await runBrowserCommand(sandboxId, cli.screenshot(framePath))
            const handle = await handleFor(sandboxId)
            const bytes = await handle.readFile(framePath)
            return { data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }
          },
          input: async (event: TakeoverInputEvent) => {
            if (closed) return
            // Trusted CDP dispatch (takeover-input.ts): real input events,
            // never DOM synthesis — bot checks, iframes, and focus all
            // behave as if a human sat at the sandbox browser.
            const handle = await handleFor(sandboxId)
            const m = meta(sandboxId)
            if (!m.takeoverHelperWritten) {
              await handle.writeFile(
                TAKEOVER_INPUT_HELPER_PATH,
                new TextEncoder().encode(TAKEOVER_INPUT_HELPER_MJS),
              )
              m.takeoverHelperWritten = true
            }
            if (!m.cdpUrl) {
              m.cdpUrl = (await runBrowserCommand(sandboxId, cli.getCdpUrl())).trim()
              if (!m.cdpUrl) {
                throw new BrowserBackendError(
                  'The sandbox browser reported no CDP endpoint (is a page open yet?)',
                  'backend_error',
                )
              }
            }
            const res = await handle.runCommand(
              takeoverInputCommand(m.cdpUrl, JSON.stringify(event)),
              { timeoutMs: 15_000 },
            )
            if (res.exitCode !== 0) {
              // A dead daemon invalidates the cached endpoint — refresh next call.
              m.cdpUrl = undefined
              throw new BrowserBackendError(
                (res.stderr || res.stdout || 'takeover input dispatch failed').trim().slice(0, 500),
                'backend_error',
              )
            }
          },
          close: async () => {
            closed = true
          },
        }
      },
      openTakeoverStream: async () => {
        const handle = await handleFor(sandboxId)
        const m = meta(sandboxId)
        if (!m.streamToken) {
          const token = randomBytes(32).toString('hex')
          // Order matters: resolve CDP while the daemon is warm, write +
          // launch the bridge, then probe it up. The bridge drives the
          // screencast itself over CDP — agent-browser's stream server is
          // not involved anymore.
          if (!m.cdpUrl) {
            m.cdpUrl = (await runBrowserCommand(sandboxId, cli.getCdpUrl())).trim()
            if (!m.cdpUrl) {
              throw new BrowserBackendError(
                'The sandbox browser reported no CDP endpoint (is a page open yet?)',
                'backend_error',
              )
            }
          }
          await handle.writeFile(
            TAKEOVER_STREAM_BRIDGE_PATH,
            new TextEncoder().encode(TAKEOVER_STREAM_BRIDGE_MJS),
          )
          // envd holds the exec open on the detached child's fds even though
          // setsid detaches the bridge itself (observed 2026-07-15), so this
          // command "times out" as a matter of course — the probe below is
          // the real success signal, and the setsid'd bridge survives the
          // exec-session kill.
          await handle
            .runCommand(bridgeLaunchCommand(token, m.cdpUrl), { timeoutMs: 1_500 })
            .catch(() => undefined)
          let up = false
          for (let attempt = 0; attempt < 5 && !up; attempt++) {
            const probe = await handle.runCommand(bridgeProbeCommand(), { timeoutMs: 10_000 })
            up = probe.stdout.trim() !== '0' && probe.stdout.trim() !== ''
            if (!up) await new Promise((r) => setTimeout(r, 400))
          }
          if (!up) {
            throw new BrowserBackendError(
              'The take-over stream bridge did not come up — falling back to polled frames.',
              'backend_error',
            )
          }
          m.streamToken = token
        }
        const host = handle.getHost(TAKEOVER_BRIDGE_PORT)
        return {
          framesUrl: `https://${host}/frames?token=${m.streamToken}`,
          inputUrl: `https://${host}/input?token=${m.streamToken}`,
          // The duplex leg: binary frames down, input up, one socket. Old
          // clients ignore it and stay on SSE + POST against the same bridge.
          wsUrl: `wss://${host}/ws?token=${m.streamToken}`,
        }
      },
    }
  }

  const bridge: SandboxBridge = {
    load: async (sandboxId, params) => {
      const handle = await handleFor(sandboxId)
      const path = params.path.startsWith('/') ? params.path : `${SCRATCH_DIR}/${params.path}`
      await handle.runCommand(`mkdir -p ${SCRATCH_DIR} ${DOWNLOADS_DIR}`, { timeoutMs: 10_000 })
      await handle.writeFile(path, params.bytes)
      return { path }
    },
    save: async (sandboxId, params) => {
      const handle = await handleFor(sandboxId)
      const path = params.path.startsWith('/') ? params.path : `${SCRATCH_DIR}/${params.path}`
      return { bytes: await handle.readFile(path) }
    },
    pullDownloads: async (sandboxId) => {
      const handle = await handleFor(sandboxId)
      let entries: Array<{ name: string; path: string; isDir: boolean }>
      try {
        entries = await handle.listDir(DOWNLOADS_DIR)
      } catch {
        return [] // no downloads dir → nothing downloaded
      }
      const files = entries.filter((e) => !e.isDir).slice(0, MAX_DOWNLOAD_FILES)
      const out: Array<{ path: string; bytes: Uint8Array }> = []
      for (const file of files) {
        out.push({ path: file.path, bytes: await handle.readFile(file.path) })
      }
      return out
    },
  }

  return {
    name: 'e2b-cloud',

    async create(opts: SandboxCreateOptions): Promise<SandboxHandle> {
      const handle = await runtime.create({
        templateId: config.templateId,
        timeoutMs: (opts.maxLifetimeSeconds ?? config.defaultMaxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS) * 1000,
        metadata: {
          workspaceId: opts.workspaceId,
          taskId: opts.taskId,
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.egressAllowlist?.length ? { egressAllowlist: opts.egressAllowlist.join(',') } : {}),
        },
        // The browser must reach its target site; python isolation never
        // relies on this flag (unshare -rn below).
        allowInternetAccess: true,
      })
      handles.set(handle.id, handle)
      if (opts.proxyUrl) meta(handle.id).proxyUrl = opts.proxyUrl
      return { sandboxId: handle.id }
    },

    async connect(sandboxId: string): Promise<SandboxHandle> {
      await handleFor(sandboxId)
      return { sandboxId }
    },

    async pause(sandboxId: string): Promise<void> {
      const handle = await handleFor(sandboxId)
      await handle.pause()
      handles.delete(sandboxId) // a paused handle must reconnect
    },

    async resume(sandboxId: string): Promise<void> {
      handles.delete(sandboxId)
      await handleFor(sandboxId) // connect resumes transparently
    },

    async kill(sandboxId: string): Promise<void> {
      try {
        const handle = await handleFor(sandboxId)
        await handle.kill()
      } finally {
        handles.delete(sandboxId)
        perSandbox.delete(sandboxId)
      }
    },

    browser,

    async runPython(sandboxId: string, req: RunPythonRequest): Promise<RunPythonResult> {
      const handle = await handleFor(sandboxId)
      const m = meta(sandboxId)
      if (!m.unshareChecked) {
        // Fail-closed egress contract: no unshare → refuse to run at all.
        const probe = await handle.runCommand('command -v unshare', { timeoutMs: 10_000 })
        if (probe.exitCode !== 0) {
          throw new Error(
            'Python isolation unavailable: the sandbox template lacks `unshare`, so egress-denied execution cannot be guaranteed. Refusing to run.',
          )
        }
        m.unshareChecked = true
      }
      m.pythonRunCounter += 1
      const scriptPath = `${SCRATCH_DIR}/.exec-${m.pythonRunCounter}.py`
      await handle.runCommand(`mkdir -p ${SCRATCH_DIR}`, { timeoutMs: 10_000 })
      await handle.writeFile(scriptPath, new TextEncoder().encode(req.code))
      // -rn = new user+net namespace (loopback only, no egress); -I = isolated
      // python (no env vars, no user site-packages beyond the baked template).
      const res = await handle.runCommand(
        `cd ${SCRATCH_DIR} && unshare -rn python3 -I ${scriptPath}`,
        { timeoutMs: req.timeoutMs ?? PYTHON_DEFAULT_TIMEOUT_MS },
      )
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode }
    },

    async runBrowserUse(sandboxId: string, req): Promise<BrowserUseRunResult> {
      // The watched agentic fallback (R2-1): browser-use runs INSIDE the
      // micro-VM through its 0.13 Python API — the provider materializes a
      // deterministic driver (bu-driver.ts) that attaches over CDP to the
      // SAME Chromium agent-browser drives (so injected profile state
      // applies), runs one Agent loop, and saves the history JSON that
      // `mapBrowserUseHistory` turns into the distiller's trace. The old
      // one-shot `browser-use run --task-file` CLI never existed in 0.13 —
      // every prod run argparse-died with exit 2 (2026-07-21 incident).
      const bu = config.browserUse
      if (!bu) {
        throw new Error(
          'browser-use is not configured on this deployment: the sandbox provider has no LLM key for the exploration agent, so agentic browsing cannot run. The flat browser tools still work.',
        )
      }
      const handle = await handleFor(sandboxId)
      const m = meta(sandboxId)
      // The CDP endpoint of the warm daemon (auto-starts on first use) —
      // same cache + invalidation discipline as the take-over input relay.
      if (!m.cdpUrl) {
        m.cdpUrl = (await runBrowserCommand(sandboxId, cli.getCdpUrl())).trim()
        if (!m.cdpUrl) {
          throw new Error('browser-use failed: the sandbox browser exposed no CDP endpoint')
        }
      }
      const goalPath = `${SCRATCH_DIR}/.bu/goal.txt`
      const driverPath = `${SCRATCH_DIR}/.bu/driver.py`
      const tracePath = `${SCRATCH_DIR}/.bu/history.json`
      const outPath = `${SCRATCH_DIR}/.bu/output.txt`
      await handle.runCommand(`mkdir -p ${SCRATCH_DIR}/.bu`, { timeoutMs: 10_000 })
      await handle.writeFile(goalPath, new TextEncoder().encode(req.goal))
      await handle.writeFile(driverPath, new TextEncoder().encode(BU_DRIVER_PY))
      const res = await handle.runCommand(`cd ${SCRATCH_DIR} && python3 ${driverPath}`, {
        timeoutMs: req.timeoutMs ?? SKILL_DEFAULT_TIMEOUT_MS,
        envs: {
          BU_CDP_URL: m.cdpUrl,
          BU_GOAL_PATH: goalPath,
          BU_TRACE_PATH: tracePath,
          BU_OUT_PATH: outPath,
          BU_MAX_STEPS: String(req.maxSteps ?? 40),
          BU_MODEL: bu.model,
          // Per-run key injection — the documented no-ambient-secrets
          // exception (see E2bCloudProviderConfig.browserUse).
          [bu.apiKeyEnvName]: bu.apiKey,
          ANONYMIZED_TELEMETRY: 'false',
          BROWSER_USE_CLOUD_SYNC: 'false',
        },
      })
      let trace: BuTraceStep[] = []
      let mappedOutput = ''
      try {
        const bytes = await handle.readFile(tracePath)
        const mapped = mapBrowserUseHistory(JSON.parse(Buffer.from(bytes).toString('utf8')))
        trace = mapped.trace
        mappedOutput = mapped.output
      } catch {
        /* no trace → the distiller has nothing to compile; the output still returns */
      }
      let output = ''
      try {
        output = Buffer.from(await handle.readFile(outPath)).toString('utf8').trim()
      } catch {
        /* fall back to the mapped done-text below */
      }
      if (res.exitCode !== 0 && trace.length === 0) {
        // A failed CDP attach could also mean the daemon relaunched under a
        // new endpoint — drop the cache so the next attempt re-resolves.
        m.cdpUrl = undefined
        // Tail, not head: a Python traceback puts the real error LAST.
        throw new Error(
          `browser-use failed: ${(res.stderr || res.stdout || 'unknown error').trim().slice(-600)}`,
        )
      }
      return { trace, output: output || mappedOutput }
    },

    async runSkill(sandboxId: string, req): Promise<BlockRunHandle> {
      // The PRIVILEGED lane (R2-9): plain python3, no unshare — the governed
      // shim next to the entry script drives agent-browser; its terminal
      // sends still handshake with the host gate through scratch files.
      const handle = await handleFor(sandboxId)
      await handle.runCommand(`mkdir -p ${SCRATCH_DIR}/.runner`, { timeoutMs: 10_000 })
      const running = handle.runCommand(`cd ${SCRATCH_DIR} && python3 ${req.entryPath}`, {
        timeoutMs: req.timeoutMs ?? SKILL_DEFAULT_TIMEOUT_MS,
        envs: { SKILL_SESSION_NAME: SANDBOX_SESSION_NAME },
      })
      return {
        wait: async () => {
          const res = await running
          return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode }
        },
      }
    },

    bridge,
  }
}
