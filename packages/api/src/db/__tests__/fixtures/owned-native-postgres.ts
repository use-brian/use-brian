import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const PREFIX = '/tmp/native-accounting-pg-'
export const ROLE = 'native_accounting_test'
export const DATABASE = 'native_accounting_test'
export const PORT = 6543 // Only the socket filename; TCP listening is disabled.
export function cleanEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/bin', HOME: home, LANG: 'C', LC_ALL: 'C', TZ: 'UTC', NODE_ENV: 'test' }
}
export function connectionConfig(root: string, application = 'native-accounting-acceptance'): pg.PoolConfig {
  return { host: join(root, 'socket'), port: PORT, user: ROLE, database: DATABASE,
    password: 'synthetic-unused-local-trust', ssl: false, application_name: application,
    connectionTimeoutMillis: 1500, query_timeout: 8000, statement_timeout: 8000,
    options: '-c idle_in_transaction_session_timeout=10000', max: 12 }
}
export async function validateOwnedRoot(root: string, token: string): Promise<void> {
  if (resolve(root) !== root || !root.startsWith(PREFIX) || root.slice(PREFIX.length).includes('/')) throw new Error('Not an owned test directory')
  for (const path of [root, join(root, 'socket')]) {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('Unsafe test directory ownership/mode')
  }
  const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8')) as { token: string; kind: string }
  if (owner.kind !== 'native-accounting-acceptance-v1' || owner.token !== token) throw new Error('Test ownership marker mismatch')
}
export async function assertPrivateDatabase(client: pg.Pool | pg.PoolClient, root: string): Promise<void> {
  const r = await client.query(`SELECT current_database() AS db,current_user AS role,inet_server_addr() AS address,
    current_setting('data_directory') AS data,current_setting('listen_addresses') AS listen,
    current_setting('unix_socket_directories') AS socket,current_setting('fsync') AS fsync,
    current_setting('synchronous_commit') AS synchronous_commit`)
  const v = r.rows[0]
  if (v.db !== DATABASE || v.role !== ROLE || v.address !== null || v.data !== join(root, 'data') || v.listen !== ''
    || v.socket !== join(root, 'socket') || v.fsync !== 'on' || v.synchronous_commit !== 'on') throw new Error('Not the private durable test database')
}
function exited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null }
function killOwnedGroup(child: ChildProcess): void {
  // Each child is spawned detached (its own process group). Never enumerate,
  // signal, or stop an existing server or a PID read from somebody else's file.
  if (child.pid && !exited(child)) {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
}
export async function waitExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (exited(child)) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned process did not exit')), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

/** Opt-in acceptance-test fixture only. No inherited PG settings, connection
 * strings, credentials, network listeners, existing servers or production data. */
export class OwnedNativePostgres {
  readonly token = randomUUID()
  readonly workers = new Set<ChildProcess>()
  private readonly commands = new Set<ChildProcess>()
  private server?: ChildProcess
  private pool?: pg.Pool
  private readonly checkouts = new Set<pg.PoolClient>()
  private closing?: Promise<void>
  private constructor(readonly root: string) {}
  static async allocate(): Promise<OwnedNativePostgres> {
    if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Test requires unprivileged Linux PostgreSQL tooling')
    const root = await mkdtemp(PREFIX)
    await chmod(root, 0o700)
    const owned = new OwnedNativePostgres(root)
    try {
      await mkdir(join(root, 'socket'), { mode: 0o700 })
      await mkdir(join(root, 'home'), { mode: 0o700 })
      await writeFile(join(root, 'owner.json'), JSON.stringify({ kind: 'native-accounting-acceptance-v1',token: owned.token }), { mode: 0o600 })
      return owned
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
  }
  environment(): NodeJS.ProcessEnv { return cleanEnvironment(join(this.root, 'home')) }
  private async command(file: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { env: this.environment(), cwd: this.root, detached: true, stdio: ['ignore','pipe','pipe'] })
      this.commands.add(child)
      let output = '', failed = false
      const fail = (error: Error) => { if (!failed) { failed = true; killOwnedGroup(child); reject(error) } }
      const timer = setTimeout(() => fail(new Error(`${file} exceeded its owned test timeout`)), timeoutMs)
      const collect = (chunk: Buffer) => { output += chunk.toString(); if (output.length > 131072) fail(new Error('Owned command output exceeded bound')) }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      child.once('error', error => { clearTimeout(timer); this.commands.delete(child); reject(error) })
      child.once('close', code => {
        clearTimeout(timer); this.commands.delete(child)
        if (!failed) code === 0 ? resolve(output) : reject(new Error(`${file} failed (${code}): ${output}`))
      })
    })
  }
  async start(): Promise<pg.Pool> {
    await validateOwnedRoot(this.root, this.token)
    await this.command('initdb', ['-D',join(this.root, 'data'),`--username=${ROLE}`,'--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8','--no-instructions'], 20000)
    const log = await open(join(this.root, 'postgres.log'), 'wx', 0o600)
    try {
      this.server = spawn('postgres', ['-D',join(this.root, 'data'),'-c','listen_addresses=',
        '-c',`unix_socket_directories=${join(this.root, 'socket')}`,'-c','unix_socket_permissions=0700','-p',String(PORT),
        '-c','fsync=on','-c','synchronous_commit=on','-c','max_connections=20','-c','shared_buffers=16MB','-c','deadlock_timeout=100ms'],
      { env: this.environment(), cwd: this.root, detached: true, stdio: ['ignore',log.fd,log.fd] })
    } finally { await log.close() }
    let spawnError: Error | undefined
    this.server.on('error', error => { spawnError = error })
    const deadline = Date.now() + 15000
    let ready = false
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      if (exited(this.server)) throw new Error(`Owned postgres failed: ${await readFile(join(this.root,'postgres.log'),'utf8')}`)
      const client = new pg.Client({ ...connectionConfig(this.root),database: 'postgres' })
      try { await client.connect(); await client.query(`CREATE DATABASE ${DATABASE}`); ready = true; break }
      catch { await new Promise(resolve => setTimeout(resolve, 50)) }
      finally { await client.end().catch(() => {}) }
    }
    if (!ready) throw new Error('Owned postgres startup deadline exceeded')
    const pidFile = (await readFile(join(this.root,'data','postmaster.pid'),'utf8')).split('\n')
    if (Number(pidFile[0]) !== this.server.pid || pidFile[1] !== join(this.root,'data')) throw new Error('Owned postmaster identity mismatch')
    this.pool = new pg.Pool(connectionConfig(this.root))
    this.pool.on('acquire', client => this.checkouts.add(client))
    this.pool.on('release', (_error, client) => this.checkouts.delete(client))
    // Catch idle errors during forced cleanup; queries still reject to the test.
    this.pool.on('error', () => {})
    await assertPrivateDatabase(this.pool, this.root)
    return this.pool
  }
  close(): Promise<void> {
    return this.closing ??= this.cleanup()
  }
  private async cleanup(): Promise<void> {
    for (const worker of this.workers) if (!exited(worker)) worker.kill('SIGKILL')
    await Promise.all([...this.workers].map(w => waitExit(w).catch(() => {})))
    for (const command of this.commands) killOwnedGroup(command)
    await Promise.all([...this.commands].map(c => waitExit(c).catch(() => {})))
    if (this.server && !exited(this.server)) {
      try {
        await validateOwnedRoot(this.root, this.token)
        await this.command('pg_ctl', ['-D',join(this.root,'data'),'-m','fast','-w','-t','5','stop'], 8000)
        await waitExit(this.server)
      } catch {
        killOwnedGroup(this.server)
        await waitExit(this.server)
      }
    }
    // A failed/aborted test may have left a checked-out controller connection.
    // Destroy only this fixture's connections so pool.end cannot wait forever.
    for (const client of this.checkouts) {
      try { client.release(true) } catch { /* Already released by an interrupted query. */ }
    }
    if (this.pool) await this.pool.end()
    // Remove only our mkdtemp directory, after all owned server processes exit.
    await validateOwnedRoot(this.root, this.token)
    await rm(this.root, { recursive: true, force: true })
  }
}
