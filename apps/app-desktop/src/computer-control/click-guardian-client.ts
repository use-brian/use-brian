// Native overlap invariant: owner `prepared` follows independent standing
// public epoch-fence subscription + native scope pinning; workerTransferred
// follows a clean synchronous poll of the worker's ORIGINAL target fence.
// Main binds these acknowledgements to the immutable execute; no wire boolean
// or numeric "generation" can replace the native lifetime subscriptions.
import { z } from 'zod'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname } from 'node:path'
import type { Duplex } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { BoundsSchema, CommandSchema, MAX_MESSAGE_BYTES, type NativeCommand, type NativeGrant } from './contracts.js'

// Main-only private transport. No IPC/renderer/relay registration and no runtime
// enable switch. A handoff is a lookup into an outstanding execute, NOT authority.
// Private native descriptor schema only: deliberately NOT exported from shared
// contracts or registered with any renderer/model/public relay handler.
const PublicProcessIdentitySchema = z.object({ pid: z.number().int().min(2).max(2147483647),
  birth: z.string().regex(/^[1-9][0-9]{0,19}$/),
  executable: z.string().min(1).max(4096).startsWith('/'),
}).strict()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const ScopeSchema = z.object({ version: z.literal(1), command: CommandSchema,
  worker: PublicProcessIdentitySchema, process: PublicProcessIdentitySchema, windowNumber: z.number().int().min(1).max(4294967295),
  bounds: BoundsSchema, width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(1024),
  pngDigest: digest, fingerprint: digest, displayLayout: digest,
  frameTime: z.number().finite().nonnegative(), observationTime: z.number().finite().nonnegative(),
  grantDeadline: z.number().finite().positive(), commandDeadline: z.number().finite().positive(),
  privacy: z.literal('publicCompleteSafeCanvas'),
}).strict()
export type NativeClickScope = z.infer<typeof ScopeSchema>
export type GuardianHandoff = Readonly<{ requestId: string; command: NativeCommand; grant: NativeGrant; leaseId: string; descriptor: NativeClickScope }>
type Terminal = { kind: 'terminal'; id: string; status: 'refused' | 'sequenceAttemptedUnproven';
  cleanup: 'neverArmedNoEmission' | 'inputStreamReleasedCandidate' | 'fencedLeaseRetained'; reason: 'scopeRejected' | 'platformUnaccepted' | 'monitorReturned' | 'revoked' }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, expected: string[]) => isDeepStrictEqual(Object.keys(v).sort(), expected.sort())
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  if (!body.length || body.length > MAX_MESSAGE_BYTES) throw new Error('Invalid private guardian frame')
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}
// Same framing/size limit as helper RPC. A pipe can coalesce the prepared
// message and a terminal refusal; parse a bounded batch, then enforce closed
// lifecycle states on every message. Never mistake read boundaries for frames.
class OneFrame {
  private buffer: Buffer = Buffer.alloc(0)
  get empty(): boolean { return this.buffer.length === 0 }
  receive(chunk: Buffer): unknown[] {
    if (this.buffer.length + chunk.length > MAX_MESSAGE_BYTES + 4) throw new Error('Oversized guardian frame')
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0)
      if (!size || size > MAX_MESSAGE_BYTES || messages.length >= 3) throw new Error('Invalid guardian frame')
      if (this.buffer.length < size + 4) break
      const value: unknown = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'))
      this.buffer = this.buffer.subarray(size + 4)
      if (!object(value)) throw new Error('Invalid guardian message')
      messages.push(value)
    }
    return messages
  }
}

export class ClickGuardianClient {
  private revoked = false
  private handoffSeen = false
  private proofInvalid = false
  private ready = false
  private used = false // No owner restart/replay, including after a clean refusal.
  private owner?: ChildProcessWithoutNullStreams
  private admissionSent = false
  private noEmission = false
  private streamReleased = false
  private preparedSeen = false
  private transferOffered = false
  private transferred = false
  private returnOffered = false
  private monitoringAcknowledged = false
  private deliveryExposed = false
  private ownerExitedNormally = false
  private activeCommandID?: string
  private ownerDead = false
  private ownerClosed = false
  private terminal = false
  private safeResolve?: () => void
  private readonly safe: Promise<void>
  private activeID?: string
  private readonly workerFrames = new OneFrame()
  private readonly ownerFrames = new OneFrame()

  constructor(private readonly executable: string, private readonly workerPid: number | undefined,
    private readonly side: Duplex | undefined,
    // Must bind the id to the CURRENT pending request and locally retained grant
    // + exact approved command, consuming approval before returning a snapshot.
    private readonly bind: (id: string, descriptor: NativeClickScope) => GuardianHandoff | undefined,
    private readonly onLoss: () => void,
    private readonly isCurrent: (id: string) => boolean) {
    this.safe = new Promise(resolve => { this.safeResolve = resolve })
    const workerMessage = (value: unknown) => {
      if (this.revoked || !object(value)) throw new Error('Invalid handoff')
      if (value.kind === 'workerMonitoring') {
        if (this.terminal || !this.returnOffered || this.monitoringAcknowledged || this.ownerDead
          || !keys(value, ['kind', 'requestId']) || value.requestId !== this.activeID
          || !this.activeID || !this.isCurrent(this.activeID) || !this.owner) throw new Error('Invalid monitoring acknowledgment')
        this.monitoringAcknowledged = true
        this.owner.stdin.write(frame({ kind: 'workerMonitoring', id: this.activeID }), error => { if (error) this.loss() })
        return
      }
      if (value.kind === 'workerTransferred') {
        if (this.terminal || this.ownerDead || !this.activeID || !this.isCurrent(this.activeID)
          || !this.transferOffered || this.transferred || !keys(value, ['kind', 'requestId'])
          || value.requestId !== this.activeID || !this.owner) throw new Error('Unbound ownership transfer')
        this.transferred = true
        this.owner.stdin.write(frame({ kind: 'workerTransferred', id: this.activeID }), error => { if (error) this.loss() })
        return
      }
      if (!keys(value, ['kind', 'requestId', 'descriptor']) || value.kind !== 'handoff'
        || typeof value.requestId !== 'string' || value.requestId.length < 1 || value.requestId.length > 256) throw new Error('Invalid handoff')
      if (this.handoffSeen) throw new Error('Repeated handoff')
      this.handoffSeen = true
      const descriptor = ScopeSchema.parse(value.descriptor)
      if (descriptor.command.action.kind !== 'click' || descriptor.worker.pid !== this.workerPid
        || descriptor.process.pid !== descriptor.command.action.target.processId
        || descriptor.command.action.target.appId !== 'com.usebrian.NativeComputerFixture'
        || descriptor.observationTime > descriptor.frameTime) throw new Error('Invalid native descriptor')
      const handoff = this.bind(value.requestId, descriptor)
      if (!handoff) { this.reply(value.requestId); return }
      if (this.used || !this.workerPid) throw new Error('Repeated guardian handoff')
      this.used = true
      this.activeID = handoff.requestId
      this.activeCommandID = handoff.command.commandId
      this.launch(handoff)
    }
    side?.on('data', (chunk: Buffer) => {
      try { this.workerFrames.receive(chunk).forEach(workerMessage) } catch { this.loss() }
    })
    side?.on('error', () => this.loss())
    side?.on('end', () => this.loss())
    side?.on('close', () => this.loss())
  }
  private reply(requestId: string, kind: 'refused' | 'sequenceAttemptedUnproven' | 'ownerPrepared' | 'returnMonitor' | 'delivered' = 'refused'): void {
    if (!this.revoked) this.side?.write(frame({ kind, requestId }), error => { if (error) this.loss() })
  }
  private launch(handoff: GuardianHandoff): void {
    // SAME packaged executable and ProcessTrust admission, separate direct child
    // of Electron (not the AX worker). Never included in worker SIGKILL cleanup.
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.executable, ['--click-guardian'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        cwd: dirname(this.executable), env: { PATH: '/usr/bin:/bin' }, detached: true })
    } catch { this.ownerDead = true; this.ownerClosed = true; this.settle(); this.loss(); return }
    this.owner = child
    let spawned = child.pid !== undefined
    child.once('spawn', () => { spawned = true })
    child.on('error', () => {
      if (!spawned && child.pid === undefined) { this.admissionSent = false; this.ownerDead = true; this.ownerClosed = true; this.settle() }
      this.loss()
    })
    child.once('exit', (code, signal) => {
      this.ownerDead = true
      this.ownerExitedNormally = code === 0 && signal === null
      // stdout may still contain the terminal. No new stage can dispatch after
      // exit, but do not discard buffered cleanup evidence before stream close.
    })
    // exit may precede buffered stdout. Only close establishes the complete
    // terminal transcript; a duplicate/partial trailing frame poisons the proof.
    child.once('close', () => {
      this.ownerClosed = true
      if (!this.ownerFrames.empty) this.proofInvalid = true
      const returned = this.streamReleased && this.monitoringAcknowledged && this.ownerExitedNormally
      if (this.streamReleased && !returned) this.proofInvalid = true
      this.settle()
      if (returned && !this.proofInvalid && !this.revoked && this.activeID && this.isCurrent(this.activeID)) {
        this.deliveryExposed = true
        this.reply(this.activeID, 'delivered')
      } else if (!this.terminal || (!this.noEmission && !returned) || this.proofInvalid) this.loss()
    })
    child.stderr.resume() // Never log captured content.
    child.stdin.on('error', () => this.loss())
    child.stdout.on('error', () => { this.proofInvalid = true; this.loss() })
    child.stdout.on('end', () => { if (!this.terminal) this.loss() })
    const ownerMessage = (value: unknown) => {
      if (!this.ready) {
        if (!object(value) || !keys(value, ['kind', 'state']) || value.kind !== 'ready' || value.state !== 'unconstructed') throw new Error('Invalid guardian readiness')
        this.ready = true
        if (this.revoked || this.ownerDead || !this.isCurrent(handoff.requestId)) return // never dispatch a stale execute
        // Mark uncertainty BEFORE the write; partial delivery is not refusal.
        this.admissionSent = true
        child.stdin.write(frame({ kind: 'admit', id: handoff.requestId, workerPid: this.workerPid,
          grant: handoff.grant, command: handoff.command, leaseId: handoff.leaseId, descriptor: handoff.descriptor }), error => { if (error) this.loss() })
        return
      }
      if (object(value) && value.kind === 'returnMonitor') {
        if (this.revoked || this.ownerDead || this.returnOffered || !this.transferred || this.terminal
          || !keys(value, ['kind', 'id', 'cleanup']) || value.id !== this.activeID
          || value.cleanup !== 'inputStreamReleasedCandidate' || !this.isCurrent(handoff.requestId)) throw new Error('Invalid return offer')
        this.returnOffered = true
        this.reply(handoff.requestId, 'returnMonitor')
        return
      }
      if (object(value) && value.kind === 'prepared') {
        if (!this.admissionSent || this.preparedSeen || this.terminal || !keys(value, ['kind', 'id'])
          || value.id !== this.activeID) throw new Error('Invalid guardian transfer')
        // Exit/Stop can precede buffered prepared + no-emission refusal. Keep
        // validating their order without offering stale transfer authority.
        // Track observation separately so suppressed duplicates still poison proof.
        this.preparedSeen = true
        if (this.revoked || this.ownerDead || !this.isCurrent(handoff.requestId)) return
        this.transferOffered = true
        this.reply(handoff.requestId, 'ownerPrepared')
        return
      }
      if (this.terminal || !object(value) || !keys(value, ['kind', 'id', 'status', 'cleanup', 'reason'])
        || value.kind !== 'terminal' || value.id !== this.activeID
        || typeof value.status !== 'string' || !['refused', 'sequenceAttemptedUnproven'].includes(value.status)
        || typeof value.cleanup !== 'string' || !['neverArmedNoEmission', 'inputStreamReleasedCandidate', 'fencedLeaseRetained'].includes(value.cleanup)
        || typeof value.reason !== 'string' || !['scopeRejected', 'platformUnaccepted', 'monitorReturned', 'revoked'].includes(value.reason)
        || ((value.status === 'sequenceAttemptedUnproven' || this.returnOffered) && value.cleanup === 'neverArmedNoEmission')
        || (value.cleanup === 'inputStreamReleasedCandidate' && (value.status !== 'sequenceAttemptedUnproven'
          || value.reason !== 'monitorReturned' || !this.transferred || !this.returnOffered || !this.monitoringAcknowledged))) throw new Error('Invalid guardian terminal')
      const result = value as Terminal
      this.terminal = true
      this.noEmission = result.status === 'refused' && result.cleanup === 'neverArmedNoEmission'
      // Signed native source is the only producer of this future-accepted
      // input-stream receipt. Still NEVER an application-success receipt.
      this.streamReleased = result.cleanup === 'inputStreamReleasedCandidate'
      this.settle()
      if (this.noEmission) this.reply(handoff.requestId)
      else if (!this.streamReleased) this.loss() // Unproven sequence/cleanup NEVER becomes a success or drain receipt.
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.ownerClosed) { this.proofInvalid = true; this.loss(); return }
      try { this.ownerFrames.receive(chunk).forEach(ownerMessage) }
      catch { this.proofInvalid = true; this.noEmission = false; this.streamReleased = false; this.loss() }
    })
    // No admission until the closed unconstructed handshake. Bootstrap failure
    // can therefore prove no emission on observed death without wedging a lease.
  }
  acceptsWorkerResponse(id: string): boolean {
    // An early worker stdout response must not orphan a bootstrap in progress.
    return this.activeID !== id || (this.terminal && (this.noEmission || this.deliveryExposed) && !this.proofInvalid)
  }
  acceptsExecutedClick(id: string, commandID: string): boolean {
    return !this.revoked && !this.proofInvalid && this.deliveryExposed && this.ownerDead && this.ownerClosed
      && this.ownerExitedNormally && this.monitoringAcknowledged && this.streamReleased
      && this.activeID === id && this.activeCommandID === commandID && this.isCurrent(id)
  }
  private settle(): void {
    if (this.ownerDead && this.ownerClosed && (!this.admissionSent || ((this.noEmission || (this.streamReleased && this.ownerExitedNormally && this.monitoringAcknowledged)) && !this.proofInvalid))) this.safeResolve?.()
  }
  private loss(): void { this.revoke(); this.onLoss() }
  revoke(): void {
    if (this.revoked) return
    this.revoked = true
    if (this.returnOffered && !this.deliveryExposed) this.proofInvalid = true
    // EOF revokes new dispatch. Do NOT kill the surviving cleanup owner, flush
    // commands, post a blind up, or manufacture safety after a timeout.
    this.owner?.stdin.destroy()
    this.side?.destroy()
  }
  waitForSafety(): Promise<void> {
    // No owner was ever launched => structurally no owner input/probe possible.
    return !this.used ? Promise.resolve() : this.safe
  }
}
