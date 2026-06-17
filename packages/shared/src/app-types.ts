/**
 * App-type metadata — single source of truth for the per-app-type defaults
 * (clearance, label, description) consumed by:
 *
 *   1. `packages/api/src/routes/teams.ts` — assistant creation, default
 *      clearance derivation when caller didn't spell out clearance.
 *   2. `apps/web/src/.../mini-app-gallery` (planned, §5) — card metadata.
 *   3. `apps/web/src/.../onboarding` (planned, §8) — capability picker.
 *   4. `packages/api/src/routes/_prompt-builder.ts` — when a 2nd app type
 *      ships and the dispatch becomes table-driven.
 *
 * ⚠️ Drift hazard: every value in the `assistant_app_type_values` CHECK
 * constraint (migration 081) must also appear here, or assistants of that
 * type cannot have a sensible default clearance. Treat this file as
 * co-load-bearing with that constraint — adding a new app type means
 * touching both in the same PR.
 *
 * Why this is a registry, not a hardcoded `kind === 'app' ? 'public' : ...`:
 * different app types have different trust-tier defaults. Distribution
 * publishes to public platforms → `clearance='public'`. A future CRM app
 * sees private contact data → `clearance='confidential'`. Tying clearance
 * to `kind='app'` collapses these into one wrong rule.
 */

export type AppType = 'distribution'
// Future: 'crm' | 'tasks' | 'workflow' | 'trip' | ...
// (Doc was removed: doc authoring is now a context-injected skill on any
// surface assistant — the workspace primary by default — not an app type. See
// docs/architecture/features/doc.md.)

export type AssistantClearance = 'public' | 'internal' | 'confidential'

export type AppTypeMeta = {
  appType: AppType
  /** Shown in mini-app gallery cards and onboarding capability picker. */
  label: string
  /** One-line description shown alongside the label. */
  description: string
  /** Default clearance applied at assistant creation if caller didn't specify. */
  defaultClearance: AssistantClearance
}

export const APP_TYPES: Record<AppType, AppTypeMeta> = {
  distribution: {
    appType: 'distribution',
    label: 'Threads + X distribution',
    description: 'Publishes posts on behalf of the workspace',
    defaultClearance: 'public',
  },
}

/**
 * Set of recognized app type IDs. Derived from APP_TYPES so the two can't
 * drift. Use for input validation in route handlers.
 */
export const APP_TYPE_IDS = new Set(Object.keys(APP_TYPES) as AppType[])

export function isAppType(value: unknown): value is AppType {
  return typeof value === 'string' && APP_TYPE_IDS.has(value as AppType)
}

/**
 * Default clearance for a given app type. Caller-provided clearance always
 * wins; this is only consulted when clearance was omitted at creation time.
 */
export function defaultClearanceForAppType(appType: AppType): AssistantClearance {
  return APP_TYPES[appType].defaultClearance
}
