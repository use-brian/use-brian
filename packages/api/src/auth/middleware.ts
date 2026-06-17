import type { Request, Response, NextFunction } from 'express'
import { verifyAccessToken } from './jwt.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

declare global {
  namespace Express {
    interface Request {
      userId?: string
    }
  }
}

/**
 * Express middleware that verifies JWT access token from Authorization header.
 * Sets req.userId on success, returns 401 on failure.
 */
export function requireAuth(jwtSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }

    const token = header.slice(7)
    const userId = verifyAccessToken(token, jwtSecret)
    if (!userId || !UUID_RE.test(userId)) {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }

    req.userId = userId
    next()
  }
}

/**
 * Optional auth — extracts userId if token present, but doesn't reject.
 * Allows both authenticated and guest access.
 */
export function optionalAuth(jwtSecret: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7)
      const userId = verifyAccessToken(token, jwtSecret)
      if (userId && UUID_RE.test(userId)) {
        req.userId = userId
      }
    }
    next()
  }
}
