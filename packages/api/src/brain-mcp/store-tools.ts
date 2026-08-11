/**
 * Which commerce-store tools a custom Home app may reach through the bridge.
 *
 * A Home app is third-party code running in a sandboxed opaque-origin iframe.
 * Until `scopes.store` existed, the worst a malicious bundle could do was read
 * a brain an admin had granted it. Store access reaches money and a public
 * storefront, so the tool list is derived here, in one place, under three
 * rules that are meant to be read together:
 *
 *   1. **The registry is the source of truth.** Classification comes from
 *      `OFFICIAL_CONNECTOR_TOOLS[connectorId]`, never a list maintained here.
 *      A hardcoded copy is how a tool added to the registry silently arrives
 *      with the wrong reach — the same drift the "all built-ins" rule in
 *      CLAUDE.md exists to prevent.
 *
 *   2. **Destructive tools are excluded at EVERY tier**, including `write`.
 *      Not by default policy — by construction. Refunds, cancellations,
 *      completing a draft order and writing a theme template are
 *      `classification: 'destructive'` because they move money or change what
 *      customers see, and their safety model is the chat Approve/Deny card. A
 *      bundle frame has no chat channel to show one on. An app that needs a
 *      destructive effect STAGES it for the Approvals inbox instead
 *      (docs/architecture/features/home-apps.md → "Store scope").
 *
 *      `alsoAllow` is the ONE crack, and it is deliberately not a tier: it
 *      admits tools BY NAME, so widening it is never accidental and never
 *      class-wide. It exists for first-party native app surfaces, which do
 *      have a channel to confirm on (`confirmDialog`) and which the merchant
 *      reached through their own signed-in session rather than through a
 *      bundle someone published. **Nothing on the bundle path may pass it**;
 *      see `apps-shopify.ts` for the single caller that does, and
 *      docs/architecture/integrations/shopify.md → "The native app is a
 *      different consumer" for why `shopifyCreateProductTemplate` in
 *      particular is the safe member of that class.
 *
 *   3. **An unrecognized tool is dropped, not passed through.**
 *      `gateToolsOnActionGrants` deliberately passes registry-unknown tools
 *      untouched, because there the caller is a first-party assistant and an
 *      unknown tool is a read helper someone forgot to register. Here the
 *      caller is third-party code, so the same input has the opposite correct
 *      answer: a tool whose classification we cannot establish is a tool whose
 *      blast radius we cannot establish. Fail closed.
 *
 * The effective tier is already the narrowest of the manifest's request, the
 * admin's grant, and the bridge token's claim (`brain-mcp/auth.ts`). This
 * function applies the last intersection: against what each tool actually does.
 *
 * [COMP:api/home-app-store-tools]
 */

import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import type { AppStoreScope } from '@use-brian/brian-app'
import { baseToolName } from '../mcp/inject.js'

/** The minimum tier that may reach each classification. `destructive` is absent
 *  on purpose: there is no tier that reaches it. */
const TIER_FOR_CLASSIFICATION: Record<string, AppStoreScope | undefined> = {
  read: 'read',
  write: 'write',
}

const TIER_RANK: Record<AppStoreScope, number> = { none: 0, read: 1, write: 2 }

/**
 * Names a `storeScope` tier may reach for one connector.
 *
 * Exported separately from the filter so the consent screen and the tests can
 * ask "what does granting this actually hand over?" without holding real tool
 * instances.
 */
export function storeToolNamesFor(
  connectorId: string,
  storeScope: AppStoreScope,
  /**
   * Extra tools admitted BY NAME, on top of what the tier reaches.
   *
   * Only a name already in this connector's registry can be admitted: an
   * unknown name is dropped rather than trusted, so a typo here fails closed
   * and a caller cannot mint reach for a tool that does not exist. `none`
   * still means none.
   */
  alsoAllow: readonly string[] = [],
): ReadonlySet<string> {
  const allowed = new Set<string>()
  if (storeScope === 'none') return allowed
  const named = new Set(alsoAllow)
  for (const entry of OFFICIAL_CONNECTOR_TOOLS[connectorId] ?? []) {
    if (named.has(entry.name)) {
      allowed.add(entry.name)
      continue
    }
    const required = TIER_FOR_CLASSIFICATION[entry.classification]
    // `undefined` covers `destructive` AND any classification a future build
    // adds that this one has never heard of. Both must fail closed.
    if (!required) continue
    if (TIER_RANK[storeScope] >= TIER_RANK[required]) allowed.add(entry.name)
  }
  return allowed
}

/**
 * Filter a connector's tool instances down to what `storeScope` may reach.
 *
 * Generic over the tool shape so it can be unit-tested against name-only
 * stubs — the filtering decision depends on nothing but the name.
 */
export function filterStoreTools<T extends { name: string }>(
  tools: readonly T[],
  opts: { connectorId: string; storeScope: AppStoreScope; alsoAllow?: readonly string[] },
): T[] {
  const allowed = storeToolNamesFor(opts.connectorId, opts.storeScope, opts.alsoAllow)
  // Match on the CANONICAL name: a multi-store workspace injects a parallel
  // tool set per extra instance under `<name>__<label>_<id8>` names. Matching
  // raw names would drop every extra store — safe, but a silent, confusing
  // hole where a second store simply has no tools and nothing says why.
  return tools.filter((tool) => allowed.has(baseToolName(tool.name)))
}

/**
 * Tool names an app-triggered ASSISTANT turn may use.
 *
 * This is the whole safety story for `scopes.agent`. The turn runs on the
 * workspace assistant, which normally holds far more than a Home app does —
 * so without an allow-list, "ask the assistant to refund order 1042" would be
 * a way to reach, through the model, exactly what the direct tool gate
 * refused. The consult is therefore intersected with the app's OWN ceiling:
 * the same `storeToolNamesFor` set, destructive tools already absent.
 *
 * The model can still decline, ask for more detail, or reason across several
 * calls — it just cannot exceed the app.
 */
export function agentAllowedToolsFor(
  connectorId: string,
  storeScope: AppStoreScope,
): string[] {
  return [...storeToolNamesFor(connectorId, storeScope)]
}

