import { describe, it, expect, vi } from 'vitest'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createE2bCloudProvider } from '../providers/e2b/index.js'
import { cli } from '../providers/e2b/agent-browser-cli.js'
import {
  mintTakeoverLease,
  TAKEOVER_BRIDGE_PORT,
  TAKEOVER_STREAM_BRIDGE_MJS,
  TAKEOVER_STREAM_BRIDGE_PATH,
  bridgeLaunchCommand,
  bridgeProbeCommand,
} from '../providers/e2b/takeover-stream.js'
import type { E2bCommandResult, E2bRuntime, E2bSandboxHandle } from '../providers/e2b/runtime.js'

function fakeRuntime(respond?: (cmd: string) => E2bCommandResult | undefined) {
  const commands: Array<{ cmd: string; envs?: Record<string, string> }> = []
  const files = new Map<string, Uint8Array>()

  function handle(id: string): E2bSandboxHandle {
    return {
      id,
      async runCommand(cmd, opts) {
        commands.push({ cmd, envs: opts?.envs })
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
      async listDir() {
        return []
      },
      getHost(port) {
        return `${port}-${id}.e2b.test`
      },
      async pause() {},
      async kill() {},
    }
  }

  const runtime: E2bRuntime = {
    async create() {
      return handle('sbx-under-test')
    },
    async connect(sandboxId) {
      return handle(sandboxId)
    },
  }
  return { runtime, commands, files }
}

/** Standard happy-path responder: CDP url resolves, the bridge probe sees a listener. */
function respondUp(cmd: string): E2bCommandResult | undefined {
  if (cmd.includes(cli.getCdpUrl())) {
    return { stdout: 'ws://127.0.0.1:36015/devtools/browser/abc\n', stderr: '', exitCode: 0 }
  }
  if (cmd.includes(`grep -c :${TAKEOVER_BRIDGE_PORT}`)) {
    return { stdout: '1\n', stderr: '', exitCode: 0 }
  }
  return undefined
}

describe('[COMP:sandbox/takeover-stream] Take-Over live stream', () => {
  it('bridge source is dependency-free, 0.0.0.0-bound, and token-gates every route in constant time', () => {
    // Only node: builtins + the global WebSocket — a bare import would need
    // node_modules the template does not carry on the task path.
    const imports = [...TAKEOVER_STREAM_BRIDGE_MJS.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.every((s) => s.startsWith('node:'))).toBe(true)
    // The ONE exposed listener binds 0.0.0.0 (E2B ingress upgrades only reach
    // 0.0.0.0 binds — probed 2026-07-15); CDP stays loopback behind it.
    expect(TAKEOVER_STREAM_BRIDGE_MJS).toContain(`server.listen(PORT, '0.0.0.0'`)
    // Token check happens BEFORE any route dispatch, in constant time — on
    // the HTTP routes AND on the WebSocket upgrade.
    const gate = TAKEOVER_STREAM_BRIDGE_MJS.indexOf(`if (!tokenOk(url.searchParams.get('token'))) { res.writeHead(403)`)
    const framesRoute = TAKEOVER_STREAM_BRIDGE_MJS.indexOf(`url.pathname === '/frames'`)
    const inputRoute = TAKEOVER_STREAM_BRIDGE_MJS.indexOf(`url.pathname === '/input'`)
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(framesRoute)
    expect(gate).toBeLessThan(inputRoute)
    expect(TAKEOVER_STREAM_BRIDGE_MJS).toContain(
      `if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('token')))`,
    )
    expect(TAKEOVER_STREAM_BRIDGE_MJS).toContain('timingSafeEqual')
    // Latest-frame-wins under backpressure — stale pixels are dropped, not queued.
    expect(TAKEOVER_STREAM_BRIDGE_MJS).toContain('writableLength')
    // A losing concurrent launch exits clean (idempotent by listener).
    expect(TAKEOVER_STREAM_BRIDGE_MJS).toContain('EADDRINUSE')
  })

  it('bridge OWNS a tuned screencast: startScreencast + throttled acks + idle sharp frame + stop when unwatched', () => {
    // The whole point of the bridge-owned screencast: tuned quality/scale
    // (agent-browser's stream server has no knobs), ack-paced frame rate,
    // and zero encoding cost with no viewer connected.
    for (const marker of [
      'Page.startScreencast',
      'Page.screencastFrameAck',
      'Page.stopScreencast',
      'Page.captureScreenshot',
      'maxWidth',
      'ACK_DELAY_MS',
      'IDLE_SHARP_MS',
      // Screencast only paints the FOREGROUND tab (a background attach
      // starts fine and emits nothing — observed 2026-07-21).
      'Page.bringToFront',
      // The sandbox's initial about:blank must never win the target pick.
      `t.url !== 'about:blank'`,
      // captureScreenshot forces a compositor frame; without hash dedup an
      // idle page ping-pongs cast ↔ sharp forever (observed 2026-07-21).
      'lastCastHash',
    ]) {
      expect(TAKEOVER_STREAM_BRIDGE_MJS).toContain(marker)
    }
  })

  it('bridge input vocabulary stays in lockstep with takeover-input.ts (click/pointer/key/scroll), plus socket-only move and the frame→viewport rescale', () => {
    for (const marker of [
      `event.kind === 'click'`,
      `event.kind === 'pointer'`,
      `event.action !== 'down'`,
      'buttons:',
      'queueInput',
      `event.kind === 'move'`,
      `event.kind === 'key'`,
      `event.kind === 'scroll'`,
      'Input.insertText',
      'Input.dispatchMouseEvent',
      'Input.dispatchKeyEvent',
      'mouseWheel',
      // Stream frames are size-capped, so frame px != viewport px — input
      // must rescale or clicks land offset.
      'event.frameW',
      // Browser-chrome navigation (§5) rides the same dispatch as click/key/scroll.
      `event.kind === 'navigate'`,
      'Page.reload',
      'Page.navigate',
      'Page.navigateToHistoryEntry',
    ]) {
      expect(TAKEOVER_STREAM_BRIDGE_MJS).toContain(marker)
    }
  })

  it('launch command detaches every fd and carries no stream-server leg', () => {
    const launch = bridgeLaunchCommand('tok-1', 'ws://127.0.0.1:1/x')
    expect(launch).toContain('setsid nohup node')
    expect(launch).toContain('</dev/null')
    expect(launch).toContain('2>&1 &')
    expect(launch).toContain(TAKEOVER_STREAM_BRIDGE_PATH)
    // The bridge screencasts over CDP itself — agent-browser's stream server
    // is out of the loop entirely.
    expect(launch).not.toContain('--stream')
    expect(bridgeProbeCommand()).toContain(String(TAKEOVER_BRIDGE_PORT))
  })

  it('openTakeoverStream writes + launches the bridge and returns tokened capability URLs incl. the duplex socket', async () => {
    const { runtime, commands, files } = fakeRuntime(respondUp)
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    const info = await provider.browser(sandboxId).openTakeoverStream!()

    expect(info).not.toBeNull()
    const cmds = commands.map((c) => c.cmd)
    // No stream-server exec anymore: the bridge drives the screencast itself.
    expect(cmds.some((c) => c.includes('stream enable'))).toBe(false)
    expect(cmds.some((c) => c.includes('setsid nohup node'))).toBe(true)
    expect(files.has(TAKEOVER_STREAM_BRIDGE_PATH)).toBe(true)

    const framesUrl = new URL(info!.framesUrl)
    const inputUrl = new URL(info!.inputUrl)
    const wsUrl = new URL(info!.wsUrl!)
    expect(framesUrl.protocol).toBe('https:')
    expect(framesUrl.host).toBe(`${TAKEOVER_BRIDGE_PORT}-${sandboxId}.e2b.test`)
    expect(framesUrl.pathname).toBe('/frames')
    expect(inputUrl.pathname).toBe('/input')
    expect(wsUrl.protocol).toBe('wss:')
    expect(wsUrl.host).toBe(`${TAKEOVER_BRIDGE_PORT}-${sandboxId}.e2b.test`)
    expect(wsUrl.pathname).toBe('/ws')
    const token = framesUrl.searchParams.get('token')!
    expect(token).toMatch(/^[0-9]+\.[0-9a-f]{64}$/)
    expect(Number(token.split('.')[0])).toBe(info!.expiresAt)
    expect(inputUrl.searchParams.get('token')).toBe(token)
    expect(wsUrl.searchParams.get('token')).toBe(token)
    // Only the signing secret rides the launch command; it is never the bearer.
    expect(cmds.find((c) => c.includes('setsid nohup node'))).not.toContain(token)
  })

  it('re-minting reuses the live bridge without a second launch', async () => {
    const { runtime, commands } = fakeRuntime(respondUp)
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    const first = await provider.browser(sandboxId).openTakeoverStream!()
    const launchesAfterFirst = commands.filter((c) => c.cmd.includes('setsid nohup node')).length
    const second = await provider.browser(sandboxId).openTakeoverStream!()
    const launchesAfterSecond = commands.filter((c) => c.cmd.includes('setsid nohup node')).length

    expect(second!.framesUrl.split('?')[0]).toEqual(first!.framesUrl.split('?')[0])
    expect(second!.expiresAt).toBeGreaterThanOrEqual(first!.expiresAt!)
    expect(launchesAfterFirst).toBe(1)
    expect(launchesAfterSecond).toBe(1)
  })

  it('a bridge that never comes up fails honestly (the page falls back to polling)', async () => {
    const { runtime } = fakeRuntime((cmd) => {
      if (cmd.includes(cli.getCdpUrl())) {
        return { stdout: 'ws://127.0.0.1:36015/devtools/browser/abc\n', stderr: '', exitCode: 0 }
      }
      if (cmd.includes(`grep -c :${TAKEOVER_BRIDGE_PORT}`)) {
        return { stdout: '0\n', stderr: '', exitCode: 0 }
      }
      return undefined
    })
    const provider = createE2bCloudProvider(runtime)
    const { sandboxId } = await provider.create({ workspaceId: 'w', taskId: 't' })
    await expect(provider.browser(sandboxId).openTakeoverStream!()).rejects.toThrow(/did not come up/)
  })
})


describe('[COMP:sandbox/takeover-stream] generated bridge lease enforcement', () => {
  it('rejects secret replay/tampering, closes open viewers and denies queued input at expiry', async () => {
    let now = 1_000_000
    const timers: Array<{ run: () => void; ms: number }> = []
    const server = new EventEmitter() as EventEmitter & { listen: () => void }
    server.listen = () => {}
    let httpHandler: (req: any, res: any) => void = () => {}
    const scope: Record<string, any> = {
      crypto, Buffer, URL, console,
      http: { createServer: (handler: typeof httpHandler) => { httpHandler = handler; return server } },
      process: { argv: ['node', 'bridge', '--port', '1234', '--cdp', 'ws://localhost/cdp', '--token', 'fixture-secret'], exit: vi.fn() },
      Date: class extends Date { static now() { return now } },
      setInterval: () => 0, clearInterval: () => {},
      setTimeout: (run: () => void, ms: number) => { timers.push({ run, ms }); return timers.length }, clearTimeout: () => {},
      WebSocket: class {},
    }
    vm.createContext(scope)
    vm.runInContext(TAKEOVER_STREAM_BRIDGE_MJS.replace(/^import .*$/gm, '') +
      '\nglobalThis.testApi = { tokenOk, queueInput, broadcast, viewers };', scope)
    const lease = mintTakeoverLease('fixture-secret', now)
    expect(scope.testApi.tokenOk(lease.token)).toBe(true)
    expect(scope.testApi.tokenOk('fixture-secret')).toBe(false)
    expect(scope.testApi.tokenOk(lease.token.replace(/^1/, '2'))).toBe(false)
    expect(scope.testApi.tokenOk(mintTakeoverLease('wrong-secret', now).token)).toBe(false)
    const req = Object.assign(new EventEmitter(), { url: '/frames?token=' + lease.token, method: 'GET' })
    const res = Object.assign(new EventEmitter(), { setHeader: vi.fn(), writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), writableLength: 0 })
    httpHandler(req, res)
    const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn(), setNoDelay: vi.fn(), writableLength: 0 })
    server.emit('upgrade', { url: '/ws?token=' + lease.token, headers: { 'sec-websocket-key': 'key' } }, socket, Buffer.alloc(0))
    expect(scope.testApi.viewers.size).toBe(2)
    const pending = scope.testApi.queueInput({ kind: 'key', key: 'Enter' }, lease.token)
    now = lease.expiresAt
    await expect(pending).rejects.toThrow('stream_lease_expired')
    expect(scope.testApi.tokenOk(lease.token)).toBe(false)
    const writes = socket.write.mock.calls.length
    scope.testApi.broadcast({ buf: Buffer.from('secret'), b64: 'secret' })
    expect(socket.write.mock.calls.length).toBe(writes)
    expect(res.write).not.toHaveBeenCalled()
    for (const timer of timers.filter(t => t.ms === 30_000)) timer.run()
    expect(res.end).toHaveBeenCalled()
    expect(socket.destroy).toHaveBeenCalled()
    const renewed = mintTakeoverLease('fixture-secret', now)
    expect(scope.testApi.tokenOk(renewed.token)).toBe(true)
  })
})
