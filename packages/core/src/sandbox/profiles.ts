/**
 * Browser profiles (R2-4/R2-6/R2-10; spec computer-use.md §2): a profile is a
 * first-class, clearance-carrying browsing identity — ONE cookie jar, logged
 * into many sites, one account per site (two same-site accounts = two
 * profiles, forced by cookie semantics). Profiles ride the SAME sensitivity
 * ladder as teamspaces/KB/pages; the TOP rung (`confidential`) is owner-only.
 * An assistant may browse as a profile only when it is explicitly enabled for
 * it AND its clearance covers the profile's rung.
 *
 * The store is a port: production backs it with `browser_profiles` (open
 * migration 438); tests may use the in-memory impl. Profile
 * EXISTENCE is always workspace-visible (governance); only session
 * decryption is clearance-gated (the vault + RLS enforce that side).
 */
import { canRead, type Sensitivity } from '../security/sensitivity.js'
import type { SessionVault } from './types.js'

export type BrowserBackendKind = 'local' | 'cloud'
export type LocalBrowserControlMode = 'task_tabs' | 'full_browser'

/**
 * WHOSE turns may use a profile, independent of WHAT clearance a workspace
 * turn needs (migration 451). `clearance` used to carry both, with its top
 * value doubling as "owner-only" — so "only me" could not be said without also
 * demanding a top-cleared assistant, and a private profile was unusable by its
 * owner's own `internal` assistant. See
 * docs/plans/browser-profile-scope-and-clearance.md §1.
 */
export type BrowserProfileScope = 'owner' | 'workspace'

export type BrowserProfile = {
  id: string
  workspaceId: string
  ownerUserId: string
  name: string
  /** Private to the owner, or offered to the workspace at `clearance`. */
  scope: BrowserProfileScope
  /** The rung a WORKSPACE turn must cover. Ignored while `scope` is 'owner'. */
  clearance: Sensitivity
  /** Assistants explicitly enabled for this identity (R2-4). */
  enabledAssistantIds: string[]
  /** Per-assistant selection guidance. This never grants profile access. */
  assistantRoutingNotes?: Record<string, string>
  /** Seeds the interactive toggle; authoritative for unattended runs (R2-3). */
  defaultBackend: BrowserBackendKind
  /** Scope granted to local-browser tasks. Defaults to task-owned tabs. */
  localControlMode: LocalBrowserControlMode
  /** Dormant per-profile BYOP proxy hook (agent-browser `-p`). */
  proxyUrl: string | null
  createdAt: string
  updatedAt: string
}

export type CreateBrowserProfileParams = {
  workspaceId: string
  ownerUserId: string
  name: string
  scope?: BrowserProfileScope
  clearance?: Sensitivity
  defaultBackend?: BrowserBackendKind
  localControlMode?: LocalBrowserControlMode
  proxyUrl?: string | null
  enabledAssistantIds?: string[]
  assistantRoutingNotes?: Record<string, string>
}

export type UpdateBrowserProfileParams = Partial<
  Pick<
    BrowserProfile,
    | 'name'
    | 'scope'
    | 'clearance'
    | 'defaultBackend'
    | 'localControlMode'
    | 'proxyUrl'
    | 'enabledAssistantIds'
    | 'assistantRoutingNotes'
  >
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

export type ProfileDenialReason = 'not_enabled' | 'not_owner' | 'clearance'

/**
 * The profile gate (R2-4, migration 451): explicit enablement, then ONE of two
 * questions depending on scope.
 *
 * An `owner`-scoped profile asks only whose turn this is — clearance does not
 * gate it, because per-assistant enablement is already a deliberate grant its
 * owner made, and the ladder exists to protect workspace data from OTHER
 * people, not the owner from themselves (plan §1, D1). This is the decision
 * that makes "only me" expressible without also demanding a top-cleared
 * assistant, which is what refused `Hinson Secretary` on 2026-08-19.
 */
export function canUseProfile(
  profile: BrowserProfile,
  actor: ProfileActor,
): { ok: true } | { ok: false; reason: ProfileDenialReason } {
  if (!profile.enabledAssistantIds.includes(actor.assistantId)) {
    return { ok: false, reason: 'not_enabled' }
  }
  if (profile.scope === 'owner') {
    return profile.ownerUserId === actor.userId ? { ok: true } : { ok: false, reason: 'not_owner' }
  }
  if (!canRead(actor.assistantClearance, profile.clearance)) {
    return { ok: false, reason: 'clearance' }
  }
  return { ok: true }
}

/**
 * Whether this actor may be TOLD the profile's name (see
 * `describeProfileDenial`). Reachability, never the denial reason: enablement
 * is checked first and short-circuits, so a profile the actor cannot reach at
 * all can still report `not_enabled`.
 */
export function profileIsNameableTo(profile: BrowserProfile, actor: ProfileActor): boolean {
  return profile.scope === 'owner'
    ? profile.ownerUserId === actor.userId
    : canRead(actor.assistantClearance, profile.clearance)
}

/** The acting assistant's note only; whitespace-only guidance is absent. */
export function routingNoteFor(profile: BrowserProfile, assistantId: string): string | null {
  const note = profile.assistantRoutingNotes?.[assistantId]?.replace(/\s+/g, ' ').trim()
  return note || null
}

/**
 * A workspace profile the actor cannot use, with the reason WHY. A denial is
 * not an absence: reporting "no profile" for a profile that exists and is
 * enabled sends the user to re-do the one thing they already did (2026-08-19
 * — an `internal` assistant enabled for a `confidential` profile was told
 * four times to enable it). Existence + metadata are workspace-visible
 * governance data at every rung (spec §2), so naming a blocked profile to a
 * member's own turn leaks nothing; only session USE stays gated.
 */
export type BlockedProfile = {
  name: string
  reason: ProfileDenialReason
  /** The profile's rung, so the remedy can name both sides of the mismatch. */
  clearance: Sensitivity
  /**
   * Whether the actor may be told `name`. Decided by `profileIsNameableTo`
   * at construction, where the actor is in hand — never re-derived from
   * `reason`, which cannot answer it (enablement short-circuits first).
   */
  nameable: boolean
}

export type ProfileResolution =
  | { kind: 'ok'; profile: BrowserProfile }
  | { kind: 'must_name'; candidates: string[]; guidance?: Record<string, string> }
  | { kind: 'not_found'; name: string }
  | { kind: 'denied'; profile: BrowserProfile; reason: ProfileDenialReason }
  | { kind: 'none'; blocked?: BlockedProfile[] }

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
    const guidance = Object.fromEntries(
      candidates.flatMap((profile) => {
        const note = routingNoteFor(profile, actor.assistantId)
        return note ? [[profile.name, note]] : []
      }),
    )
    return {
      kind: 'must_name',
      candidates: candidates.map((p) => p.name),
      ...(Object.keys(guidance).length > 0 ? { guidance } : {}),
    }
  }
  // Zero usable profiles is NOT the same as zero profiles. Carry the denials
  // so the caller can tell "you have none" from "you have one you cannot use".
  const blocked = blockedProfilesFor(all, actor)
  return blocked.length > 0 ? { kind: 'none', blocked } : { kind: 'none' }
}

/** Every workspace profile the actor is gated out of, with the gate's reason. */
export function blockedProfilesFor(
  profiles: BrowserProfile[],
  actor: ProfileActor,
): BlockedProfile[] {
  return profiles.flatMap((profile) => {
    const gate = canUseProfile(profile, actor)
    return gate.ok
      ? []
      : [
          {
            name: profile.name,
            reason: gate.reason,
            clearance: profile.clearance,
            nameable: profileIsNameableTo(profile, actor),
          },
        ]
  })
}

/**
 * One phrasing of a denial, shared by every surface that reports one, so the
 * tool result, the discovery listing, and the navigate error cannot drift into
 * three different remedies for one cause.
 *
 * **What may be said is decided by clearance, never by the reason.** An
 * assistant's clearance exists so it sees LESS than the user it acts for, so a
 * profile whose rung it does not cover is not nameable to it: the name is
 * metadata above its clearance ("Acme-diligence-login" is itself a disclosure).
 * "Existence stays workspace-visible" is a rule about MEMBERS reading the
 * Browsers surface, and does not extend to a lower-cleared principal.
 *
 * Keying this off `reason` would leak, because `canUseProfile` returns
 * `not_enabled` BEFORE it evaluates clearance — a `confidential` profile that
 * is merely un-toggled reports `not_enabled`, and naming it on that basis
 * would disclose exactly what the rung exists to withhold. So the test is
 * `canRead` directly: name it only when the assistant is cleared for the rung;
 * otherwise report the SHAPE of the obstacle and nothing that identifies it.
 */
export function describeProfileDenial(blocked: BlockedProfile, actorClearance: Sensitivity): string {
  if (!blocked.nameable) {
    return blocked.reason === 'not_owner'
      ? 'A browser profile in this workspace is private to another member, so this assistant can neither see nor use it and its name is withheld. Its owner would have to share it with the workspace under Browsers > Browser profiles > Advanced settings.'
      : `A browser profile exists in this workspace whose clearance is above this assistant's (${actorClearance}), so this assistant can neither see nor use it and its name is withheld. Enabling it under Assistant > Tools > Browser identities will NOT help: the clearance rung is the obstacle, not the toggle. The user can raise this assistant's clearance, or lower that profile's required clearance under Browsers > Browser profiles > Advanced settings.`
  }
  switch (blocked.reason) {
    case 'not_enabled':
      return `"${blocked.name}" is not enabled for this assistant. Its owner can enable it under Assistant > Tools > Browser identities.`
    case 'not_owner':
      // Nameable + not_owner cannot both hold: `profileIsNameableTo` requires
      // ownership on the owner-scoped branch. Kept total so a future ordering
      // change degrades to a true sentence rather than a wrong one.
      return `"${blocked.name}" is private to its owner, so only their own turns may use it.`
    case 'clearance':
      return `"${blocked.name}" requires a clearance this assistant does not have (${actorClearance}). Enabling it again will not help: raise this assistant's clearance, or lower the profile's required clearance under Browsers > Browser profiles > Advanced settings.`
  }
}

/**
 * The denials for one zero-candidate resolution, as one sentence run.
 * Deduplicated because every withheld profile yields the same shape-only
 * sentence: three unnameable profiles must read as one obstacle, not as three
 * identical paragraphs that also happen to disclose the count.
 */
export function describeProfileDenials(
  blocked: BlockedProfile[],
  actorClearance: Sensitivity,
): string {
  return [...new Set(blocked.map((entry) => describeProfileDenial(entry, actorClearance)))].join(' ')
}

/** Human-readable tool error for a non-`ok` resolution (shared by the browse tools). */
export function describeProfileResolution(
  res: Exclude<ProfileResolution, { kind: 'ok' }>,
  actorClearance: Sensitivity = 'public',
): string {
  switch (res.kind) {
    case 'must_name':
      return `Several browser profiles match. Name one with the "profile" parameter: ${res.candidates
        .map((candidate) => {
          const guidance = res.guidance?.[candidate]
          return guidance ? `"${candidate}" (${guidance})` : `"${candidate}"`
        })
        .join(', ')}.`
    case 'not_found':
      return `No browser profile named "${res.name}" exists in this workspace. Ask the user to create it in Browsers > Browser profiles, or omit the parameter to use an available profile.`
    case 'denied':
      // Reached only when the model NAMED a profile, so echoing the name back
      // discloses nothing it did not already supply.
      switch (res.reason) {
        case 'not_enabled':
          return `This assistant is not enabled for the browser profile "${res.profile.name}". Its owner can make it available under Assistant > Tools > Browser identities.`
        case 'clearance':
          return `The browser profile "${res.profile.name}" requires a clearance this assistant does not have (${actorClearance}). Enabling it again will not help: raise this assistant's clearance, or lower the profile's required clearance under Browsers > Browser profiles > Advanced settings.`
        case 'not_owner':
          return `The browser profile "${res.profile.name}" is private to its owner ("Who can use it" is set to "Only me"), so only their own turns may use it.`
      }
      break
    case 'none':
      // Only the block-run path (runBrowserSkill) surfaces this — navigate
      // and explore proceed identity-less on 'none' (R2-10). Keep the
      // requirement honest but never let it read as "browsing is blocked"
      // (the 2026-07-15 refusal was the model echoing exactly that belief).
      // A profile that EXISTS but is gated is reported as such: the generic
      // "create one, then enable it" line is a wrong remedy for a denial.
      if (res.blocked?.length) {
        return `No browser profile is USABLE by this assistant. ${describeProfileDenials(res.blocked, actorClearance)} Report this to the user rather than asking them to enable a profile again. Public pages still need no profile.`
      }
      return 'No browser profile is available to this assistant. Running a saved browser skill requires one (skills replay signed-in flows). The user can create one in Browsers > Browser profiles, then make it available under Assistant > Tools > Browser identities. Public pages need no profile: browse them directly with browserNavigate or browserExplore instead.'
  }
}

/**
 * In-memory session vault for tests (the DB impl is the encrypted open
 * `browser_sessions` store) — same profile-scoped port (R2-6).
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

/** In-memory store for tests; production uses the open `browser_profiles` store. */
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
        scope: params.scope ?? 'owner',
        clearance: params.clearance ?? 'confidential',
        enabledAssistantIds: params.enabledAssistantIds ?? [],
        assistantRoutingNotes: params.assistantRoutingNotes ?? {},
        defaultBackend: params.defaultBackend ?? 'cloud',
        localControlMode: params.localControlMode ?? 'task_tabs',
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
        ...('scope' in patch && patch.scope !== undefined ? { scope: patch.scope } : {}),
        ...('clearance' in patch && patch.clearance !== undefined ? { clearance: patch.clearance } : {}),
        ...('defaultBackend' in patch && patch.defaultBackend !== undefined
          ? { defaultBackend: patch.defaultBackend }
          : {}),
        ...('localControlMode' in patch && patch.localControlMode !== undefined
          ? { localControlMode: patch.localControlMode }
          : {}),
        ...('proxyUrl' in patch ? { proxyUrl: patch.proxyUrl ?? null } : {}),
        ...('enabledAssistantIds' in patch && patch.enabledAssistantIds !== undefined
          ? { enabledAssistantIds: patch.enabledAssistantIds }
          : {}),
        ...('assistantRoutingNotes' in patch && patch.assistantRoutingNotes !== undefined
          ? { assistantRoutingNotes: patch.assistantRoutingNotes }
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
