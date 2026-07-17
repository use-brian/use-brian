import { Router } from 'express'
import { createTokens } from '../auth/jwt.js'
import { findOrCreateUser, type User } from '../db/users.js'
import { isLocalDevEnv } from './dev-auth.js'

/**
 * OSS LOCAL-OWNER SESSION — `GET|POST /auth/local-session`.
 *
 * The consumer front door for the open single-player edition. A local brain has
 * no "login": the launcher (`scripts/launch.mjs`) opens this route, which mints
 * a real session for the machine's **local owner** and 302s into the app. It is
 * deliberately NOT `dev-login`: that route stays a developer bypass that signs
 * you in as "Local Dev" (`dev@localhost`) for debugging the *hosted* edition
 * locally. This one is the product — a neutral owner identity, no email shown.
 *
 * Same real-token mechanics as any login (`createTokens` + `findOrCreateUser`,
 * which also provisions the owner's personal workspace + primary assistant), so
 * every downstream `authFetch` and RLS-scoped query behaves like a normal
 * session. The only differences from `dev-auth` are the identity and the gate.
 *
 * ## Gate (two independent layers)
 *   1. Mounted in `boot.ts` only when `isLocalDevEnv() && isOssEdition()`.
 *   2. Every request re-checks both — so it can never mint a token in the hosted
 *      cloud (`K_SERVICE`/`NODE_ENV=production`) or in the hosted edition.
 *
 * The owner's display name is local config, not user-editable server state: the
 * launcher prompts once, persists it to `~/.sidanclaw/config.json`, and passes
 * it here via `USEBRIAN_OWNER_NAME`. `findOrCreateUser` re-applies it every
 * boot (idempotent against stable config), so the oss account UI shows it
 * read-only. Spec: docs/architecture/platform/auth.md → "Local owner session".
 *
 * Component-map tag: [COMP:api/local-session].
 */

/**
 * True in the open single-player edition. The launcher exports
 * `USEBRIAN_EDITION=oss` (and `NEXT_PUBLIC_USEBRIAN_EDITION=oss` for app-web)
 * into every child's env; either satisfies the server-side gate. Defaults to the
 * hosted edition when unset, so a hosted deploy never opts in by accident.
 */
export function isOssEdition(): boolean {
  return (
    process.env.USEBRIAN_EDITION === 'oss' ||
    process.env.NEXT_PUBLIC_USEBRIAN_EDITION === 'oss'
  )
}

/** The neutral owner identity. No real email — `@local` is never shown in oss UI. */
const OWNER_PROVIDER = 'local'
const OWNER_PROVIDER_ID = 'local-owner'
const OWNER_EMAIL = 'owner@local'
const OWNER_DEFAULT_NAME = 'You'

export type LocalSessionDeps = {
  jwtSecret: string | undefined
  /** From `USEBRIAN_OWNER_NAME` (launcher → ~/.sidanclaw/config.json). */
  ownerName?: string
  /** Injectable for unit tests; defaults to the real DB-backed upsert. */
  createUser?: typeof findOrCreateUser
  /** Injectable for unit tests; defaults to the real local + oss gate. */
  isEnabled?: () => boolean
}

export function localSessionRoutes(deps: LocalSessionDeps): Router {
  const createUser = deps.createUser ?? findOrCreateUser
  const isEnabled = deps.isEnabled ?? (() => isLocalDevEnv() && isOssEdition())
  const router = Router()

  const handler = async (
    _req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    if (!isEnabled()) {
      res.status(403).json({ error: 'local_session_disabled' })
      return
    }
    if (!deps.jwtSecret) {
      res.status(503).json({ error: 'jwt_secret_unset' })
      return
    }

    const name = deps.ownerName?.trim() || OWNER_DEFAULT_NAME

    try {
      const { user }: { user: User } = await createUser({
        authProvider: OWNER_PROVIDER,
        authProviderId: OWNER_PROVIDER_ID,
        email: OWNER_EMAIL,
        name,
      })

      const tokens = createTokens(user.id, deps.jwtSecret)

      // Same response shape as the OAuth + dev-login routes so the web trigger
      // route reuses the exact cookie-setting logic.
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
      console.error('[auth/local-session] failed:', err)
      res.status(500).json({ error: 'local_session_failed' })
    }
  }

  router.post('/local-session', handler)
  router.get('/local-session', handler)

  return router
}
