/**
 * Pure session read-access predicate — the single decision both
 * `gateSessionRead` (routes/sessions.ts) and the Live roster
 * (routes/live-work.ts) apply, extracted so the gate and the roster
 * cannot drift (Live D9/§3.3: tiering is server-side and reuses the
 * exact gate predicate, never a re-implementation).
 *
 * The callers own the async fact-resolution (assistant → workspace,
 * caller → membership clearance); this module only decides. The rule,
 * verbatim from the gate's history: a `visibility='workspace'` session
 * (doc comment threads, migration 223) or a `mode='draft'` session is
 * readable by any workspace member at/above the session's
 * `effective_clearance` (migration 224); every other session is
 * owner-only.
 *
 * Spec: docs/architecture/features/live-work.md → "Privacy tiers".
 *
 * [COMP:api/live-work-roster]
 */
import { read, type AccessSnapshot, type Principal, type Tier } from './context-scope/reference-predicate.js'
import { canRead, scopeGrantContains, type ScopeGrant } from '@use-brian/core'
import { classifySession } from './session-kind.js'

/** Workspace audience per the one classifier (rooms, threads, drafts). */
function workspaceAudience(session: Pick<ReadGatedSessionFields, 'visibility' | 'mode'>): boolean {
  // The audience is the stored visibility (drafts are 'workspace' since
  // migration 741); the legacy mode fallback covers in-memory rows.
  return classifySession({ channelType: 'web', visibility: session.visibility, mode: session.mode, anchorKind: null }).audience === 'workspace'
}

/** The session fields the read decision consumes. */
export type ReadGatedSessionFields = {
  userId: string
  visibility: string | null
  mode: string | null
  effectiveClearance: string | null
  contextCompartments?: string[]
  contextProjectId?: string | null
}

/** Resolved facts the pure decision needs — callers do the async lookups. */
export type SessionReadFacts = {
  callerUserId: string
  session: ReadGatedSessionFields
  /**
   * The owning assistant's workspace, or null for a personal assistant.
   * Only consulted for workspace-visible / draft sessions.
   */
  assistantWorkspaceId: string | null
  /** The caller's clearance in that workspace; null = not a member. */
  membershipClearance: 'public' | 'internal' | 'confidential' | null
  /** Null is an owner/admin universe grant; [] grants no named Team/Project. */
  membershipCompartments?: ScopeGrant
  membershipProjectIds?: ScopeGrant
  departmentAccess?: { snapshot: AccessSnapshot; principal: Principal }
  now?: Date
}

export type SessionReadDecision =
  | { readable: true }
  | { readable: false; status: number; error: string }

/**
 * Decide whether the caller may READ this session (messages, stream,
 * resume). Pure, with the canonical department READ for v2 workspace facts.
 */
export function decideSessionRead(facts: SessionReadFacts): SessionReadDecision {
  const {
    callerUserId,
    session,
    assistantWorkspaceId,
    membershipClearance,
    membershipCompartments,
    membershipProjectIds,
  } = facts
  if (facts.departmentAccess && assistantWorkspaceId) {
    const { snapshot, principal } = facts.departmentAccess
    const compartments = session.contextCompartments ?? []
    const tier = session.effectiveClearance ?? 'public'
    if (!['public', 'internal', 'confidential'].includes(tier)
      || compartments.some(key => !key.startsWith('team:'))) {
      return { readable: false, status: 403, error: 'Session context unavailable' }
    }
    const allowed = read(snapshot, { principal, assistant: null }, {
      id: 'session', workspaceId: assistantWorkspaceId, tier: tier as Tier,
      departmentIds: compartments.map(key => key.slice(5)),
      userId: workspaceAudience(session) ? null : session.userId,
    }, { workspaceId: assistantWorkspaceId, department: null, now: facts.now ?? new Date() })
    return allowed ? { readable: true } : { readable: false, status: 403, error: 'Session context unavailable' }
  }
  if (workspaceAudience(session)) {
    if (!assistantWorkspaceId) {
      return { readable: false, status: 403, error: 'Draft session is not team-owned' }
    }
    if (!membershipClearance) {
      return { readable: false, status: 403, error: 'Not a member of this team' }
    }

    if (
      session.effectiveClearance &&
      !canRead(membershipClearance, session.effectiveClearance as 'public' | 'internal' | 'confidential')
    ) {
      return { readable: false, status: 403, error: 'Insufficient clearance' }
    }
    if (!scopeGrantContains(membershipCompartments, session.contextCompartments ?? [])) {
      return { readable: false, status: 403, error: 'Session context unavailable' }
    }
    if (!scopeGrantContains(
      membershipProjectIds,
      session.contextProjectId ? [session.contextProjectId] : [],
    )) {
      return { readable: false, status: 403, error: 'Session context unavailable' }
    }
    return { readable: true }
  }
  if (session.userId !== callerUserId) return { readable: false, status: 403, error: 'Forbidden' }
  return { readable: true }
}

/**
 * The Live roster's per-row tier (§3.3). Precedence is the spec's table,
 * top to bottom:
 *
 *  1. the caller's own session → `full` only while readable;
 *  2. workspace-visible / draft → the read decision above: readable →
 *     `full`, otherwise `omitted` (D5 — the existence of an
 *     above-clearance workstream is itself confidential, so a
 *     clearance-fail is invisible, never presence);
 *  3. a teammate's personal session on a workspace assistant →
 *     `presence` (D4 — the projection allowlist lives at the route).
 *
 * Sessions on non-workspace (personal) assistants never reach this
 * function: the roster query's `assistants.workspace_id = $ws` join is
 * the §6-a structural boundary.
 */
export type LiveSessionTier = 'full' | 'presence' | 'omitted'

export function liveSessionTier(facts: SessionReadFacts): LiveSessionTier {
  if (workspaceAudience(facts.session)) {
    return decideSessionRead(facts).readable ? 'full' : 'omitted'
  }
  if (facts.session.userId === facts.callerUserId) return decideSessionRead(facts).readable ? 'full' : 'omitted'
  // Presence discloses identity and activity. In v2 it must pass the same
  // department/tier floor, but deliberately does not grant the private body.
  if (facts.departmentAccess && !decideSessionRead({
    ...facts,
    session: { ...facts.session, visibility: 'workspace', mode: null },
  }).readable) return 'omitted'
  return 'presence'
}
