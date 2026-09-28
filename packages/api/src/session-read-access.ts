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
import { canRead, scopeGrantContains, type ScopeGrant } from '@use-brian/core'

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
}

export type SessionReadDecision =
  | { readable: true }
  | { readable: false; status: number; error: string }

/**
 * Decide whether the caller may READ this session (messages, stream,
 * resume). Pure — no I/O. Behavior-identical to the pre-extraction
 * `gateSessionRead` body.
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
  if (session.visibility === 'workspace' || session.mode === 'draft') {
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
 *  1. the caller's own session → `full`;
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
  if (facts.session.visibility === 'workspace' || facts.session.mode === 'draft') {
    return decideSessionRead(facts).readable ? 'full' : 'omitted'
  }
  if (facts.session.userId === facts.callerUserId) return 'full'
  return 'presence'
}
