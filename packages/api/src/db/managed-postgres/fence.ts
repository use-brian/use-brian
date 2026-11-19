/**
 * [COMP:platform/managed-postgres] Private executor capability.
 *
 * Every native action (INITDB, START, STOP) runs through the packaged
 * `usebrian-pg-lifecycle` executor while it holds a POSIX record lock on the
 * profile. The lock survives `exec` into initdb/pg_ctl, so a successor cannot
 * start a new generation until the action has exited. Closing the private pipe
 * before a command aborts the executor with no late native action.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { managedPostgresBinaries, type ManagedPostgresArtifact } from './artifact.js'
import { managedNativeChildEnvironment } from './environment.js'

export type ManagedNativeAction = 'INITDB' | 'STOP' | `START ${number}`

export interface ManagedFence {
  readonly pid: number | undefined
  readonly stageBound: string | null
  readonly held: boolean
  run(action: ManagedNativeAction): Promise<void>
  release(): Promise<void>
  abandon(): Promise<void>
}

export interface AcquireManagedFenceOptions {
  artifact: ManagedPostgresArtifact
  profile: string
  stage?: string
  timeoutMs?: number
  onLost?: (error: Error) => void
}

type FenceStatus = 'waiting' | 'held' | 'executing' | 'releasing' | 'lost' | 'closed'

export async function acquireManagedFence({
  artifact,
  profile,
  stage,
  timeoutMs = 300_000,
  onLost = () => {},
}: AcquireManagedFenceOptions): Promise<ManagedFence> {
  const binary = managedPostgresBinaries(artifact).lifecycleFence
  const child = spawn(binary, [profile, ...(stage ? [stage] : [])], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: managedNativeChildEnvironment(process.env),
  })
  let status: FenceStatus = 'waiting'
  let line = ''
  let diagnostics = ''
  let settled = false
  let readyAccept!: () => void
  let readyReject!: (error: Error) => void
  let exitAccept!: () => void
  let exitReject!: (error: Error) => void
  let stdinReject!: (error: Error) => void
  const stdinFailure = new Promise<never>((_, reject) => { stdinReject = reject })
  stdinFailure.catch(() => {})
  const ready = new Promise<void>((accept, reject) => { readyAccept = accept; readyReject = reject })
  const exited = new Promise<void>((accept, reject) => { exitAccept = accept; exitReject = reject })
  exited.catch(() => {})

  async function retainDiagnostics() {
    if (!diagnostics) return
    const temporary = join(profile, 'executor-diagnostic-' + randomUUID() + '.tmp')
    await writeFile(temporary, diagnostics.slice(-65536), { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(profile, 'native-executor-error.log'))
  }
  function lost(error: Error, force = false) {
    if (status === 'held' || force) {
      status = 'lost'
      try { onLost(error) } catch { /* supervisor notification only */ }
    }
    if (!settled) { settled = true; readyReject(error) }
  }

  child.stdout.on('data', (chunk: Buffer) => {
    if (status !== 'waiting') return
    line = (line + chunk.toString()).slice(0, 4096)
    if (!line.includes('\n')) return
    if (line.split('\n')[0] !== 'LOCKED') { lost(new Error('Native lifecycle executor handshake changed')); child.stdin.end(); return }
    status = 'held'
    clearTimeout(timer)
    settled = true
    readyAccept()
  })
  child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-65536) })
  child.stdin.on('error', (error) => {
    diagnostics = (diagnostics + '\n' + error.message).slice(-65536)
    lost(error, status === 'executing')
    stdinReject(error)
  })
  child.on('error', (error) => { clearTimeout(timer); lost(error); exitReject(error) })
  child.on('exit', async (code, signal) => {
    clearTimeout(timer)
    const prior = status
    status = 'closed'
    if (!['executing', 'releasing'].includes(prior) || code !== 0) {
      lost(new Error('Native lifecycle fence was lost before its action completed'), ['held', 'executing', 'releasing'].includes(prior))
    }
    try {
      if (code !== 0 || diagnostics) await retainDiagnostics()
      if (code === 0) exitAccept()
      else exitReject(new Error('Native lifecycle executor failed (' + (signal ?? code) + '); see private executor log'))
    } catch (error) {
      exitReject(error as Error)
    }
    if (!settled) { settled = true; readyReject(new Error('Native lifecycle fence did not become ready')) }
  })
  const timer = setTimeout(() => {
    lost(new Error('Native lifecycle fence acquisition timed out'))
    child.kill('SIGTERM')
  }, timeoutMs)

  await ready

  async function finish(command: string, kind: 'executing' | 'releasing') {
    if (status !== 'held') throw new Error('Native lifecycle fence is no longer held')
    status = kind
    child.stdin.end(command + '\n')
    await Promise.race([exited, stdinFailure])
  }

  return Object.freeze({
    pid: child.pid,
    stageBound: stage ?? null,
    get held() { return status === 'held' },
    run: async (action: ManagedNativeAction) => {
      if (!/^(?:STOP|INITDB|START (?:[1-9][0-9]{3,4}))$/.test(action)) throw new Error('Invalid private native action')
      await finish(action, 'executing')
    },
    release: () => finish('RELEASE', 'releasing'),
    abandon: async () => { if (status === 'held') child.stdin.end(); await exited },
  })
}
