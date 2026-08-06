/**
 * [COMP:brain/external-principal] — the runtime half of the discriminator.
 *
 * `external-principal-scope.test.ts` covers the SQL half (the consolidation
 * exclusion). This covers `isExternalPrincipal`, which decides whether a turn
 * accrues a client contact and a `client:*` compartment stamp, plus the fact
 * that both halves derive from one namespace list.
 *
 * The list is the point. A second hand-written copy is how the exclusion and
 * the accrual would silently disagree about who is a client — the drift this
 * module exists to make impossible.
 *
 * See `docs/architecture/features/public-api.md` → "Who counts as a client"
 * and `docs/plans/client-principal.md` §6.1 (decision D1).
 */

import { describe, it, expect } from 'vitest'
import {
  EXTERNAL_PRINCIPAL_NAMESPACES,
  EXTERNAL_PRINCIPAL_PREFIXES,
  excludeExternalPrincipalsSql,
  isExternalPrincipal,
} from '../external-principal.js'

describe('[COMP:brain/external-principal] external-principal discriminator', () => {
  it('recognises the two namespaces the public-turn path mints', () => {
    expect(isExternalPrincipal({ authProvider: 'channel', authProviderId: 'api:key-1:cust_a' })).toBe(true)
    expect(isExternalPrincipal({ authProvider: 'channel', authProviderId: 'chatlink:link-1:v-9' })).toBe(true)
  })

  it('does not treat a teammate shadow as external', () => {
    // Slack / Telegram teammate shadows are workspace non-members but are
    // genuinely team. Membership was rejected as the discriminator precisely
    // so these keep consolidating as intended (D1).
    expect(isExternalPrincipal({ authProvider: 'channel', authProviderId: 'slack:U123' })).toBe(false)
    expect(isExternalPrincipal({ authProvider: 'channel', authProviderId: 'telegram:88991' })).toBe(false)
    expect(isExternalPrincipal({ authProvider: 'channel', authProviderId: 'whatsapp:15550001111' })).toBe(false)
  })

  it('does not treat a real signed-in account as external, whatever its id looks like', () => {
    // A public-API turn whose claims.email matched an existing platform user
    // resolves to that account. The provider check is what stops the accrual
    // path from walling a teammate's own writes off from their team.
    expect(isExternalPrincipal({ authProvider: 'google', authProviderId: 'api:key-1:cust_a' })).toBe(false)
    expect(isExternalPrincipal({ authProvider: 'email', authProviderId: '10293847' })).toBe(false)
  })

  it('matches on the namespace segment, not a bare substring', () => {
    // `apiary:` must not read as `api:`.
    expect(isExternalPrincipal({ authProvider: 'channel', authProviderId: 'apiary:x' })).toBe(false)
    expect(isExternalPrincipal({ authProvider: 'channel', authProviderId: 'x-api:key:1' })).toBe(false)
    expect(isExternalPrincipal({ authProvider: 'channel', authProviderId: 'api' })).toBe(false)
  })

  it('derives the SQL prefixes from the same list as the runtime check', () => {
    expect(EXTERNAL_PRINCIPAL_PREFIXES).toEqual(
      EXTERNAL_PRINCIPAL_NAMESPACES.map((ns) => `${ns}:%`),
    )
    const sql = excludeExternalPrincipalsSql('memories.user_id').replace(/\s+/g, ' ')
    for (const ns of EXTERNAL_PRINCIPAL_NAMESPACES) {
      expect(sql).toContain(`ep_u.auth_provider_id LIKE '${ns}:%'`)
      expect(isExternalPrincipal({ authProvider: 'channel', authProviderId: `${ns}:a:b` })).toBe(true)
    }
    expect(sql).toContain("ep_u.auth_provider = 'channel'")
    expect(sql).toContain('ep_u.id = memories.user_id')
  })
})
