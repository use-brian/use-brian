/**
 * Usable-connector resolver — the USER-facing companion to the engine's
 * `resolveConnectorInstances` (../mcp/resolve-connectors.ts).
 *
 * Answers "which connectors can member U actually use inside workspace W?"
 * for the display + config surfaces (Studio → Connectors, the Knowledge
 * repo picker, future workspace pickers). It is the single source of truth
 * those surfaces must mirror, the same way the injection gate is the source
 * of truth for the runtime tool surface (mcp.md → "The display surface must
 * mirror the gate").
 *
 *   usable(U, W) =
 *       U's own personal instances EXPOSED to W  (scope='user' + a live
 *                                                  connector_grant targeting W — any tier)
 *     ∪ workspace-shared instances               (team-native scope='workspace'
 *                                                  + teammate-granted personal)
 *         filtered by canonical human READ in v2, or legacy clearance
 *         plus department reach otherwise (see below)
 *
 * Exposure is the workspace boundary for EVERYONE, owner included: a personal
 * connector connected in workspace A must never surface in workspace B's
 * config pickers unless the owner exposed it to B (the fls.com.hk Knowledge
 * picker leak, 2026-07-06). Connect-in-context auto-exposes to the active
 * workspace (`resolveAutoExpose`, solo included), so the bootstrap flow still
 * lands connectors in the picker; a revoked grant stays revoked.
 *
 * Clearance is a credential-disclosure boundary, so it fails closed: a
 * non-member sees no workspace-shared connectors, and any workspace-shared
 * connector above the member's effective clearance is hidden. Your OWN
 * exposed connectors are never clearance-filtered — you own them.
 *
 * A connector's department labels (`team:<departmentId>`, on the grant for a
 * teammate-exposed instance or on a workspace-owned instance) name its
 * audience: a shared connector labelled with a department is listed only to
 * members holding an unexpired edge in EVERY labelled department at a
 * clearance that reads its tier. General (no label) is listed to every member.
 * Department membership mirrors the runtime gate (`connectorExposureAllowed`);
 * v2 metadata visibility uses per-department tiers without a base-tier cap.
 *
 * The workspace-shared reads are SYSTEM reads (`listForTargetSystem` /
 * `listByWorkspace`) returning the public column set only (never credentials),
 * so a member can see a teammate-shared connector's existence + label + tier
 * without ever reading its secret. Credential resolution for actually *using*
 * a shared connector lives in the caller (e.g. the KB picker's PAT resolver),
 * which re-checks grant + clearance before any system credential read.
 *
 * See docs/architecture/integrations/mcp.md → "Usable connectors".
 * Component tag: [COMP:connectors/usable-resolver].
 */

import { read } from '../context-scope/reference-predicate.js'
import { canRead, type Sensitivity } from '@use-brian/core'
import type { ConnectorInstance, ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import { departmentClearancesForUserSystem } from '../db/department-store.js'
import {
  getWorkspaceMembershipWithReadScopeSystem,
  effectiveReadClearance,
} from '../db/workspace-store.js'

/** How a usable connector reaches the member in this workspace. */
export type UsableConnectorSource = 'personal' | 'team_native' | 'granted'

export type UsableConnector = {
  instance: ConnectorInstance
  source: UsableConnectorSource
  /**
   * Who exposed it to the workspace — set only when `source === 'granted'`.
   * Drives the "Shared by <name>" attribution on the display surfaces.
   */
  grantedByUserId?: string
}

export type ListUsableWorkspaceConnectorsParams = {
  connectorInstanceStore: ConnectorInstanceStore
  connectorGrantStore: ConnectorGrantStore
  userId: string
  workspaceId: string
}

/**
 * Resolve the connectors member `userId` can use inside `workspaceId`.
 * Deduped by instance id; `personal` wins over `granted` for a connector the
 * member both owns and exposed (it's "shared by you", not "shared by a
 * teammate"), and `team_native` over `granted` is impossible (grants only
 * target user-scoped instances).
 *
 * The member's own personal instances are included ONLY when a live
 * `connector_grant` targets this workspace — ownership grants use-anywhere in
 * chat, not presence on every workspace's config surfaces.
 */
export async function listUsableWorkspaceConnectors(
  params: ListUsableWorkspaceConnectorsParams,
): Promise<UsableConnector[]> {
  const { connectorInstanceStore, connectorGrantStore, userId, workspaceId } = params

  const [own, teamNative, granted, membership, departments] = await Promise.all([
    // RLS-gated: the caller's own personal (scope='user') instances.
    connectorInstanceStore.listByUser(userId, userId),
    // RLS-gated: legacy team-native (scope='workspace') instances — readable
    // by any member of the workspace. Empty for a non-member.
    connectorInstanceStore.listByWorkspace(userId, workspaceId),
    // System read: every connector granted to this workspace (incl. teammates'
    // personal instances). Public columns only — never credentials.
    connectorGrantStore.listForTargetSystem('workspace', workspaceId),
    getWorkspaceMembershipWithReadScopeSystem(userId, workspaceId),
    departmentClearancesForUserSystem(userId, workspaceId),
  ])
  const inAudience = (labels: readonly string[], sensitivity: Sensitivity): boolean =>
    labels.every((label) => {
      if (!label.startsWith('team:')) return true
      const clearance = departments.get(label.slice(5))
      return clearance !== undefined && canRead(clearance, sensitivity)
    })

  // Non-member → no workspace-shared visibility at all (fail closed). The
  // member's own personal instances still surface below.
  const ceiling: Sensitivity | null = membership
    ? effectiveReadClearance(membership.role, membership.clearance, 'confidential')
    : null

  const sharedReadable = (labels: readonly string[], sensitivity: Sensitivity): boolean => {
    if (!membership) return false
    if (membership.departmentAccess) {
      if (labels.some(label => !label.startsWith('team:'))) return false
      const { snapshot, principal } = membership.departmentAccess
      return read(snapshot, { principal, assistant: null }, {
        id: 'connector', workspaceId, tier: sensitivity, userId: null,
        departmentIds: labels.map(label => label.slice(5)),
      }, { workspaceId, department: null, now: new Date() })
    }
    return ceiling !== null && canRead(ceiling, sensitivity) && inAudience(labels, sensitivity)
  }

  const byId = new Map<string, UsableConnector>()

  // 1. Own personal, EXPOSED here — any tier (the member owns the credential),
  //    but only where a live grant targets this workspace. Ungranted personal
  //    instances stay out of every workspace surface, the owner's included.
  const grantedInstanceIds = new Set(granted.map((g) => g.instance.id))
  for (const inst of own) {
    if (!grantedInstanceIds.has(inst.id)) continue
    byId.set(inst.id, { instance: inst, source: 'personal' })
  }

  if (ceiling) {
    // 2. Legacy team-native, within clearance.
    for (const inst of teamNative) {
      if (byId.has(inst.id)) continue
      if (!sharedReadable(inst.compartments ?? [], inst.sensitivity)) continue
      byId.set(inst.id, { instance: inst, source: 'team_native' })
    }
    // 3. Teammate-granted personal instances, within clearance. The member's
    //    own grants are skipped — those are already 'personal' above.
    for (const g of granted) {
      if (byId.has(g.instance.id)) continue
      if (g.grantedByUserId === userId) continue
      if (!sharedReadable(g.compartments ?? [], g.instance.sensitivity)) continue
      byId.set(g.instance.id, {
        instance: g.instance,
        source: 'granted',
        grantedByUserId: g.grantedByUserId,
      })
    }
  }

  return [...byId.values()]
}
