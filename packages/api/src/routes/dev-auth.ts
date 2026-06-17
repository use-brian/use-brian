import { Router } from 'express'
import { createTokens } from '../auth/jwt.js'
import { findOrCreateUser, type User } from '../db/users.js'

/**
 * LOCAL-ONLY dev auth bypass — `POST /auth/dev-login` (GET also accepted for
 * convenience from a browser address bar / curl).
 *
 * Purpose: let a developer get a real, working session against the LOCAL
 * database without going through Google OAuth or the email magic link, so the
 * authenticated UI can be debugged. It does NOT fake auth — it mints the same
 * HS256 JWT pair the real login flow mints (`createTokens`) for a deterministic
 * local user created via `findOrCreateUser` (which also provisions that user's
 * personal workspace + primary assistant). The web layer sets those tokens as
 * the standard `access_token`/`refresh_token`/`user` cookies, so every
 * downstream `authFetch` and RLS-scoped query behaves exactly as a normal
 * logged-in session — the point of using real tokens rather than a stub.
 *
 * ## Why this can never run in production
 *
 * The route is gated at THREE independent layers, any one of which is
 * sufficient on its own:
 *   1. It is only mounted in `apps/api/src/index.ts` when `isLocalDevEnv()` is
 *      true (see that file's conditional `app.use('/auth', devAuthRoutes(...))`).
 *   2. Every request re-checks `isLocalDevEnv()` and 403s otherwise — so even
 *      if a future refactor mounted it unconditionally, it still refuses to
 *      mint a token in production.
 *   3. The web trigger routes (`apps/<app>/src/app/api/auth/dev-login/route.ts`)
 *      and the login-page button are themselves dev-gated, so the path is
 *      unreachable from the product UI in prod.
 *
 * `K_SERVICE` is auto-injected by Cloud Run for every deployed service, so its
 * absence is a reliable "not running in the cloud" signal; `NODE_ENV` is the
 * belt to that braces. See docs/architecture/platform/auth.md → "Local dev
 * auth bypass".
 *
 * Component-map tag: [COMP:api/dev-auth].
 */

/**
 * True only when we are confident the process is a local dev run — never on
 * Cloud Run and never with `NODE_ENV=production`. This is the single source of
 * truth for the bypass gate; do not inline the two checks elsewhere.
 */
export function isLocalDevEnv(): boolean {
  return process.env.NODE_ENV !== 'production' && !process.env.K_SERVICE
}

/**
 * Sanitize the optional `as` identity selector so a developer can sign in as
 * distinct local users (`?as=alice`) to exercise multi-user UI. Restricted to
 * a short kebab/underscore slug — anything else collapses to the default.
 */
function sanitizeAs(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.trim().toLowerCase()
  return /^[a-z0-9_-]{1,32}$/.test(cleaned) ? cleaned : null
}

export type DevAuthDeps = {
  jwtSecret: string | undefined
  /** Injectable for unit tests; defaults to the real DB-backed user upsert. */
  createUser?: typeof findOrCreateUser
  /** Injectable for unit tests; defaults to the real environment gate. */
  isLocal?: () => boolean
}

export function devAuthRoutes(deps: DevAuthDeps): Router {
  const createUser = deps.createUser ?? findOrCreateUser
  const isLocal = deps.isLocal ?? isLocalDevEnv
  const router = Router()

  const handler = async (
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    // Layer 2 gate (see module docstring). Belt-and-braces with the
    // conditional mount in apps/api/src/index.ts.
    if (!isLocal()) {
      res.status(403).json({ error: 'dev_login_disabled' })
      return
    }
    if (!deps.jwtSecret) {
      // Real auth needs JWT_SECRET too; surface the misconfig instead of
      // signing with `undefined` (which would throw deep in node:crypto).
      res.status(503).json({ error: 'jwt_secret_unset' })
      return
    }

    const as = sanitizeAs(req.query.as ?? (req.body as { as?: unknown } | undefined)?.as)
    const authProviderId = as ? `local-dev:${as}` : 'local-dev'
    const email = `${as ?? 'dev'}@localhost`
    const name = as ? as.replace(/[-_]/g, ' ') : 'Local Dev'

    try {
      const { user }: { user: User } = await createUser({
        authProvider: 'dev',
        authProviderId,
        email,
        name,
      })

      const tokens = createTokens(user.id, deps.jwtSecret)

      // Same response shape as POST /auth/google so the web dev-login route
      // can reuse the exact cookie-setting logic.
      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
        ...tokens,
      })
    } catch (err) {
      console.error('[auth/dev-login] failed:', err)
      res.status(500).json({ error: 'dev_login_failed' })
    }
  }

  router.post('/dev-login', handler)
  router.get('/dev-login', handler)

  return router
}
