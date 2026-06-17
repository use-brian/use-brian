/**
 * Mini-app registry — installable capabilities that plug into the brain
 * (rendered by the Studio mini-apps store and the unified onboarding
 * capability picker).
 *
 * **Mini-apps vs. primitives.** A mini-app adds a dedicated user-facing
 * surface or external integration to the brain. Workspace primitives like
 * the brain itself, tasks, CRM, and files are not mini-apps — they're
 * always-on data surfaces reached directly through Brain / Studio.
 *
 * **Functional metadata only.** User-visible strings (label, description,
 * comingSoonHint) live in the i18n dictionaries (`apps/web/src/lib/i18n/
 * dictionaries/<locale>.ts` → `workspace.home.miniApps.<id>`) per the
 * project-wide rule in `apps/web/CLAUDE.md`. Components combine the two:
 * iterate `MINI_APPS` for order/status/icon, look up strings by id.
 *
 * Two sources of truth feed the gallery:
 *
 *   1. **Connected mini-apps** — `distribution_profiles` rows for `kind='app'`
 *      assistants (Threads/X today). The web layer joins this registry on
 *      `linkAppType` to surface card status (`Open` vs `Set up`).
 *   2. **Unconnected / future mini-apps** — this static registry. Cards that
 *      have no backing `distribution_profile` (yet) render with their
 *      `status` from here (`available` / `alpha` / `coming_soon`).
 *
 * Why this isn't merged into `app-types.ts`: `AppType` is constrained by the
 * `assistant_app_type_values` CHECK (migration 081). Adding new mini-app ids
 * to `AppType` before those features have any backing code would let the
 * model create assistants of types the runtime doesn't understand. This
 * registry stays decoupled — entries point to an `AppType` via `linkAppType`
 * only when one exists.
 */

import type { AppType } from './app-types.js'

export type MiniAppStatus =
  /** Card is live and clickable. Either always-on or has a backing app
   *  type / distribution profile. Self-serve — the onboarding wizard can
   *  install it end-to-end (see `isSelfServeMiniApp`). */
  | 'available'
  /** Built and usable, but access is gated behind a manual trial request
   *  (limited alpha). The card renders an "Alpha" pill and a "Contact us
   *  for trial" CTA that opens a mailto instead of deep-linking to the
   *  deployable. NOT self-serve: the onboarding wizard neither pre-selects
   *  nor paywalls it. */
  | 'alpha'
  /** Future capability with copy + icon, but no setup flow yet. The card
   *  renders disabled with a "Coming soon" pill. */
  | 'coming_soon'

export type MiniAppId =
  | 'distribution'
  | 'views'

/** Brand identifier for an external platform a mini-app surfaces. Renders as
 *  a small monogram next to the description (e.g. X + Threads on the Feed
 *  card). Pure string so this module has no react/icon-library dependency.
 *  The gallery resolves the brand mark by id. */
export type SupportedApp = 'threads' | 'x'

export type MiniAppMeta = {
  id: MiniAppId
  /** Lucide icon name, rendered by the gallery. Pure string so this module
   *  has no react/icon-library dependency. */
  icon: string
  status: MiniAppStatus
  /** When set, the gallery joins on `distribution_profiles.app_type` to
   *  determine card status (Open / Set up) for connected workspaces. */
  linkAppType?: AppType
  /** True for mini-apps locked behind paid plans; toggles a "Pro" badge on
   *  the card and routes through plan checkout in onboarding (§8 step 3). */
  requiresPaid?: boolean
  /** Pre-selects this card when the unified onboarding wizard is entered
   *  with `?intent=<key>`. */
  defaultIntent?: string
  /** External platforms this mini-app surfaces, rendered as a small icon
   *  strip on the card. Display-only — the actual platform list lives in
   *  the mini-app itself. */
  supportedApps?: readonly SupportedApp[]
}

/** Order matters: this is the rendering order in the gallery. */
export const MINI_APPS: readonly MiniAppMeta[] = [
  // Feed is in limited alpha — access is gated behind a manual trial request
  // ("Contact us for trial"), so the card is not self-serve and the onboarding
  // wizard skips it (see `isSelfServeMiniApp`).
  { id: 'distribution', icon: 'Megaphone',  status: 'alpha', linkAppType: 'distribution', requiresPaid: true, defaultIntent: 'feed', supportedApps: ['threads', 'x'] },
  // Q5 §16 Views — Pro-tier per Option C. Free users still get inline
  // chat-rendered tables (renderView tool stays free); the workspace
  // /views surface + saveView tool are gated by `requiresCapability:'views'`.
  { id: 'views',        icon: 'Table',       status: 'available', requiresPaid: true, defaultIntent: 'views' },
] as const

export const MINI_APP_IDS = new Set<MiniAppId>(MINI_APPS.map((m) => m.id))

/**
 * True when a mini-app can be installed end-to-end by the user without a
 * sales/trial conversation — i.e. the onboarding wizard can fully handle its
 * connect + payment steps. `alpha` apps are contact-gated (see
 * `MiniAppStatus`), so they are *not* self-serve: the wizard neither
 * pre-selects them from `?intent=` nor routes them through plan checkout.
 */
export function isSelfServeMiniApp(m: MiniAppMeta): boolean {
  return m.status === 'available'
}

export function getMiniApp(id: MiniAppId): MiniAppMeta {
  const found = MINI_APPS.find((m) => m.id === id)
  if (!found) throw new Error(`Unknown mini-app id: ${id}`)
  return found
}

/**
 * Look up the mini-app a `?intent=` query param points to. Returns null
 * when the intent doesn't match any registered mini-app — caller decides
 * whether that's a 400 or a silent fallback to the default flow.
 */
export function findMiniAppByIntent(intent: string): MiniAppMeta | null {
  return MINI_APPS.find((m) => m.defaultIntent === intent) ?? null
}
