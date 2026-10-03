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
 */
type AuthSessionValidator = Pick<AuthSessionStore, 'validateAccess'>

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
      req.userId = claims.userId
      req.authSessionId = claims.sessionId
      req.authVersion = claims.authVersion ?? 0
      next()
    } catch (error) {
      console.error('[auth] session validation failed:', error)
      res.status(503).json({ error: 'Authentication temporarily unavailable' })
    }
  }
}

/** Explicit read-only authentication: identical JWT/admission checks, no activity UPDATE.
 * Callers must mount this only for deliberately read-only operations, not normal API traffic. */
export function requireAuthWithoutTouch(
  jwtSecret: string,
  sessions: AuthSessionValidator = authSessionStore,
) {
  return requireAuth(jwtSecret, {
    validateAccess: claims => sessions.validateAccess(claims, { touchLastSeen: false }),
  })
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
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7)
      const claims = verifyAccessTokenClaims(token, jwtSecret)
      if (
        claims &&
        UUID_RE.test(claims.userId) &&
        (claims.sessionId === undefined || UUID_RE.test(claims.sessionId))
      ) {
        try {
          if (await sessions.validateAccess(claims)) {
            req.userId = claims.userId
            req.authSessionId = claims.sessionId
            req.authVersion = claims.authVersion ?? 0
          }
        } catch (error) {
          console.error('[auth] optional session validation failed:', error)
        }
      }
    }
    next()
  }
}
