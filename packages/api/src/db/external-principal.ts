/**
 * External-principal discriminator — one source for "is this shadow user a
 * consumer's own client rather than a teammate?".
 *
 * The signal is the **auth namespace**: `users.auth_provider = 'channel'` with
 * `auth_provider_id` in the `api:<keyId>:<externalUserId>` or
 * `chatlink:<linkId>:<visitorId>` namespace. Both are minted only by
 * `executePublicTurn`, so they are external by construction.
 *
 * Workspace membership was considered and rejected as the discriminator:
 * Slack / Telegram teammate shadows are non-members but are genuinely team,
 * and excluding them would silently change intended teammate consolidation.
 * See `docs/plans/client-principal.md` §6.1 (decision D1).
 *
 * Two forms, one list. The SQL fragment excludes external authors from the
 * team consolidation passes (Phase 0); the runtime predicate decides whether a
 * turn accrues a client contact and a `client:*` compartment stamp (Phase 3).
 * They MUST stay derived from the same prefixes — a second hand-written copy
 * of a namespace list is exactly the drift this repo has been bitten by
 * before (CLAUDE.md → "Hardcoding a Set … instead of deriving it").
 *
 * Component tag: [COMP:brain/external-principal].
 */

/** Auth-provider-id prefixes that mark a shadow user as an external principal. */
export const EXTERNAL_PRINCIPAL_NAMESPACES = ['api', 'chatlink'] as const

/** The same prefixes as SQL `LIKE` patterns. */
export const EXTERNAL_PRINCIPAL_PREFIXES = EXTERNAL_PRINCIPAL_NAMESPACES.map(
  (ns) => `${ns}:%`,
)

/**
 * `AND NOT EXISTS (…)` fragment excluding rows authored by an external
 * principal. Takes no bind params — the prefixes are compile-time constants,
 * so callers can splice it into any query without renumbering placeholders.
 *
 * Why SQL-side and not worker-side: the team-consolidation index projection
 * carries no `userId` at all, so filtering in `phases.ts` would need a widened
 * projection to reach a worse result. The exclusion belongs at the store,
 * where both team passes inherit it through one edit.
 *
 * `u` is the (optionally alias-qualified) `user_id` column; qualify it
 * consistently with the surrounding query. A NULL `user_id` is never external,
 * so the row survives — unchanged from pre-exclusion behavior.
 *
 * Spec: `docs/architecture/context-engine/memory-consolidation.md` →
 * "External principals".
 */
export function excludeExternalPrincipalsSql(u: string): string {
  const likes = EXTERNAL_PRINCIPAL_PREFIXES.map(
    (p) => `ep_u.auth_provider_id LIKE '${p}'`,
  ).join(' OR ')
  return `AND NOT EXISTS (
             SELECT 1 FROM users ep_u
              WHERE ep_u.id = ${u}
                AND ep_u.auth_provider = 'channel'
                AND (${likes}))`
}

/**
 * Runtime twin of the SQL fragment: is this resolved user an external
 * principal?
 *
 * Deliberately checks the *resolved* user rather than the request shape. A
 * public-API turn whose `claims.email` matches an existing platform account
 * resolves to that real member (`findUserByEmail` in `executePublicTurn`), and
 * that human is a teammate arriving through an odd door, not a client — they
 * must not accrue a client contact or a `client:*` stamp. This is the
 * shadow-claim edge D1 accepts.
 */
export function isExternalPrincipal(user: {
  authProvider: string
  authProviderId: string
}): boolean {
  if (user.authProvider !== 'channel') return false
  return EXTERNAL_PRINCIPAL_NAMESPACES.some((ns) =>
    user.authProviderId.startsWith(`${ns}:`),
  )
}
