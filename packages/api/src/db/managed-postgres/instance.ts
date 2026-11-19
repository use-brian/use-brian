/**
 * [COMP:platform/managed-postgres] Authenticated native instance identity.
 *
 * The postmaster PID file is only a crosscheck. Identity is the PostgreSQL
 * system identifier, the canonical data directory and the postmaster start
 * time, read over an authenticated bootstrap session. `global/pg_control`
 * supplies the same system identifier before any server is started.
 */
import { open, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedQueryable } from './types.js'

export interface ManagedPostmaster {
  readonly pid: number
  readonly data: string
  readonly started: number
  readonly port: number
}

export interface ManagedInstance {
  readonly systemId: string
  readonly dataDirectory: string
  readonly pid: number
  readonly startedAt: string
  readonly startedSeconds: string
  readonly port: number
}

const PG_CONTROL_VERSION_18 = 1800

function identityChanged(message: string): Error {
  return Object.assign(new Error(message), { code: 'MANAGED_INSTANCE_IDENTITY_CHANGED' })
}

export async function readManagedPostmaster(data: string): Promise<ManagedPostmaster | null> {
  let text: string
  try {
    text = await readFile(join(data, 'postmaster.pid'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const lines = text.trim().split('\n')
  const result = { pid: Number(lines[0]), data: await realpath(lines[1]), started: Number(lines[2]), port: Number(lines[3]) }
  if (
    !Number.isSafeInteger(result.pid) || result.pid < 1 ||
    !Number.isSafeInteger(result.port) || result.port < 1 || result.port > 65535 ||
    !Number.isSafeInteger(result.started)
  ) throw new Error('Invalid native postmaster identity')
  return Object.freeze(result)
}

/** The uint64 system identifier at the head of a PostgreSQL 18 `pg_control`. */
export async function readControlSystemIdentifier(data: string): Promise<string> {
  const file = await open(join(data, 'global', 'pg_control'), 'r')
  try {
    const buffer = Buffer.alloc(12)
    const { bytesRead } = await file.read(buffer, 0, 12, 0)
    if (bytesRead !== 12 || buffer.readUInt32LE(8) !== PG_CONTROL_VERSION_18) {
      throw identityChanged('Managed PostgreSQL control file is not a PostgreSQL 18 cluster')
    }
    return buffer.readBigUInt64LE(0).toString()
  } finally {
    await file.close()
  }
}

export async function authenticateManagedInstance(
  client: ManagedQueryable,
  data: string,
  systemId: string | undefined,
): Promise<ManagedInstance> {
  const row = (await client.query<{
    session_user: string; current_user: string; directory: string; system_id: string
    started_seconds: string; started_at: string; postmaster_pid: number
  }>(`SELECT session_user,current_user,current_setting('data_directory') AS directory,
  (SELECT system_identifier::text FROM pg_control_system()) AS system_id,
  floor(extract(epoch FROM pg_postmaster_start_time()))::text AS started_seconds,
  (pg_postmaster_start_time() AT TIME ZONE 'UTC')::text||'Z' AS started_at,
  split_part(pg_read_file('postmaster.pid'),chr(10),1)::integer AS postmaster_pid`)).rows[0]
  const pid = await readManagedPostmaster(data)
  // postmaster.pid records the process start (MyStartTime); pg_postmaster_start_time()
  // is taken slightly later in startup, so the two may straddle a second boundary.
  // A pid file from any earlier generation is older than this server's start.
  const skew = pid ? Number(row.started_seconds) - pid.started : NaN
  if (
    !pid || row.session_user !== 'brian_bootstrap' || row.current_user !== 'brian_bootstrap' ||
    (await realpath(row.directory)) !== data || pid.data !== data ||
    !(skew >= 0 && skew <= 2) || pid.pid !== row.postmaster_pid ||
    (systemId && row.system_id !== systemId)
  ) throw identityChanged('Managed PostgreSQL authenticated instance identity changed')
  return Object.freeze({
    systemId: row.system_id,
    dataDirectory: data,
    pid: pid.pid,
    startedAt: row.started_at,
    startedSeconds: row.started_seconds,
    port: pid.port,
  })
}
