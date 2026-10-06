import { freezeBinding } from './visual-approval.js'
import { ClickGuardianClient, type GuardianHandoff, type NativeClickScope } from './click-guardian-client.js'
import { isDeepStrictEqual } from 'node:util'
import type { Duplex } from 'node:stream'
import { HelperTimingEventSchema, HelperTimingSchema, type HelperMethod, type HelperTimingCorrelation, type HelperTimingEvent } from '@use-brian/computer-control/helper-timing.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { posix, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CapabilitiesSchema, ReceiptSchema, DiscoveredTargetSchema, MAX_MESSAGE_BYTES, type NativeVisualApproval, type NativeCapabilities, type NativeCommand, type NativeGrant, type NativeReceipt, type DiscoveredTarget } from './contracts.js'

export interface NativeHelper {
  capabilities(): Promise<NativeCapabilities>
  listTargets(): Promise<DiscoveredTarget[]>
  start(grant: NativeGrant, leaseId: string): Promise<void>
  beginApproval(command: NativeCommand, leaseId: string): Promise<boolean | NativeVisualApproval>
  endApproval(command: NativeCommand, leaseId: string, approved: boolean, bindingId?: string): Promise<boolean>
  execute(command: NativeCommand, leaseId: string): Promise<NativeReceipt>
  /** Attempts SIGKILL immediately, never queues behind AX. Resolves only after
   * confirmed worker exit/spawn failure AND owner safety, never a failed kill
   * attempt, uncertain cleanup, process death alone after emission, or timeout. */
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
const discoveryCount = z.number().int().min(0).max(65535)
const DiscoveryDiagnosticsSchema = z.object({ version: z.literal(1), processes: discoveryCount, fenceRejected: discoveryCount,
  unsupportedProcess: discoveryCount, parentRejected: discoveryCount, signatureRejected: discoveryCount, admitted: discoveryCount,
  windowListRejected: discoveryCount, boundsRejected: discoveryCount, scopeRejected: discoveryCount, fenceChanged: discoveryCount,
  targets: discoveryCount, axCannotComplete: discoveryCount, axApiDisabled: discoveryCount, axInvalidElement: discoveryCount, axOtherError: discoveryCount }).strict()
type LifecycleCause = 'stop' | 'exit' | 'process_error' | 'stdin_error' | 'stdout_error' | 'write_error' | 'timeout' | 'invalid_response' | 'guardian'
export type HelperDiagnosticsOptions = Readonly<{
  onDiscovery?: (metadata: Readonly<z.infer<typeof DiscoveryDiagnosticsSchema>>) => void
  onExit?: (metadata: ReturnType<PrivatePipeHelper['lifecycleDiagnostics']>) => void
}>
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
  private firstRequest = true
  private lastRequestMethod: HelperMethod | null = null
  private lastRequestStarted = 0
  private revocationCause: LifecycleCause | null = null
  /** Lifecycle scalars only, for an explicit main-process readiness failure. */
  readinessDiagnostics() {
    return { requestTimedOut: this.requestTimedOut, exitObserved: this.exitObserved,
      exitCode: this.exitCode, exitSignal: this.exitSignal, spawnFailed: this.spawnFailed }
  }
  /** Fixed lifecycle metadata only; main never reads helper stderr/payloads. */
  lifecycleDiagnostics() {
    return { ...this.readinessDiagnostics(), cause: this.revocationCause, method: this.lastRequestMethod,
      elapsedMs: this.lastRequestMethod ? Math.min(60_000, Math.max(0, Math.round(performance.now() - this.lastRequestStarted))) : 0 }
  }
  private readonly exited: Promise<void>
  private readonly guardian?: ClickGuardianClient
  private killed?: Promise<void>
  private grantSnapshot?: { grant: NativeGrant; leaseId: string }
  private approvedSnapshot?: { command: NativeCommand; leaseId: string }
  private visualApproval?: { command: NativeCommand; leaseId: string; binding: NativeVisualApproval }
  private clickSpent = false
  private readbackOnly = false
  private executeSnapshot?: { id: string; command: NativeCommand; leaseId: string }
  private bindGuardian(id: string, descriptor: NativeClickScope): GuardianHandoff | undefined {
    const execute = this.executeSnapshot
    if (this.dead || this.pending?.method !== 'execute' || this.pending.id !== id || execute?.id !== id
      || execute.command.action.kind !== 'click') throw new Error('Unbound guardian handoff')
    const scope = this.grantSnapshot
    const approved = this.approvedSnapshot
    this.approvedSnapshot = undefined // burn before handoff; never retry
    if (!scope || !approved || execute.leaseId !== scope.leaseId || approved.leaseId !== scope.leaseId
      || !isDeepStrictEqual(execute.command, approved.command)
      || !isDeepStrictEqual(descriptor.command, approved.command)
      || !isDeepStrictEqual(execute.command.identity, scope.grant.identity)
      || execute.command.epoch !== scope.grant.epoch || execute.command.grantId !== scope.grant.grantId
      || !scope.grant.allowControl || !scope.grant.allowCapture
      || Date.now() >= scope.grant.expiresAt || Date.now() >= execute.command.deadlineAt
      || !scope.grant.targets.some(target => isDeepStrictEqual(target, execute.command.action.target))) return undefined
    if (this.clickSpent) return undefined
    this.clickSpent = true
    return { requestId: id, command: execute.command, grant: scope.grant, leaseId: scope.leaseId, descriptor }
  }
  constructor(launch: string | HelperLaunchSpec, private readonly onDeath: (reason?: 'takeover') => void, private readonly timeoutMs?: number, timing?: HelperTimingOptions, private readonly diagnostics?: HelperDiagnosticsOptions) {
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
    this.child = spawn(spec.executable, [...spec.args], { stdio: spec.platform === 'darwin' ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      cwd: paths.dirname(spec.platform === 'linux' ? spec.args[1] : spec.executable), env: launchEnvironment(spec.platform) }) as ChildProcessWithoutNullStreams
    if (spec.platform === 'darwin') this.guardian = new ClickGuardianClient(spec.executable, this.child.pid,
      this.child.stdio?.[3] as Duplex | undefined, (id, descriptor) => this.bindGuardian(id, descriptor), () => this.fail(undefined, 'guardian'),
      id => !this.dead && this.pending?.id === id && this.pending.method === 'execute' && this.executeSnapshot?.id === id)
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
        resolve(); this.fail(code === 73 ? 'takeover' : undefined, 'exit')
        const metadata = Object.freeze(this.lifecycleDiagnostics())
        setImmediate(() => { try { this.diagnostics?.onExit?.(metadata) } catch { /* Diagnostic only. */ } })
      })
      // 'error' also covers failed kill (e.g. EPERM), not just spawn failure.
      // Keep listening: repeated errors must neither release the lease nor
      // become unhandled EventEmitter errors after the first revocation.
      this.child.on('error', () => {
        if (!spawned && this.child.pid === undefined) { this.spawnFailed = true; resolve() }
        this.fail(undefined, 'process_error')
      })
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    this.child.stdin.on('error', () => this.fail(undefined, 'stdin_error'))
    this.child.stdout.on('error', () => this.fail(undefined, 'stdout_error'))
    // Never log potentially sensitive helper output; drain stderr to prevent deadlock.
    this.child.stderr.resume()
  }
  private fail(reason?: 'takeover', cause: LifecycleCause = 'stop'): void {
    if (this.dead) return
    this.revocationCause = cause
    this.dead = true
    this.visualApproval = undefined
    this.guardian?.revoke()
    this.approvedSnapshot = undefined
    this.executeSnapshot = undefined
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
    if (this.buffer.length + chunk.length > MAX_MESSAGE_BYTES + 4) { this.fail(undefined, 'invalid_response'); return }
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length < 4) return
    const size = this.buffer.readUInt32BE(0)
    if (size === 0 || size > MAX_MESSAGE_BYTES) { this.fail(undefined, 'invalid_response'); return }
    if (this.buffer.length < size + 4) return
    try {
      const response = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8')) as { id?: unknown; ok?: unknown; result?: unknown; diagnostics?: unknown; diagnosticsVersion?: unknown; discoveryDiagnostics?: unknown }
      if (!this.pending || response.id !== this.pending.id || response.ok !== true || this.buffer.length !== size + 4) throw new Error('Invalid helper response')
      const pending = this.pending
      if (this.guardian && !this.guardian.acceptsWorkerResponse(pending.id)) throw new Error('Premature worker response')
      if (pending.method === 'execute' && this.executeSnapshot?.command.action.kind === 'click') {
        const result = response.result as { outcome?: unknown; commandId?: unknown; code?: unknown } | null
        if (result?.outcome === 'executed') {
          if (Object.keys(result).length !== 3 || result.code !== 'ok' || result.commandId !== this.executeSnapshot.command.commandId
            || !this.guardian?.acceptsExecutedClick(pending.id, this.executeSnapshot.command.commandId)) throw new Error('Unproven click delivery')
          this.readbackOnly = true
        }
      }
      this.negotiateDiagnostics(pending, response.result, response.diagnosticsVersion)
      this.pending = undefined
      this.executeSnapshot = undefined
      if (pending.method === 'execute') this.approvedSnapshot = undefined
      this.buffer = Buffer.alloc(0)
      clearTimeout(pending.timer)
      pending.resolve(response.result)
      this.reportTiming(pending, response.diagnostics, false, response.result)
      // Extra private metadata can never invalidate or authorize an operation.
      // Validate the result first; reject unknown fields and wrong method/platform.
      if (this.platform === 'darwin' && pending.method === 'listTargets' && this.diagnostics?.onDiscovery
        && DiscoveredTargetSchema.array().max(128).safeParse(response.result).success) {
        const parsed = DiscoveryDiagnosticsSchema.safeParse(response.discoveryDiagnostics)
        if (parsed.success) {
          const metadata = Object.freeze(parsed.data)
          setImmediate(() => { try { this.diagnostics?.onDiscovery?.(metadata) } catch { /* Diagnostic only. */ } })
        }
      }
    } catch { this.fail(undefined, 'invalid_response') }
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
    // Detach authority from mutable caller objects before serialization/await.
    payload = JSON.parse(JSON.stringify(payload)) as unknown
    const p = payload as { command?: NativeCommand; grant?: NativeGrant; leaseId?: string }
    if (this.clickSpent && (method === 'start' || method === 'beginApproval' || method === 'endApproval'
      || (method === 'execute' && (!this.readbackOnly || !p.command || !['observe', 'capture'].includes(p.command.action.kind))))) {
      return Promise.reject(new Error('Click grant effects are spent; readback only'))
    }
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
    // The Mac collector alone allows five seconds, plus signature validation
    // before/after collection. Do not cut its first metadata handshake off at
    // the ordinary four-second action deadline. Stop remains immediate.
    // Discovery also revalidates the signed parent and lazily initializes AX.
    // It carries no grant/action authority; action RPC deadlines stay unchanged.
    const setupRequest = method === 'listTargets' || this.firstRequest && method === 'capabilities'
    const timeoutMs = this.timeoutMs ?? (this.platform === 'darwin' && setupRequest ? 15_000 : 4000)
    this.firstRequest = false
    this.lastRequestMethod = method
    this.lastRequestStarted = performance.now()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requestTimedOut = true; this.fail(undefined, 'timeout') }, timeoutMs)
      this.pending = { id, method, timingRequested, correlation, phase, apiPhase, resolve, reject, timer }
      this.executeSnapshot = method === 'execute' && p.command && p.leaseId
        ? { id, command: p.command, leaseId: p.leaseId } : undefined
      this.child.stdin.write(Buffer.concat([header, body]), error => { if (error) this.fail(undefined, 'write_error') })
    })
  }
  async capabilities(): Promise<NativeCapabilities> { return CapabilitiesSchema.parse(await this.request('capabilities', {})) }
  async listTargets(): Promise<DiscoveredTarget[]> { return DiscoveredTargetSchema.array().max(128).parse(await this.request('listTargets', {})) }
  async start(grant: NativeGrant, leaseId: string): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify({ grant, leaseId })) as { grant: NativeGrant; leaseId: string }
    if (await this.request('start', snapshot) !== true) throw new Error('Helper refused grant')
    if (!this.dead) this.grantSnapshot = snapshot
  }
  async beginApproval(command: NativeCommand, leaseId: string): Promise<boolean | NativeVisualApproval> {
    this.approvedSnapshot = undefined
    this.visualApproval = undefined
    const snapshot = structuredClone(command)
    const result = await this.request('beginApproval', { command: snapshot, leaseId })
    if (this.dead) throw new Error('Approval revoked')
    if (snapshot.action.kind !== 'visualInvoke') {
      if (typeof result !== 'boolean') throw new Error('Invalid legacy approval')
      return result
    }
    if (result === false) return false
    const binding = freezeBinding(result, snapshot)
    this.visualApproval = { command: snapshot, leaseId, binding }
    return binding
  }
  async endApproval(command: NativeCommand, leaseId: string, approved: boolean, bindingId?: string): Promise<boolean> {
    this.approvedSnapshot = undefined
    const visual = this.visualApproval
    this.visualApproval = undefined
    const snapshot = structuredClone({ command, leaseId })
    if (command.action.kind === 'visualInvoke') {
      if (!visual || visual.leaseId !== leaseId || visual.binding.bindingId !== bindingId ||
        !isDeepStrictEqual(visual.command, snapshot.command)) throw new Error('Visual approval mismatch')
    } else if (bindingId !== undefined) throw new Error('Unexpected binding')
    const result = await this.request('endApproval', { ...snapshot, approved, ...(bindingId === undefined ? {} : { bindingId }) })
    if (typeof result !== 'boolean') throw new Error('Invalid approval result')
    if (result && approved && !this.dead) this.approvedSnapshot = snapshot
    return result && !this.dead
  }
  async execute(command: NativeCommand, leaseId: string): Promise<NativeReceipt> {
    if (command.action.kind === 'visualInvoke') {
      const approved = this.approvedSnapshot
      this.approvedSnapshot = undefined
      if (!approved || approved.leaseId !== leaseId || !isDeepStrictEqual(approved.command, command)) throw new Error('Visual dispatch not approved')
    }
    return ReceiptSchema.parse(await this.request('execute', { command, leaseId }))
  }
  kill(): Promise<void> {
    this.fail()
    // Worker death alone is insufficient when a surviving owner may have emitted.
    return this.killed ??= Promise.all([this.exited, this.guardian?.waitForSafety() ?? Promise.resolve()]).then(() => {})
  }
}
