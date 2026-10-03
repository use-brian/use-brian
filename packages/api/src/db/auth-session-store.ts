import type { Request } from 'express'
import type pg from 'pg'
import { getPool, query } from './client.js'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

/** [COMP:api/auth-sessions] Server-side ledger for revocable JWT sessions. */

export const AUTH_SESSION_TTL_DAYS = 30
const ACCESS_TOUCH_INTERVAL_MINUTES = 5

export type AuthTokenClaims = {
  userId: string
  sessionId?: string
  authVersion?: number
}

export type AuthSessionClientInfo = {
  deviceLabel: string
  userAgent: string | null
  ipAddress: string | null
}

export type AuthSession = {
  id: string
  deviceLabel: string
  userAgent: string | null
  ipAddress: string | null
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
}

type SessionAdmissionRow = {
  authVersion: number
  sessionId: string | null
  sessionVersion: number | null
  lastSeenAt: Date | null
}

export type AuthSessionStore = {
  create(userId: string, client: AuthSessionClientInfo): Promise<{ id: string; authVersion: number } | null>
  validateAccess(claims: AuthTokenClaims, options?: { touchLastSeen: boolean }): Promise<boolean>
  validateRefresh(claims: AuthTokenClaims, client: AuthSessionClientInfo): Promise<{ id: string; authVersion: number } | null>
  listForUser(userId: string): Promise<AuthSession[]>
  revokeForUser(userId: string, sessionId: string): Promise<boolean>
  // expectedAuthVersion makes legacy logout replay-safe even across concurrent requests.
  revokeAllForUser(userId: string, expectedAuthVersion?: number): Promise<boolean>
}

function bounded(value: string | undefined | null, max: number): string | null {
  const normalized = value?.trim()
  return normalized ? normalized.slice(0, max) : null
}

export function deviceLabelFromUserAgent(raw: string | null): string {
  if (!raw) return 'Unknown device'
  const ua = raw.toLowerCase()
  const os = ua.includes('iphone') || ua.includes('ipad')
    ? 'iOS'
    : ua.includes('android')
      ? 'Android'
      : ua.includes('mac os') || ua.includes('macintosh')
        ? 'macOS'
        : ua.includes('windows')
          ? 'Windows'
          : ua.includes('linux')
            ? 'Linux'
            : null
  const app = ua.includes('electron')
    ? 'Desktop app'
    : ua.includes('edg/')
      ? 'Edge'
      : ua.includes('firefox/')
        ? 'Firefox'
        : ua.includes('chrome/') || ua.includes('crios/')
          ? 'Chrome'
          : ua.includes('safari/')
            ? 'Safari'
            : ua.includes('undici') || ua.includes('node')
              ? 'Web session'
              : 'Browser'
  return os ? `${app} on ${os}` : app
}

export function authSessionClientInfo(req: Request): AuthSessionClientInfo {
  const forwardedUa = bounded(req.get('x-client-user-agent'), 1024)
  const requestUa = bounded(req.get('user-agent'), 1024)
  const userAgent = forwardedUa ?? (
    requestUa && !/(?:undici|node\.js)/i.test(requestUa) ? requestUa : null
  )
  const explicitClientIp = bounded(req.get('x-client-ip'), 128)
  // A server-side auth bridge forwards the browser UA but not a trustworthy
  // address. Do not mislabel that bridge/Cloud Run hop as the user's IP.
  const ipAddress = explicitClientIp ?? (forwardedUa ? null : bounded(req.ip, 128))
  return {
    deviceLabel: deviceLabelFromUserAgent(userAgent),
    userAgent,
    ipAddress,
  }
}

export function createAuthSessionStore(
  db: Queryable = { query: query as Queryable['query'] },
  pool?: Pick<pg.Pool, 'connect'>,
): AuthSessionStore {
  const createSession = async (
    userId: string,
    client: AuthSessionClientInfo,
    expectedAuthVersion?: number,
  ): Promise<{ id: string; authVersion: number } | null> => {
    const result = await db.query<{ id: string; authVersion: number }>(
      `INSERT INTO auth_sessions (user_id, auth_version, device_label, user_agent, last_ip)
       SELECT id, auth_version, $2, $3, $4
         FROM users
        WHERE id = $1 AND ($5::integer IS NULL OR auth_version = $5)
       RETURNING id, auth_version AS "authVersion"`,
      [userId, client.deviceLabel, client.userAgent, client.ipAddress, expectedAuthVersion ?? null],
    )
    return result.rows[0] ?? null
  }

  async function admission(claims: AuthTokenClaims): Promise<SessionAdmissionRow | null> {
    const tokenVersion = claims.authVersion ?? 0
    const result = await db.query<SessionAdmissionRow>(
      `SELECT u.auth_version AS "authVersion",
              s.id AS "sessionId",
              s.auth_version AS "sessionVersion",
              s.last_seen_at AS "lastSeenAt"
         FROM users u
         LEFT JOIN auth_sessions s
           ON s.id = $2
          AND s.user_id = u.id
          AND s.revoked_at IS NULL
          AND s.expires_at > clock_timestamp()
        WHERE u.id = $1
          AND u.auth_version = $3`,
      [claims.userId, claims.sessionId ?? null, tokenVersion],
    )
    const row = result.rows[0]
    if (!row) return null
    // A claimed session must resolve to exactly that live row. Legacy tokens
    // omit sid and are governed only by users.auth_version=0 until refresh.
    if (claims.sessionId && (!row.sessionId || row.sessionVersion !== tokenVersion)) return null
    return row
  }

  return {
    create: createSession,

    async validateAccess(claims, options) {
      const row = await admission(claims)
      if (!row) return false
      if (
        options?.touchLastSeen !== false &&
        claims.sessionId &&
        row.lastSeenAt &&
        row.lastSeenAt.getTime() < Date.now() - ACCESS_TOUCH_INTERVAL_MINUTES * 60_000
      ) {
        await db.query(
          `UPDATE auth_sessions
              SET last_seen_at = clock_timestamp()
            WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [claims.sessionId, claims.userId],
        )
      }
      return true
    },

    async validateRefresh(claims, client) {
      const row = await admission(claims)
      if (!row) return null
      // A concurrent legacy logout may bump auth_version after admission.
      // Never upgrade that old refresh token into the newly authenticated version.
      if (!claims.sessionId) return createSession(claims.userId, client, claims.authVersion ?? 0)
      const refreshed = await db.query<{ id: string; authVersion: number }>(
        `UPDATE auth_sessions
            SET last_seen_at = clock_timestamp(),
                expires_at = clock_timestamp() + interval '${AUTH_SESSION_TTL_DAYS} days',
                device_label = CASE WHEN $4::text IS NULL THEN device_label ELSE $3 END,
                user_agent = COALESCE($4, user_agent),
                last_ip = COALESCE($5, last_ip)
          WHERE id = $1
            AND user_id = $2
            AND revoked_at IS NULL
            AND expires_at > clock_timestamp()
         RETURNING id, auth_version AS "authVersion"`,
        [claims.sessionId, claims.userId, client.deviceLabel, client.userAgent, client.ipAddress],
      )
      return refreshed.rows[0] ?? null
    },

    async listForUser(userId) {
      const result = await db.query<AuthSession>(
        `SELECT id,
                device_label AS "deviceLabel",
                user_agent AS "userAgent",
                last_ip AS "ipAddress",
                created_at AS "createdAt",
                last_seen_at AS "lastSeenAt",
                expires_at AS "expiresAt"
           FROM auth_sessions
          WHERE user_id = $1
            AND revoked_at IS NULL
            AND expires_at > clock_timestamp()
          ORDER BY last_seen_at DESC, id`,
        [userId],
      )
      return result.rows
    },

    async revokeForUser(userId, sessionId) {
      const result = await db.query(
        `UPDATE auth_sessions
            SET revoked_at = clock_timestamp()
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [sessionId, userId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async revokeAllForUser(userId, expectedAuthVersion) {
      const client = await (pool ?? getPool()).connect()
      try {
        await client.query('BEGIN')
        const bumped = await client.query(
          `UPDATE users SET auth_version = auth_version + 1
            WHERE id = $1 AND ($2::integer IS NULL OR auth_version = $2)`,
          [userId, expectedAuthVersion ?? null],
        )
        if ((bumped.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')
          return false
        }
        await client.query(
          `UPDATE auth_sessions
              SET revoked_at = COALESCE(revoked_at, clock_timestamp())
            WHERE user_id = $1`,
          [userId],
        )
        await client.query('COMMIT')
        return true
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

export const authSessionStore = createAuthSessionStore()
