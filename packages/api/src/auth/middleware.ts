import type { Request, Response, NextFunction } from 'express'
import { verifyAccessTokenClaims } from './jwt.js'
import { authSessionStore, type AuthSessionStore } from '../db/auth-session-store.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

declare global {
  namespace Express {
    interface Request {
      userId?: string
      authSessionId?: string
      authVersion?: number
    }
  }
}

/**
 * Express middleware that verifies JWT access token from Authorization header.
 * Sets req.userId on success, returns 401 on failure.
 *
 * One admission per request (plan "One-turn SQL baseline", M2): fall-through
 * `/api` routers each mount their own guard, so a single request can cross
 * several before its handler. The first successful validation is recorded on
 * that request object only, keyed by the exact header and validator, and later
 * guards on the SAME request reuse it. This is not a cache: nothing outlives the
 * request, every new request validates (and so observes revocation) afresh, and
 * long turns keep their own live authority checks.
 */
type AuthSessionValidator = Pick<AuthSessionStore, 'validateAccess'>
type RequestAdmission = { header: string; sessions: AuthSessionValidator; userId: string; authSessionId?: string; authVersion: number }
const requestAdmissions = new WeakMap<Request, RequestAdmission>()
/** The request's own admission, when an earlier guard admitted this exact header. */
function admittedRequest(req: Request, header: string, sessions: AuthSessionValidator): RequestAdmission | null {
  const admitted = requestAdmissions.get(req)
  return admitted && admitted.header === header && admitted.sessions === sessions && req.userId === admitted.userId ? admitted : null
}
function admit(req: Request, header: string, sessions: AuthSessionValidator, claims: { userId: string; sessionId?: string; authVersion?: number }): void {
  req.userId = claims.userId
  req.authSessionId = claims.sessionId
  req.authVersion = claims.authVersion ?? 0
  requestAdmissions.set(req, { header, sessions, userId: claims.userId, authSessionId: claims.sessionId, authVersion: req.authVersion })
}

export function requireAuth(
  jwtSecret: string,
  sessions: AuthSessionValidator = authSessionStore,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }
    if (admittedRequest(req, header, sessions)) { next(); return }

    const token = header.slice(7)
    const claims = verifyAccessTokenClaims(token, jwtSecret)
    if (
      !claims ||
      !UUID_RE.test(claims.userId) ||
      (claims.sessionId !== undefined && !UUID_RE.test(claims.sessionId))
    ) {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }

    try {
      if (!(await sessions.validateAccess(claims))) {
        res.status(401).json({ error: 'Invalid or revoked token' })
        return
      }
      admit(req, header, sessions, claims)
      next()
    } catch (error) {
      console.error('[auth] session validation failed:', error)
      res.status(503).json({ error: 'Authentication temporarily unavailable' })
    }
  }
}

/**
 * Optional auth — extracts userId if token present, but doesn't reject.
 * Allows both authenticated and guest access.
 */
export function optionalAuth(
  jwtSecret: string,
  sessions: AuthSessionValidator = authSessionStore,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ') && !admittedRequest(req, header, sessions)) {
      const token = header.slice(7)
      const claims = verifyAccessTokenClaims(token, jwtSecret)
      if (
        claims &&
        UUID_RE.test(claims.userId) &&
        (claims.sessionId === undefined || UUID_RE.test(claims.sessionId))
      ) {
        try {
          if (await sessions.validateAccess(claims)) admit(req, header, sessions, claims)
        } catch (error) {
          console.error('[auth] optional session validation failed:', error)
        }
      }
    }
    next()
  }
}
