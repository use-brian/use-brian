import { HelperTimingEventSchema, HelperTimingSchema, type HelperMethod, type HelperTimingCorrelation, type HelperTimingEvent } from '@use-brian/computer-control/helper-timing.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { posix, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CapabilitiesSchema, ReceiptSchema, DiscoveredTargetSchema, MAX_MESSAGE_BYTES, type NativeCapabilities, type NativeCommand, type NativeGrant, type NativeReceipt, type DiscoveredTarget } from './contracts.js'

export interface NativeHelper {
  capabilities(): Promise<NativeCapabilities>
  listTargets(): Promise<DiscoveredTarget[]>
  start(grant: NativeGrant, leaseId: string): Promise<void>
  beginApproval(command: NativeCommand, leaseId: string): Promise<boolean>
  endApproval(command: NativeCommand, leaseId: string, approved: boolean): Promise<boolean>
  execute(command: NativeCommand, leaseId: string): Promise<NativeReceipt>
  /** Attempts SIGKILL immediately, never queues behind AX. Resolves only after
   * confirmed exit or proven spawn failure, not a failed kill attempt. */
  kill(): Promise<void>
}
/** Trusted main constructor configuration only. Never derive from IPC/grants/env.
 * Default off. Optional requests start only after a validated private v1
 * capabilities advertisement; the initial handshake itself is not timed.
 * Absent support stays absent; malformed/changed support latches off until a
 * new helper process. No negotiation result supplies native authority.
 * Callback is best effort: one scheduled/in-flight invocation, no queue. A hung
 * promise occupies that slot; later events are dropped, not awaited or buffered.
 * Like any in-process callback, synchronous blocking code cannot be preempted.
 */
export type HelperTimingOptions = Readonly<{ enabled: true; onMetadata: (event: HelperTimingEvent) => void | Promise<void> }>
type Pending = { id: string; method: HelperMethod; timingRequested: boolean; correlation?: HelperTimingCorrelation; phase: string; apiPhase?: string;
  resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export type HelperFactory = (onDeath: (reason?: 'takeover') => void) => NativeHelper

export type HelperLaunchSpec = { platform: 'darwin' | 'win32' | 'linux'; executable: string; args: readonly string[] }
export const supportedNativePlatform = (platform: string): platform is HelperLaunchSpec['platform'] =>
  platform === 'darwin' || platform === 'win32' || platform === 'linux'

/** Main-owned session environment only. Never inherit import/library/privilege overrides. */
function launchEnvironment(platform: HelperLaunchSpec['platform']): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin' }
  const keys = platform === 'linux'
    ? ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_SESSION_ID', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE']
    : platform === 'win32' ? ['SystemRoot', 'WINDIR'] : []
  for (const key of keys) if (process.env[key] !== undefined) env[key] = process.env[key]
  return env
}

/** One process, private inherited pipes, length-prefixed JSON; no sockets or reconnect. */
export class PrivatePipeHelper implements NativeHelper {
  private readonly child: ChildProcessWithoutNullStreams
  private buffer: Buffer = Buffer.alloc(0)
  // Pipe/authority revocation is NOT evidence that the OS process has died.
  private dead = false
  private pending?: Pending
  private readonly timingCallback?: HelperTimingOptions['onMetadata']
  private readonly platform: HelperLaunchSpec['platform']
  // Pin the first validated capabilities advertisement for this process. A
  // malformed or changing advertisement disables diagnostics, never authority.
  private diagnosticsSupport: 'unknown' | 'absent' | 'v1' | 'invalid' = 'unknown'
  private timingClock?: { instanceId: string; clockId: string; endUs: number }
  private timingBusy = false
  private timingDropped = 0
  private requestTimedOut = false
  private exitObserved = false
  private exitCode: number | null = null
  private exitSignal: 'SIGKILL' | 'SIGTERM' | 'SIGABRT' | 'SIGSEGV' | 'SIGTRAP' | 'other' | null = null
  private spawnFailed = false
  /** Lifecycle scalars only, for an explicit main-process readiness failure. */
  readinessDiagnostics() {
    return { requestTimedOut: this.requestTimedOut, exitObserved: this.exitObserved,
      exitCode: this.exitCode, exitSignal: this.exitSignal, spawnFailed: this.spawnFailed }
  }
  private readonly exited: Promise<void>
  constructor(launch: string | HelperLaunchSpec, private readonly onDeath: (reason?: 'takeover') => void, private readonly timeoutMs = 4000, timing?: HelperTimingOptions) {
    if (timing?.enabled === true && typeof timing.onMetadata === 'function') this.timingCallback = timing.onMetadata
    // Legacy string form is macOS-only. Specs are created in main, never accepted by IPC.
    const spec: HelperLaunchSpec = typeof launch === 'string' ? { platform: 'darwin', executable: launch, args: [] } : launch
    this.platform = spec.platform
    if (!supportedNativePlatform(process.platform) || spec.platform !== process.platform) throw new Error('Native helper unsupported on this platform')
    const paths = spec.platform === 'win32' ? win32 : posix
    if (!paths.isAbsolute(spec.executable)) throw new Error('Absolute helper path required')
    if (spec.platform === 'linux') {
      if (spec.executable !== '/usr/bin/python3' || spec.args.length !== 2 || spec.args[0] !== '-Es' || !posix.isAbsolute(spec.args[1]) || posix.basename(spec.args[1]) !== 'helper.py') throw new Error('Fixed Linux launch required')
    } else if (spec.args.length) throw new Error('Helper arguments forbidden')
    this.child = spawn(spec.executable, [...spec.args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      cwd: paths.dirname(spec.platform === 'linux' ? spec.args[1] : spec.executable), env: launchEnvironment(spec.platform) })
    // Node assigns PID synchronously on successful spawn, before emitting
    // 'spawn'. An immediate Stop must still wait for exit in that interval.
    let spawned = this.child.pid !== undefined
    this.child.once('spawn', () => { spawned = true })
    this.exited = new Promise(resolve => {
      this.child.once('exit', (code, signal) => {
        this.exitObserved = true
        this.exitCode = Number.isInteger(code) && code! >= 0 && code! <= 255 ? code : null
        this.exitSignal = signal === null ? null : signal === 'SIGKILL' || signal === 'SIGTERM' || signal === 'SIGABRT' || signal === 'SIGSEGV' || signal === 'SIGTRAP'
          ? signal : 'other'
        resolve(); this.fail(code === 73 ? 'takeover' : undefined)
      })
      // 'error' also covers failed kill (e.g. EPERM), not just spawn failure.
      // Keep listening: repeated errors must neither release the lease nor
      // become unhandled EventEmitter errors after the first revocation.
      this.child.on('error', () => {
        if (!spawned && this.child.pid === undefined) { this.spawnFailed = true; resolve() }
        this.fail()
      })
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    this.child.stdin.on('error', () => this.fail())
    this.child.stdout.on('error', () => this.fail())
    // Never log potentially sensitive helper output; drain stderr to prevent deadlock.
    this.child.stderr.resume()
  }
  private fail(reason?: 'takeover'): void {
    if (this.dead) return
    this.dead = true
    if (this.pending) { this.reportTiming(this.pending, undefined, true); clearTimeout(this.pending.timer); this.pending.reject(new Error('Native helper unavailable')); this.pending = undefined }
    this.buffer = Buffer.alloc(0)
    // Independent revocation: do not flush queued commands with end(), and do
    // not rely on SIGKILL succeeding. Helpers poll both private peer endpoints.
    // Stream closure is NOT process death and never resolves this.exited.
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    // false, an 'error' event, or a throw all leave process death unconfirmed.
    // Revoke once even if kill throws; never retry an uncertain kill here.
    try { this.child.kill('SIGKILL') } catch { /* Retain the exit barrier. */ }
    this.onDeath(reason)
  }
  private receive(chunk: Buffer): void {
    if (this.dead) return
    if (this.buffer.length + chunk.length > MAX_MESSAGE_BYTES + 4) { this.fail(); return }
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length < 4) return
    const size = this.buffer.readUInt32BE(0)
    if (size === 0 || size > MAX_MESSAGE_BYTES) { this.fail(); return }
    if (this.buffer.length < size + 4) return
    try {
      const response = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8')) as { id?: unknown; ok?: unknown; result?: unknown; diagnostics?: unknown; diagnosticsVersion?: unknown }
      if (!this.pending || response.id !== this.pending.id || response.ok !== true || this.buffer.length !== size + 4) throw new Error('Invalid helper response')
      const pending = this.pending
      this.negotiateDiagnostics(pending, response.result, response.diagnosticsVersion)
      this.pending = undefined
      this.buffer = Buffer.alloc(0)
      clearTimeout(pending.timer)
      pending.resolve(response.result)
      this.reportTiming(pending, response.diagnostics, false, response.result)
    } catch { this.fail() }
  }
  private negotiateDiagnostics(pending: Pending, result: unknown, version: unknown): void {
    if (this.diagnosticsSupport === 'invalid') return
    if (pending.method !== 'capabilities') {
      // Only capabilities may negotiate. No alternate-method advertisement can
      // manufacture support, even if its scalar happens to be the known version.
      if (version !== undefined) this.diagnosticsSupport = 'invalid'
      return
    }
    const capabilities = CapabilitiesSchema.safeParse(result)
    if (!capabilities.success || capabilities.data.platform !== this.platform || (version !== undefined && version !== 1)) {
      this.diagnosticsSupport = 'invalid'
      return
    }
    const support = version === 1 ? 'v1' : 'absent'
    if (this.diagnosticsSupport !== 'unknown' && this.diagnosticsSupport !== support) {
      this.diagnosticsSupport = 'invalid'
    } else {
      this.diagnosticsSupport = support
    }
    // Do not reset the source clock here: repeated capability handshakes are
    // not permission to accept a new helper instance/domain or backwards time.
  }
  private reportTiming(pending: Pending, raw: unknown, lost = false, result?: unknown): void {
    if (!this.timingCallback) return
    const invalidNegotiation = this.diagnosticsSupport === 'invalid'
    if (!pending.timingRequested) raw = undefined // captured when the private request was serialized
    // Reject oversized span lists before Zod walks their elements. The enclosing
    // private frame already has its independent fixed byte bound.
    const spans = (raw as { spans?: unknown } | null)?.spans
    const bounded = Array.isArray(spans) && spans.length >= 1 && spans.length <= 2
    const parsed = HelperTimingSchema.safeParse(bounded ? raw : undefined)
    const timing = parsed.success ? parsed.data : undefined
    const clock = this.timingClock
    const semanticReturned = pending.apiPhase && (result as { outcome?: unknown } | null)?.outcome === 'executed'
    const valid = !lost && !invalidNegotiation && timing && timing.requestId === pending.id && timing.method === pending.method
      && timing.spans[0].phase === pending.phase
      && (!semanticReturned || timing.spans.length === 2)
      && (!timing.spans[1] || timing.spans[1].phase === pending.apiPhase)
      && (!clock || (timing.instanceId === clock.instanceId && timing.clockId === clock.clockId && timing.spans[0].startUs >= clock.endUs))
    const base = { requestId: pending.id, method: pending.method, correlation: pending.correlation }
    let event: HelperTimingEvent
    if (valid) {
      this.timingClock = { instanceId: timing.instanceId, clockId: timing.clockId, endUs: timing.spans[0].endUs }
      const frozen = Object.freeze({ ...timing, spans: Object.freeze(timing.spans.map(span => Object.freeze({ ...span }))) })
      event = Object.freeze({ ...base, droppedBefore: this.timingDropped, state: 'complete', timing: frozen })
    } else {
      event = Object.freeze({ ...base, droppedBefore: this.timingDropped, state: 'incomplete', reason: lost ? 'lost_response' : invalidNegotiation ? 'invalid' : raw === undefined ? 'absent' : 'invalid' })
    }
    // Validate the locally constructed, frozen envelope only (never caller
    // objects). Invalid correlation must not escape or affect helper outcomes.
    // Count omission rather than stripping identity or rebinding late events.
    if (!HelperTimingEventSchema.safeParse(event).success) {
      this.timingDropped = Math.min(65535, this.timingDropped + 1)
      return
    }
    if (this.timingBusy) { this.timingDropped = Math.min(65535, this.timingDropped + 1); return }
    this.timingDropped = 0
    this.timingBusy = true
    // Never run inside response processing, execution, or Stop. No timeout retry
    // of a hung callback (which would accumulate unbounded outstanding promises).
    setImmediate(() => {
      try {
        void Promise.resolve(this.timingCallback!(event)).catch(() => {}).finally(() => { this.timingBusy = false })
      } catch { this.timingBusy = false }
    })
  }
  private request(method: HelperMethod, payload: unknown): Promise<unknown> {
    if (this.dead || this.pending) return Promise.reject(new Error('Helper unavailable or busy'))
    const id = randomUUID()
    // Capture primitives before any await/callback. No target/value/goal/ref or
    // helper-supplied identity enters diagnostic correlation.
    const p = payload as { command?: NativeCommand; grant?: NativeGrant }
    const authority = p.command ?? p.grant
    const correlation = authority ? Object.freeze({ sessionId: authority.identity.sessionId, epoch: authority.epoch,
      ...(p.command ? { commandId: p.command.commandId } : {}) }) : undefined
    const kind = method === 'execute' ? p.command?.action.kind : undefined
    const phase = kind === 'observe' ? 'observe_request' : kind === 'capture' ? 'capture_request' : 'request'
    const apiPhase = kind && ({ setValue: 'api_set_value', invoke: 'api_invoke', select: 'api_select', scroll: 'api_scroll' } as Record<string, string>)[kind]
    const timingRequested = !!this.timingCallback && this.diagnosticsSupport === 'v1'
    const body = Buffer.from(JSON.stringify({ id, method, payload, ...(timingRequested ? { diagnostics: true } : {}) }))
    if (body.length > MAX_MESSAGE_BYTES) return Promise.reject(new Error('Helper request too large'))
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requestTimedOut = true; this.fail() }, this.timeoutMs)
      this.pending = { id, method, timingRequested, correlation, phase, apiPhase, resolve, reject, timer }
      this.child.stdin.write(Buffer.concat([header, body]), error => { if (error) this.fail() })
    })
  }
  async capabilities(): Promise<NativeCapabilities> { return CapabilitiesSchema.parse(await this.request('capabilities', {})) }
  async listTargets(): Promise<DiscoveredTarget[]> { return DiscoveredTargetSchema.array().max(128).parse(await this.request('listTargets', {})) }
  async start(grant: NativeGrant, leaseId: string): Promise<void> {
    if (await this.request('start', { grant, leaseId }) !== true) throw new Error('Helper refused grant')
  }
  async beginApproval(command: NativeCommand, leaseId: string): Promise<boolean> {
    return await this.request('beginApproval', { command, leaseId }) === true
  }
  async endApproval(command: NativeCommand, leaseId: string, approved: boolean): Promise<boolean> {
    return await this.request('endApproval', { command, leaseId, approved }) === true
  }
  async execute(command: NativeCommand, leaseId: string): Promise<NativeReceipt> {
    return ReceiptSchema.parse(await this.request('execute', { command, leaseId }))
  }
  kill(): Promise<void> { this.fail(); return this.exited }
}
