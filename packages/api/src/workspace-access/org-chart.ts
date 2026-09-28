/** Server-side directory projection. [COMP:api/organization-chart] */
import type { OrganizationChart, OrganizationPlacement, OrganizationSubject, OrganizationUnit } from '@use-brian/shared'

export type DirectoryUnit = OrganizationUnit & { entitled: boolean; teamVisible: boolean }

/** Filter before search, counts and serialization; never return a hidden edge endpoint. */
export function projectOrganizationChart(input: {
  validForMs?: number
  workspaceId: string; revision: string; userId: string; canManage: boolean
  units: DirectoryUnit[]; placements: OrganizationPlacement[]; subjects: OrganizationSubject[]
  teams: Array<{ id: string; name: string }>
}): OrganizationChart {
  const allUnits = new Map(input.units.map(unit => [unit.id, unit]))
  const fullUnits = new Set(input.units.filter(unit => input.canManage || unit.directoryVisibility === 'workspace' || unit.entitled).map(unit => unit.id))
  const knownSubjects = new Set(input.subjects.map(subject => `${subject.kind}:${subject.id}`))
  const placements = input.placements.filter(placement => {
    const unit = allUnits.get(placement.unitId)
    if (!unit || !knownSubjects.has(placement.userId ? `member:${placement.userId}` : `assistant:${placement.assistantId}`)) return false
    return fullUnits.has(unit.id) || (unit.teamId === null && (placement.userId === input.userId || placement.accountableUserId === input.userId))
  })
  const visibleIds = new Set([...fullUnits, ...placements.map(placement => placement.unitId)])
  const units = input.units.filter(unit => visibleIds.has(unit.id)).map(({ entitled: _entitled, teamVisible, ...unit }) => {
    let parentId = unit.parentId
    const seen = new Set([unit.id])
    while (parentId && !visibleIds.has(parentId)) {
      if (seen.has(parentId)) { parentId = null; break }
      seen.add(parentId)
      parentId = allUnits.get(parentId)?.parentId ?? null
    }
    return { ...unit, parentId, teamId: input.canManage || teamVisible ? unit.teamId : null, teamName: input.canManage || teamVisible ? unit.teamName : null }
  })
  const placedSubjects = new Set(placements.map(placement => placement.userId ? `member:${placement.userId}` : `assistant:${placement.assistantId}`))
  const subjects = input.subjects.filter(subject => input.canManage || placedSubjects.has(`${subject.kind}:${subject.id}`) || (subject.kind === 'member' && subject.id === input.userId))
  const people = new Set(subjects.filter(subject => subject.kind === 'member').map(subject => subject.id))
  return {
    validForMs: input.validForMs ?? 0, workspaceId: input.workspaceId, revision: input.revision, canManage: input.canManage, units, subjects,
    placements: placements.map(placement => ({ ...placement,
      reportsToUserId: placement.reportsToUserId && people.has(placement.reportsToUserId) ? placement.reportsToUserId : null,
      accountableUserId: placement.accountableUserId && people.has(placement.accountableUserId) ? placement.accountableUserId : null,
    })),
    teams: input.canManage ? input.teams : input.teams.filter(team => units.some(unit => unit.teamId === team.id)),
  }
}
