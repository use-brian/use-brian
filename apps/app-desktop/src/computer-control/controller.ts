import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { CapabilitiesSchema, CommandSchema, GrantSchema, ReceiptSchema, DiscoveredTargetSchema, NATIVE_PROTOCOL, MAX_SESSION_MS, sameIdentity, sameTarget, type NativeObservation, type NativeCapabilities, type NativeCommand, type NativeGrant, type NativeReceipt, type NativeStatus, type DiscoveredTarget } from './contracts.js'
import { NativeBrokerTrace, type NativeBrokerObserverFactory, type NativeTraceCommand, type NativeTraceMetadata } from './trace.js'
import type { DeviceLease } from './lease.js'
import { supportedNativePlatform, type HelperFactory, type NativeHelper } from './helper-client.js'

/** Main-only projection of validated helper data; never supplied by the model or relay. */
export type NativeApprovalObservation = Pick<NativeObservation, 'identity' | 'epoch' | 'target'> & {
  observationId: string
  nodes: ReadonlyArray<Readonly<Pick<NativeObservation['nodes'][number], 'ref' | 'parentRef' | 'name' | 'role' | 'bounds'>>>
}
export type NativeApprovalContext = Readonly<NativeApprovalObservation & { commandId: string; grantId: string }>

/** Private main-to-indicator metadata, never part of the wire status. */
/** Local renderer projection only. No scope credentials, frames or action authority. */
export type NativeInspection = Pick<NativeObservation, 'id' | 'capturedAt' | 'completeness'> & {
  nodes: Array<Pick<NativeObservation['nodes'][number], 'ref' | 'parentRef' | 'role' | 'name' | 'value' | 'enabled' | 'sensitive'>>
}

export type NativeActivity = Readonly<{ appId: string; perception: 'ax' | 'vision' }>

export interface NativeControllerOptions {
  /** Optional metadata-only observer, installed exclusively by trusted main. */
  observerFactory?: NativeBrokerObserverFactory
  enabled: boolean
  /** Trusted main rollout ceiling: discovery/inspection only, regardless of helper support. */
  observationOnly?: boolean
  /** Must only become true after independent shortcut/menu Stop AND takeover/lock hooks installed. */
  safetyControlsReady: () => boolean
  helperFactory: HelperFactory
  lease: DeviceLease
  /** Main-process local dialog only; never fulfill from a relay/model request. */
  approveGrant: (grant: Readonly<NativeGrant>, signal: AbortSignal) => Promise<boolean>
  /** All side effects require local approval. Display exact target/action/text and unknown effect warning. */
  approveAction: (command: Readonly<NativeCommand>, signal: AbortSignal, context?: NativeApprovalContext) => Promise<boolean>
  /** Main-only fresh API authority; absence fails closed for all remote commands. */
  revalidateExecution?: (command: Readonly<NativeCommand>, signal: AbortSignal) => Promise<boolean>
  onStatus?: (status: NativeStatus) => void
  /** Trusted main only: validated dispatch metadata, or null on revocation/new grant. */
  onActivity?: (activity: NativeActivity | null) => void
  platform?: NodeJS.Platform
}
const unsupported = (platform: string): NativeCapabilities => ({ protocol: NATIVE_PROTOCOL, platform: platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'unsupported', axRead: false, semanticActions: false, windowCapture: false, input: false, accessibilityPermission: 'unknown', capturePermission: 'unknown', limitations: ['Disabled until platform acceptance, local safety controls and helper permissions are ready.'] })
const receipt = (commandId: string, code: NativeReceipt['code'], outcome: NativeReceipt['outcome'] = 'not_executed'): NativeReceipt => ({ commandId, code, outcome })
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) }
  return value
}

export class NativeComputerController {
  private trace?: NativeBrokerTrace
  private inspectionClaimed = false
  private approvalObservation?: NativeApprovalObservation
  private caps: NativeCapabilities
  private state: NativeStatus['state'] = 'unavailable'
  private epoch = 0
  private grant?: NativeGrant
  private helper?: NativeHelper
  private leaseId?: string
  private expiry?: NodeJS.Timeout
  private monotonicExpiry = 0
  private abort = new AbortController()
  private tail: Promise<unknown> = Promise.resolve()
  private shutdown: Promise<void> = Promise.resolve()
  private starting = false
  private disposed = false
  private journal = new Map<string, { digest: string; result: Promise<NativeReceipt> }>()
  constructor(private readonly options: NativeControllerOptions) { this.caps = unsupported(options.platform ?? process.platform) }
  status(): NativeStatus {
    return structuredClone({ protocol: NATIVE_PROTOCOL, state: this.state, epoch: this.epoch, capabilities: this.caps, ...(this.grant ? { identity: this.grant.identity, expiresAt: this.grant.expiresAt } : {}) })
  }
  private changed(): void { try { this.options.onStatus?.(this.status()) } catch { /* UI callbacks cannot bypass revocation */ } }
  private activity(value: NativeActivity | null): void {
    try { this.options.onActivity?.(value && Object.freeze(value)) } catch { /* UI cannot bypass safety */ }
  }
  private available(): boolean { return !this.disposed && this.options.enabled && supportedNativePlatform(this.options.platform ?? process.platform) && this.options.safetyControlsReady() }
  private getHelper(): NativeHelper {
    if (!this.available() || this.abort.signal.aborted) throw new Error('Native control unavailable or stopped')
    return this.helper ??= this.options.helperFactory(reason => { if (reason === 'takeover') this.userTakeover(); else void this.stop() })
  }
  private validateCapabilities(value: NativeCapabilities): NativeCapabilities {
    const caps = CapabilitiesSchema.parse(value)
    if (caps.platform !== (this.options.platform ?? process.platform)) throw new Error('Helper platform mismatch')
    return this.options.observationOnly ? { ...caps, semanticActions: false, windowCapture: false, input: false } : caps
  }
  /** Helper reports may remove authority, never restore it within a grant. */
  private reduceCapabilities(next: NativeCapabilities): NativeCapabilities {
    const previous = this.caps
    return { ...next,
      axRead: previous.axRead && next.axRead && next.accessibilityPermission === 'granted',
      semanticActions: previous.semanticActions && next.semanticActions && next.accessibilityPermission === 'granted',
      windowCapture: previous.windowCapture && next.windowCapture && next.capturePermission === 'granted',
      input: previous.input && next.input && next.accessibilityPermission === 'granted',
      accessibilityPermission: previous.accessibilityPermission === 'granted' ? next.accessibilityPermission : previous.accessibilityPermission,
      capturePermission: previous.capturePermission === 'granted' ? next.capturePermission : previous.capturePermission,
    }
  }
  async capabilities(): Promise<NativeCapabilities> {
    const signal = this.abort.signal
    const grant = this.grant
    const starting = this.starting
    if (!this.available() || signal.aborted) return structuredClone(this.caps)
    try {
      const caps = this.validateCapabilities(await this.getHelper().capabilities())
      // A late discovery/old-account response must not overwrite a new session.
      if (signal.aborted || signal !== this.abort.signal || grant !== this.grant || starting !== this.starting) return structuredClone(this.caps)
      this.caps = grant ? this.reduceCapabilities(caps) : caps
      if (!grant) this.state = this.caps.axRead && this.caps.accessibilityPermission === 'granted' ? 'ready' : 'permission_required'
      this.changed()
    } catch { if (signal === this.abort.signal && !signal.aborted) await this.stop() }
    return structuredClone(this.caps)
  }
  async listTargets(): Promise<DiscoveredTarget[]> {
    if (this.grant || this.starting) throw new Error('Cannot change selection during a session')
    try { return DiscoveredTargetSchema.array().max(128).parse(await this.getHelper().listTargets()) }
    catch { await this.stop(); return [] }
  }
  /** Caller is trusted local main UI. This method still requires a fresh local consent dialog. */
  async start(input: NativeGrant): Promise<NativeStatus> {
    const grant = frozen(GrantSchema.parse(input))
    // Independent of advertised capabilities and the UI gate; never send forbidden authority to a helper.
    if (this.options.observationOnly && (grant.allowControl || grant.allowCapture)) throw new Error('Observation-only capability ceiling')
    if (!this.available() || this.abort.signal.aborted || this.starting || this.grant) throw new Error('Local Resume required or device busy')
    if (grant.epoch <= this.epoch || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + MAX_SESSION_MS) throw new Error('Invalid local grant lifetime/epoch')
    this.trace = NativeBrokerTrace.create(this.options.observerFactory, { sessionId: grant.identity.sessionId, epoch: grant.epoch })
    const trace = this.trace
    this.starting = true
    this.activity(null)
    const signal = this.abort.signal
    let acquired = false
    try {
      await this.shutdown
      if (signal.aborted) throw new Error('Stopped')
      await this.options.lease.acquire(); acquired = true
      if (signal.aborted) throw new Error('Stopped')
      this.leaseId = randomUUID()
      this.state = 'awaiting_local_consent'; this.changed()
      if (!await this.traceWait(trace, 'approval_wait', 'grant', () => this.until(this.options.approveGrant(grant, signal), signal, grant.expiresAt), signal)) throw new Error('Local consent denied')
      if (signal.aborted || !this.available()) throw new Error('Stopped')
      const helper = this.getHelper()
      const caps = this.validateCapabilities(await this.helperWait(trace, 'capabilities', () => helper.capabilities(), signal))
      if (signal.aborted || signal !== this.abort.signal) throw new Error('Stopped')
      this.caps = caps
      if (signal.aborted || !this.caps.axRead || this.caps.accessibilityPermission !== 'granted' || (grant.allowControl && !this.caps.semanticActions) || (grant.allowCapture && !this.caps.windowCapture)) throw new Error('Permissions/capabilities missing')
      await this.helperWait(trace, 'start', () => helper.start(grant, this.leaseId!), signal)
      if (signal.aborted || grant.expiresAt <= Date.now()) throw new Error('Stopped/expired')
      this.grant = grant; this.epoch = grant.epoch
      this.monotonicExpiry = performance.now() + grant.expiresAt - Date.now()
      this.expiry = setTimeout(() => { void this.stop() }, grant.expiresAt - Date.now())
      this.state = 'active'; this.changed()
      return this.status()
    } catch (error) {
      await this.stop()
      if (acquired) await this.options.lease.release()
      throw error
    } finally { this.starting = false }
  }
  /** ONLY expose through trusted local UI, never relay. New consent, helper, epoch and observations. */
  async resume(grant: NativeGrant): Promise<NativeStatus> {
    if (this.disposed || this.starting || (this.state !== 'stopped' && this.state !== 'paused_for_user')) throw new Error('Not locally resumable')
    await this.shutdown
    if (grant.epoch <= this.epoch) throw new Error('Resume requires a new epoch')
    this.abort = new AbortController()
    this.grant = undefined
    this.approvalObservation = undefined
    this.inspectionClaimed = false
    this.journal.clear()
    this.tail = Promise.resolve()
    return this.start(grant)
  }
  /** One main-created AX read of the sole selected target. Never callable with renderer scope. */
  async inspectSelected(): Promise<NativeInspection> {
    const grant = this.grant
    const signal = this.abort.signal
    if (!grant || grant.allowControl || grant.targets.length !== 1 || this.state !== 'active' || signal.aborted || this.inspectionClaimed) throw new Error('Read-only session required')
    this.inspectionClaimed = true
    const command: NativeCommand = { protocol: NATIVE_PROTOCOL, identity: grant.identity, grantId: grant.grantId,
      epoch: grant.epoch, commandId: randomUUID(), deadlineAt: Math.min(grant.expiresAt, Date.now() + 30_000),
      action: { kind: 'observe', target: grant.targets[0] } }
    const result = await this.enqueue(command)
    if (signal.aborted || this.grant !== grant || this.permitted(command) || this.state !== 'active' || result.code !== 'ok' || !result.observation) throw new Error('Inspection revoked or unavailable')
    const observation = result.observation
    return { id: observation.id, capturedAt: observation.capturedAt, completeness: observation.completeness,
      nodes: observation.nodes.slice(0, 500).map(node => ({ ref: node.ref,
        ...(node.parentRef === undefined ? {} : { parentRef: node.parentRef }), role: node.role,
        name: node.sensitive ? '' : node.name, ...(!node.sensitive && node.value !== undefined ? { value: node.value } : {}),
        enabled: node.enabled, sensitive: node.sensitive })) }
  }
  private permitted(command: NativeCommand): NativeReceipt['code'] | undefined {
    const started = performance.now()
    const denial = this.permission(command)
    this.commandTrace(command)?.record({ event: 'authority_check', operation: 'local', outcome: denial ? 'denied' : 'resolved', durationMs: performance.now() - started, command: this.traceCommand(command) })
    return denial
  }
  private permission(command: NativeCommand): NativeReceipt['code'] | undefined {
    const grant = this.grant
    if (this.abort.signal.aborted || !grant || !this.available()) return 'stopped'
    if (Date.now() >= grant.expiresAt || performance.now() >= this.monotonicExpiry || Date.now() >= command.deadlineAt) return 'expired'
    if (!sameIdentity(grant.identity, command.identity) || grant.grantId !== command.grantId || grant.epoch !== command.epoch) return 'denied'
    if (!grant.targets.some(target => sameTarget(target, command.action.target))) return 'wrong_target'
    if (command.action.kind === 'capture') return grant.allowCapture && this.caps.windowCapture ? undefined : 'unsupported'
    if (command.action.kind !== 'observe' && !grant.allowControl) return 'denied'
    if (command.action.kind === 'click' && !grant.allowCapture) return 'denied'
    if ((command.action.kind === 'click' || command.action.kind === 'key') && !this.caps.input) return 'unsupported'
    if (command.action.kind === 'observe' && !this.caps.axRead) return 'unsupported'
    if (!['observe', 'capture', 'click', 'key'].includes(command.action.kind) && !this.caps.semanticActions) return 'unsupported'
    return undefined
  }
  /** Relay authority is control-only. allowControl=false means local inspector, never a remote model read. */
  execute(input: NativeCommand): Promise<NativeReceipt> {
    const command = CommandSchema.parse(input)
    // Before journal lookup: even a guessed in-flight inspector command ID cannot retrieve AX.
    if (this.grant && !this.grant.allowControl) { this.admission(command, 'denied'); return Promise.resolve(receipt(command.commandId, 'denied')) }
    return this.enqueue(command)
  }
  private enqueue(input: NativeCommand): Promise<NativeReceipt> {
    const command = frozen(CommandSchema.parse(input))
    const digest = createHash('sha256').update(JSON.stringify(command)).digest('hex')
    const old = this.journal.get(command.commandId)
    // Identity invalidation discards the grant, not the ambiguity/replay fence.
    // Exact old commands may retrieve metadata only, never retained AX or frames.
    if (old && !this.grant && this.abort.signal.aborted && old.digest === digest) return old.result.then(({ commandId, outcome, code }) => ({ commandId, outcome, code }))
    if (old && this.grant && sameIdentity(this.grant.identity, command.identity) && this.grant.grantId === command.grantId && this.grant.epoch === command.epoch) {
      this.admission(command, old.digest === digest ? 'replayed' : 'denied')
      return old.digest === digest ? old.result.then(value => structuredClone(value)) : Promise.resolve(receipt(command.commandId, 'denied'))
    }
    const denial = this.permitted(command)
    if (denial) { this.admission(command, 'denied'); return Promise.resolve(receipt(command.commandId, denial)) }
    // Never evict during a grant: eviction would allow duplicate effects.
    if (this.journal.size >= 512) { void this.stop(); return Promise.resolve(receipt(command.commandId, 'stopped')) }
    const signal = this.abort.signal
    this.admission(command, 'admitted')
    const trace = this.commandTrace(command)
    const result = this.tail.then(() => this.dispatch(command, signal, trace))
    this.journal.set(command.commandId, { digest, result })
    // Retain only receipt metadata after delivery, never a session's AX text/frames.
    void result.then(value => {
      const entry = this.journal.get(command.commandId)
      if (entry?.result === result) entry.result = Promise.resolve({ commandId: value.commandId, outcome: value.outcome, code: value.code })
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result.then(value => structuredClone(value))
  }
  private async dispatch(command: NativeCommand, signal: AbortSignal, trace?: NativeBrokerTrace): Promise<NativeReceipt> {
    let sent = false
    try {
      let denial = this.permitted(command)
      if (signal.aborted || denial) return receipt(command.commandId, denial ?? 'stopped')
      if (command.action.kind !== 'observe' && command.action.kind !== 'capture') {
        // No label/model supplied effect classification is authoritative. Even fixture actions ask.
        if (!await this.helperWait(trace, 'begin_approval', () => this.helper!.beginApproval(command, this.leaseId!), signal, command.deadlineAt, command)) return receipt(command.commandId, 'stale_observation')
        if (signal.aborted || (denial = this.permitted(command))) return receipt(command.commandId, denial ?? 'stopped')
        this.state = 'awaiting_action_approval'; this.changed()
        if (signal.aborted || (denial = this.permitted(command))) return receipt(command.commandId, denial ?? 'stopped')
        const approved = await this.traceWait(trace, 'approval_wait', 'action', () => this.until(this.options.approveAction(command, signal, this.approvalContext(command)), signal, Math.min(command.deadlineAt, this.grant!.expiresAt)), signal, command)
        denial = this.permitted(command)
        if (signal.aborted || denial) return receipt(command.commandId, denial ?? 'stopped')
        if (approved) await this.revalidateExecution(command, signal, trace)
        if (signal.aborted || (denial = this.permitted(command))) return receipt(command.commandId, denial ?? 'stopped')
        const unchanged = await this.helperWait(trace, 'end_approval', () => this.helper!.endApproval(command, this.leaseId!, approved), signal, command.deadlineAt, command)
        if (signal.aborted || (denial = this.permitted(command))) return receipt(command.commandId, denial ?? 'stopped')
        this.state = 'active'; this.changed()
        if (!unchanged) { void this.stop(); return receipt(command.commandId, 'stale_observation') }
        if (!approved) return receipt(command.commandId, 'approval_required')
      }
      if (signal.aborted || (denial = this.permitted(command))) return receipt(command.commandId, denial ?? 'stopped')
      // endApproval can await fresh AX/signature checks before restoring focus.
      // Recheck remote authority again after that await, immediately before input.
      // Reads/capture use this single check; the fixed local inspector stays local.
      if (this.grant?.allowControl) await this.revalidateExecution(command, signal, trace)
      if (signal.aborted || (denial = this.permitted(command))) return receipt(command.commandId, denial ?? 'stopped')
      this.activity({ appId: command.action.target.appId, perception: command.action.kind === 'capture' || command.action.kind === 'click' ? 'vision' : 'ax' })
      // A trusted UI callback may itself revoke the session.
      if (signal.aborted || (denial = this.permitted(command))) return receipt(command.commandId, denial ?? 'stopped')
      sent = true
      const result = ReceiptSchema.parse(await this.helperWait(trace, 'execute', () => this.helper!.execute(command, this.leaseId!), signal, command.deadlineAt, command))
      if (signal.aborted || signal !== this.abort.signal || this.permitted(command)) throw new Error('Execution receipt expired or revoked')
      if (result.commandId !== command.commandId || (result.observation && (!sameIdentity(result.observation.identity, command.identity) || result.observation.epoch !== command.epoch || !sameTarget(result.observation.target, command.action.target)))) throw new Error('Cross-scope receipt')
      const observation = result.observation
      if (observation?.frame) {
        const frame = observation.frame
        if (command.action.kind !== 'capture' || !this.grant?.allowCapture || frame.displayLayoutVersion !== observation.displayLayoutVersion ||
          (['x', 'y', 'width', 'height'] as const).some(key => frame.bounds[key] !== observation.bounds[key])) throw new Error('Unscoped frame')
      }
      if (result.outcome === 'executed' && command.action.kind !== 'observe' && command.action.kind !== 'capture') {
        const grant = this.grant
        const caps = this.validateCapabilities(await this.helperWait(trace, 'capabilities', () => this.helper!.capabilities(), signal, command.deadlineAt, command))
        if (signal.aborted || signal !== this.abort.signal || this.grant !== grant || this.permitted(command)) throw new Error('Capability refresh revoked')
        this.caps = this.reduceCapabilities(caps)
        this.changed()
        // Do not re-test the completed action against its own downgrade. Readback
        // stays authorized, but a synchronous status callback may still Stop.
        if (signal.aborted || signal !== this.abort.signal || this.grant !== grant) throw new Error('Capability publication revoked')
      }
      // Retain no values, action lists or image bytes. No extra read may regenerate refs.
      if (!signal.aborted) this.approvalObservation = observation ? frozen({
        identity: structuredClone(observation.identity), epoch: observation.epoch,
        target: structuredClone(observation.target), observationId: observation.id,
        nodes: observation.nodes.map(({ ref, parentRef, name, role, bounds }) => ({
          ref, name, role, ...(parentRef === undefined ? {} : { parentRef }),
          ...(bounds === undefined ? {} : { bounds: { ...bounds } }),
        })),
      }) : undefined
      if (result.outcome === 'execution_unknown') void this.stop()
      return result
    } catch {
      if (signal === this.abort.signal) void this.stop()
      return receipt(command.commandId, sent ? 'transport_error' : 'cancelled', sent ? 'execution_unknown' : 'not_executed')
    }
  }
  private async revalidateExecution(command: NativeCommand, signal: AbortSignal, trace?: NativeBrokerTrace): Promise<void> {
    if (signal.aborted || this.permitted(command) || !this.options.revalidateExecution) throw new Error('Remote authority unavailable')
    const allowed = await this.traceWait(trace, 'authority_check', 'remote', () => this.until(this.options.revalidateExecution!(command, signal), signal, command.deadlineAt), signal, command)
    if (signal.aborted || signal !== this.abort.signal || this.permitted(command) || !allowed) throw new Error('Remote authority revoked')
  }
  private traceCommand(command: NativeCommand): NativeTraceCommand {
    return { commandId: command.commandId, actionKind: command.action.kind }
  }
  private commandTrace(command: NativeCommand): NativeBrokerTrace | undefined {
    const grant = this.grant
    // Never attribute a caller's forged scope to the trusted session, or a late old
    // command to a new trace. Raw IDs that are not UUIDs are rejected by the sink.
    return grant && sameIdentity(grant.identity, command.identity) && grant.epoch === command.epoch && grant.grantId === command.grantId ? this.trace : undefined
  }
  private admission(command: NativeCommand, outcome: 'admitted' | 'denied' | 'replayed'): void {
    this.commandTrace(command)?.record({ event: 'command_admission', outcome, command: this.traceCommand(command) })
  }
  private async traceWait<T>(trace: NativeBrokerTrace | undefined, event: NativeTraceMetadata['event'], operation: NativeTraceMetadata['operation'], invoke: () => Promise<T>, signal: AbortSignal, command?: NativeCommand): Promise<T> {
    if (!trace) return invoke()
    const started = performance.now()
    const metadata = { event, operation, ...(command ? { command: this.traceCommand(command) } : {}) }
    trace.record({ ...metadata, outcome: 'started' })
    try {
      const value = await invoke()
      trace.record({ ...metadata, outcome: signal.aborted ? 'cancelled' : value === false ? 'denied' : 'resolved', durationMs: performance.now() - started })
      return value
    } catch (error) {
      trace.record({ ...metadata, outcome: signal.aborted ? 'cancelled' : 'failed', durationMs: performance.now() - started })
      throw error // never send the exception to telemetry
    }
  }
  private helperWait<T>(trace: NativeBrokerTrace | undefined, operation: NativeTraceMetadata['operation'], invoke: () => Promise<T>, signal: AbortSignal, deadline?: number, command?: NativeCommand): Promise<T> {
    return this.traceWait(trace, 'helper_rpc_wait', operation, () => {
      const started = performance.now()
      const raw = invoke()
      // Settlement is broker callback arrival, NOT helper/OS execution or AX time.
      // Keep the original trace and signal; late settlement only emits metadata.
      if (trace) void raw.then(() => {
        trace.record({ event: 'helper_rpc_settlement', operation, outcome: signal.aborted ? 'late_resolved' : 'resolved', durationMs: performance.now() - started, ...(command ? { command: this.traceCommand(command) } : {}) })
      }, () => {
        trace.record({ event: 'helper_rpc_settlement', operation, outcome: signal.aborted ? 'late_failed' : 'failed', durationMs: performance.now() - started, ...(command ? { command: this.traceCommand(command) } : {}) })
      })
      return deadline === undefined ? raw : this.until(raw, signal, deadline)
    }, signal, command)
  }
  private approvalContext(command: NativeCommand): NativeApprovalContext | undefined {
    const observation = this.approvalObservation
    if (!observation || !('observationId' in command.action) || observation.observationId !== command.action.observationId ||
      observation.epoch !== command.epoch || !sameIdentity(observation.identity, command.identity) ||
      !sameTarget(observation.target, command.action.target)) return undefined
    return frozen({ ...observation, commandId: command.commandId, grantId: command.grantId })
  }
  private until<T>(promise: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => { cleanup(); reject(new Error('Revoked or expired')) }
      const timer = setTimeout(cancel, Math.max(0, Math.min(MAX_SESSION_MS, deadline - Date.now())))
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
      signal.addEventListener('abort', cancel, { once: true })
      promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
      if (signal.aborted) cancel()
    })
  }
  /** Revokes synchronously before any await. Helper kill is independent of dispatch queue/AX. */
  stop(): Promise<void> {
    if (this.abort.signal.aborted) return this.shutdown
    const stopRequested = performance.now()
    const trace = this.trace
    trace?.record({ event: 'stop_requested', outcome: 'started' })
    this.approvalObservation = undefined
    this.abort.abort(); this.epoch++; this.state = 'stopped'
    // Timestamp is this broker method's arrival, never the physical shortcut/input time.
    trace?.record({ event: 'local_gate_revoked', outcome: 'revoked', durationMs: performance.now() - stopRequested })
    this.activity(null)
    clearTimeout(this.expiry)
    const helper = this.helper; this.helper = undefined
    // Keep device lease until the killed process actually exited.
    const barrierStarted = performance.now()
    trace?.record({ event: 'helper_lifetime_barrier', operation: 'kill', outcome: 'started' })
    // A closed channel or failed SIGKILL is not death. Only the helper's existing
    // actual-exit/never-spawned barrier may reach the resolved branch.
    let barrier: Promise<void>
    try { barrier = helper ? helper.kill() : Promise.resolve() } catch { barrier = Promise.reject(new Error('Helper lifetime barrier failed')) }
    this.shutdown = barrier.then(() => {
      trace?.record({ event: 'helper_lifetime_barrier', operation: 'kill', outcome: 'resolved', durationMs: performance.now() - barrierStarted })
      return this.options.lease.release()
    }, error => {
      trace?.record({ event: 'helper_lifetime_barrier', operation: 'kill', outcome: 'failed', durationMs: performance.now() - barrierStarted })
      throw error
    })
    this.shutdown.catch(() => { /* Retain lease on cleanup failure; never steal it. */ })
    this.changed()
    return this.shutdown
  }
  userTakeover(): void { void this.stop(); this.state = 'paused_for_user'; this.changed() }
  lockOrSleep(): void { void this.stop() }
  /** Forget private scope synchronously, without resetting epochs, the journal,
   * the stop latch or the pending helper-death/lease-release barrier. */
  identityChanged(): Promise<void> {
    this.grant = undefined
    this.approvalObservation = undefined
    return this.stop()
  }
  relayDisconnected(): void { void this.stop() }
  dispose(): Promise<void> { this.disposed = true; return this.stop() }
}
