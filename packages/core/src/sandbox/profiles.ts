/**
 * Browser profiles (R2-4/R2-6/R2-10; spec computer-use.md §2): a profile is a
 * first-class, clearance-carrying browsing identity — ONE cookie jar, logged
 * into many sites, one account per site (two same-site accounts = two
 * profiles, forced by cookie semantics). Profiles ride the SAME sensitivity
 * ladder as teamspaces/KB/pages; the TOP rung (`confidential`) is owner-only.
 * An assistant may browse as a profile only when it is explicitly enabled for
 * it AND its clearance covers the profile's rung.
 *
 * The store is a port: the platform backs it with `browser_profiles`
 * (closed migration 317); OSS/tests use the in-memory impl. Profile
 * EXISTENCE is always workspace-visible (governance); only session
 * decryption is clearance-gated (the vault + RLS enforce that side).
 */
import { canRead, type Sensitivity } from '../security/sensitivity.js'
import type { SessionVault } from './types.js'

export type BrowserBackendKind = 'local' | 'cloud'

export type BrowserProfile = {
  id: string
  workspaceId: string
  ownerUserId: string
  name: string
  clearance: Sensitivity
  /** Assistants explicitly enabled for this identity (R2-4). */
  enabledAssistantIds: string[]
  /** Seeds the interactive toggle; authoritative for unattended runs (R2-3). */
  defaultBackend: BrowserBackendKind
  /** Dormant per-profile BYOP proxy hook (agent-browser `-p`). */
  proxyUrl: string | null
  createdAt: string
  updatedAt: string
}

export type CreateBrowserProfileParams = {
  workspaceId: string
  ownerUserId: string
  name: string
  clearance?: Sensitivity
  defaultBackend?: BrowserBackendKind
  proxyUrl?: string | null
  enabledAssistantIds?: string[]
}

export type UpdateBrowserProfileParams = Partial<
  Pick<BrowserProfile, 'name' | 'clearance' | 'defaultBackend' | 'proxyUrl' | 'enabledAssistantIds'>
>

export interface BrowserProfileStore {
  get(id: string): Promise<BrowserProfile | null>
  getByName(params: { workspaceId: string; name: string }): Promise<BrowserProfile | null>
  list(params: { workspaceId: string }): Promise<BrowserProfile[]>
  create(params: CreateBrowserProfileParams): Promise<BrowserProfile>
  update(id: string, patch: UpdateBrowserProfileParams): Promise<BrowserProfile | null>
  delete(id: string): Promise<void>
}

/** The identity a profile-gated call executes under (from ToolContext, never model input). */
export type ProfileActor = {
  userId: string
  workspaceId: string
  assistantId: string
  /** The acting assistant's clearance (boot resolves it from the assistant row). */
  assistantClearance: Sensitivity
}

export type ProfileDenialReason = 'not_enabled' | 'clearance' | 'owner_only'

/**
 * The profile gate (R2-4): explicit enablement + clearance coverage, with the
 * top rung owner-only — a `confidential` profile is usable only when the
 * acting user IS the owner, whatever the assistant's clearance says.
 */
export function canUseProfile(
  profile: BrowserProfile,
  actor: ProfileActor,
): { ok: true } | { ok: false; reason: ProfileDenialReason } {
  if (!profile.enabledAssistantIds.includes(actor.assistantId)) {
    return { ok: false, reason: 'not_enabled' }
  }
  if (!canRead(actor.assistantClearance, profile.clearance)) {
    return { ok: false, reason: 'clearance' }
  }
  if (profile.clearance === 'confidential' && profile.ownerUserId !== actor.userId) {
    return { ok: false, reason: 'owner_only' }
  }
  return { ok: true }
}

export type ProfileResolution =
  | { kind: 'ok'; profile: BrowserProfile }
  | { kind: 'must_name'; candidates: string[] }
  | { kind: 'not_found'; name: string }
  | { kind: 'denied'; profile: BrowserProfile; reason: ProfileDenialReason }
  | { kind: 'none' }

/**
 * Call-time profile choice (R2-10): a block/browse is site-scoped and
 * identity-agnostic — the profile is picked at the call. Named → that exact
 * profile (gate-checked). Unnamed → the actor's enabled+cleared set,
 * preferring profiles already logged into the site; exactly one match
 * auto-selects, several force the model to name one, zero → none.
 */
export async function resolveProfileForCall(params: {
  store: BrowserProfileStore
  /** Used to prefer profiles that already hold a live session for the site. */
  vault?: SessionVault | null
  actor: ProfileActor
  site?: string | null
  profileName?: string | null
}): Promise<ProfileResolution> {
  const { store, vault, actor, site, profileName } = params

  if (profileName) {
    const profile = await store.getByName({ workspaceId: actor.workspaceId, name: profileName })
    if (!profile) return { kind: 'not_found', name: profileName }
    const gate = canUseProfile(profile, actor)
    if (!gate.ok) return { kind: 'denied', profile, reason: gate.reason }
    return { kind: 'ok', profile }
  }

  const all = await store.list({ workspaceId: actor.workspaceId })
  let candidates = all.filter((p) => canUseProfile(p, actor).ok)
  if (candidates.length > 1 && site && vault) {
    const withSite: BrowserProfile[] = []
    for (const profile of candidates) {
      try {
        const sessions = await vault.list({ profileId: profile.id })
        if (sessions.some((s) => s.site === site && s.status === 'active')) withSite.push(profile)
      } catch {
        /* a vault hiccup must not fail resolution — fall back to the full set */
      }
    }
    if (withSite.length > 0) candidates = withSite
  }
  if (candidates.length === 1) return { kind: 'ok', profile: candidates[0] }
  if (candidates.length > 1) {
    return { kind: 'must_name', candidates: candidates.map((p) => p.name) }
  }
  return { kind: 'none' }
}

/** Human-readable tool error for a non-`ok` resolution (shared by the browse tools). */
export function describeProfileResolution(res: Exclude<ProfileResolution, { kind: 'ok' }>): string {
  switch (res.kind) {
    case 'must_name':
      return `Several browser profiles match — name one with the "profile" parameter: ${res.candidates.map((c) => `"${c}"`).join(', ')}.`
    case 'not_found':
      return `No browser profile named "${res.name}" exists in this workspace. Ask the user to create it under Settings > Browser profiles, or omit the parameter to use an available profile.`
    case 'denied':
      switch (res.reason) {
        case 'not_enabled':
          return `This assistant is not enabled for the browser profile "${res.profile.name}". A workspace member can enable it under Settings > Browser profiles.`
        case 'clearance':
          return `This assistant's clearance does not cover the browser profile "${res.profile.name}".`
        case 'owner_only':
          return `The browser profile "${res.profile.name}" is owner-only (top clearance rung) and belongs to another user.`
      }
      break
    case 'none':
      // Only the block-run path (runBrowserSkill) surfaces this — navigate
      // and explore proceed identity-less on 'none' (R2-10). Keep the
      // requirement honest but never let it read as "browsing is blocked"
      // (the 2026-07-15 refusal was the model echoing exactly that belief).
      return 'No browser profile is enabled for this assistant. Running a saved browser skill requires one (skills replay signed-in flows) — the user can create and enable it under Settings > Browser profiles. Public pages need no profile: browse them directly with browserNavigate or browserExplore instead.'
  }
}

/**
 * In-memory session vault for OSS boots and tests (the closed impl is the
 * encrypted `browser_sessions` store) — same profile-scoped port (R2-6).
 */
export function createInMemorySessionVault(): SessionVault & {
  bundles: Map<string, { site: string; cookies: unknown[]; capturedAt: string; status: 'active' | 'dead' }>
} {
  const bundles = new Map<
    string,
    { site: string; cookies: unknown[]; capturedAt: string; status: 'active' | 'dead' }
  >()
  const key = (p: { profileId: string; site: string }) => `${p.profileId}:${p.site}`
  return {
    bundles,
    async get(p) {
      const b = bundles.get(key(p))
      return b && b.status === 'active'
        ? { site: b.site, cookies: b.cookies, capturedAt: b.capturedAt }
        : null
    },
    async put(p) {
      bundles.set(key(p), {
        site: p.bundle.site,
        cookies: p.bundle.cookies,
        capturedAt: p.bundle.capturedAt,
        status: 'active',
      })
    },
    async markDead(p) {
      const b = bundles.get(key(p))
      if (b) b.status = 'dead'
    },
    async touch() {},
    async list(p) {
      return [...bundles.entries()]
        .filter(([k]) => k.startsWith(`${p.profileId}:`))
        .map(([, b]) => ({
          site: b.site,
          capturedAt: b.capturedAt,
          lastUsedAt: null,
          status: b.status,
        }))
    },
    async revoke(p) {
      bundles.delete(key(p))
    },
  }
}

/** In-memory store for OSS boots and tests (the closed impl is `browser_profiles`). */
export function createInMemoryBrowserProfileStore(): BrowserProfileStore & {
  profiles: Map<string, BrowserProfile>
} {
  const profiles = new Map<string, BrowserProfile>()
  let counter = 0
  return {
    profiles,
    async get(id) {
      return profiles.get(id) ?? null
    },
    async getByName({ workspaceId, name }) {
      for (const p of profiles.values()) {
        if (p.workspaceId === workspaceId && p.name === name) return p
      }
      return null
    },
    async list({ workspaceId }) {
      return [...profiles.values()].filter((p) => p.workspaceId === workspaceId)
    },
    async create(params) {
      const now = new Date().toISOString()
      const profile: BrowserProfile = {
        id: `profile-${++counter}`,
        workspaceId: params.workspaceId,
        ownerUserId: params.ownerUserId,
        name: params.name,
        clearance: params.clearance ?? 'confidential',
        enabledAssistantIds: params.enabledAssistantIds ?? [],
        defaultBackend: params.defaultBackend ?? 'cloud',
        proxyUrl: params.proxyUrl ?? null,
        createdAt: now,
        updatedAt: now,
      }
      profiles.set(profile.id, profile)
      return profile
    },
    async update(id, patch) {
      const existing = profiles.get(id)
      if (!existing) return null
      const next: BrowserProfile = {
        ...existing,
        ...('name' in patch && patch.name !== undefined ? { name: patch.name } : {}),
        ...('clearance' in patch && patch.clearance !== undefined ? { clearance: patch.clearance } : {}),
        ...('defaultBackend' in patch && patch.defaultBackend !== undefined
          ? { defaultBackend: patch.defaultBackend }
          : {}),
        ...('proxyUrl' in patch ? { proxyUrl: patch.proxyUrl ?? null } : {}),
        ...('enabledAssistantIds' in patch && patch.enabledAssistantIds !== undefined
          ? { enabledAssistantIds: patch.enabledAssistantIds }
          : {}),
        updatedAt: new Date().toISOString(),
      }
      profiles.set(id, next)
      return next
    },
    async delete(id) {
      profiles.delete(id)
    },
  }
}
