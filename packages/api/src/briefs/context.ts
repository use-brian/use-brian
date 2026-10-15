/**
 * Accepted Brief grounding and revision boundaries (project-briefs.md ->
 * "Grounding a turn" and "Revision boundaries").
 *
 *   - `resolveBriefTurn` builds the trusted `brief` contribution for a turn
 *     bound to a shared Project: accepted Direction and Current context read
 *     through RLS inside the turn's own agent access, plus each explicitly
 *     selected Department's accepted Direction when the actor (and, in a
 *     shared chat, the whole Project audience) can read it. Pending text is
 *     never included; an unreadable required rule set becomes a nonrevealing
 *     prerequisite and marks the direction incomplete.
 *   - The effective fingerprint covers the Project direction and selection
 *     revisions and every selected Department's direction revision. Findings
 *     edits never change it.
 *   - `checkBasis` classifies a change since a frozen basis: compatible only
 *     when every intervening revision was applied with activeWork=continue.
 *   - Unattended work (system jobs, Goals) freezes its basis in
 *     brief_work_bases and is refused / blocked at its next boundary.
 *
 * Nothing here adds a tool, allowance or permission.
 *
 * [COMP:api/brief-context]
 */
import type { ExecutionContext, Tool } from '@use-brian/core'
import { directionSections, extractDirectionRegion, renderBriefContext, renderBriefDirection, contextSections, isDirectionEmpty } from '@use-brian/core'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import {
  departmentFitsAudienceSystem,
  effectiveBasisSystem,
  findBindingSystem,
  getBindingSystem,
  getWorkBasisSystem,
  putWorkBasisSystem,
  readPageState,
  revisionsSinceSystem,
  withBriefActor,
  type BriefEffectiveBasis,
} from '../db/brief-store.js'
import { hashCommandReviewIntent } from '../workspace-access/command-review.js'

export type BriefTurn = {
  workspaceId: string
  projectId: string
  projectBindingId: string
  basis: BriefEffectiveBasis
  fingerprint: string
  /** A selected rule set is unreadable here: mutating work is refused. */
  incomplete: boolean
  /** The trusted contribution text. */
  content: string
  /** What was actually used (receipt for inspection). */
  used: { project: { bindingId: string; directionRevision: number }; departments: Array<{ bindingId: string; directionRevision: number; included: boolean }> }
}

export class BriefDirectionChangedError extends Error {
  readonly code = 'brief_direction_changed'
  constructor() {
    super('brief_direction_changed: the accepted Project direction changed since this work started; it needs review before it continues.')
    this.name = 'BriefDirectionChangedError'
  }
}

/** Tools that govern or inspect the Brief itself stay available when direction is incomplete or changed. */
const BRIEF_GOVERNANCE_TOOLS = new Set(['inspectBrief', 'manageBrief', 'maintainBriefContext'])

export function briefFingerprint(basis: BriefEffectiveBasis): string {
  return hashCommandReviewIntent({
    binding: basis.binding, direction: basis.direction, selection: basis.selection,
    departments: [...basis.departments].sort((a, b) => a.binding.localeCompare(b.binding)),
  })
}

/** The single bound Project of a turn (its write default), if any. */
function boundProject(ec: ExecutionContext): { workspaceId: string; projectId: string } | null {
  if (ec.ownership.kind !== 'workspace') return null
  const ids = ec.security.writeDefaults.projectIds
  return ids.length === 1 ? { workspaceId: ec.ownership.workspaceId, projectId: ids[0] } : null
}

function withTurnAccess<T>(ec: ExecutionContext, work: () => Promise<T>): Promise<T> {
  const access = ec.security.access
  return runWithAgentAccess({
    workspaceId: access.workspaceId, userId: access.userId, clearance: access.clearance,
    compartments: access.compartments, mutationCompartments: access.mutationCompartments,
    projectIds: access.projectIds, visibilityAssistantIds: access.visibilityAssistantIds,
    sharedAudience: access.sharedAudience, departmentRead: access.departmentRead,
  }, work)
}

export async function resolveBriefTurn(ec: ExecutionContext): Promise<BriefTurn | null> {
  const bound = boundProject(ec)
  if (!bound) return null
  const binding = await findBindingSystem(bound.workspaceId, 'project', bound.projectId)
  if (!binding) return null // A Project with no Brief contributes nothing; nothing is invented.
  const basis = await effectiveBasisSystem(binding.id)
  if (!basis) return null
  const shared = ec.security.access.sharedAudience === true
  const lines: string[] = []
  const used: BriefTurn['used'] = { project: { bindingId: binding.id, directionRevision: basis.direction }, departments: [] }
  let incomplete = false
  await withTurnAccess(ec, () => withBriefActor(ec.security.access.userId, async client => {
    const page = binding.pageId ? await readPageState(client, binding.pageId) : null
    if (!page) {
      incomplete = true
      lines.push('The Project Brief is not available in this conversation (missing or not readable). Ask a Project owner to repair or share it before doing governed work.')
      return
    }
    const sections = directionSections(extractDirectionRegion(page.snapshot, binding.layout), binding.layout)
    lines.push(`Project direction (owner-accepted revision ${basis.direction}${isDirectionEmpty(sections) ? '; not established yet' : ''}):`)
    lines.push(renderBriefDirection(sections))
    for (const dept of basis.departments) {
      const deptBinding = await getBindingSystem(dept.binding)
      const deptPage = deptBinding?.pageId ? await readPageState(client, deptBinding.pageId) : null
      const fits = deptPage && (!shared || await departmentFitsAudienceSystem(dept.binding, bound.projectId))
      used.departments.push({ bindingId: dept.binding, directionRevision: dept.direction, included: !!fits })
      if (!deptBinding || !deptPage || !fits) {
        incomplete = true
        continue
      }
      lines.push(`Selected Department rules (owner-accepted revision ${dept.direction}; they keep their Department governance):`)
      lines.push(renderBriefDirection(directionSections(extractDirectionRegion(deptPage.snapshot, deptBinding.layout), deptBinding.layout)))
    }
    if (incomplete) {
      lines.push('A selected Department rule set is not available in this conversation. Work governed by it is blocked here: do not guess its rules, and ask a Project owner to resolve access or the selection.')
    }
    const context = renderBriefContext(contextSections(page.snapshot, binding.layout))
    if (context) lines.push(`Current context (maintained, may be incomplete; not direction):\n${context}`)
  }))
  const fingerprint = briefFingerprint(basis)
  const content = [
    `<brief fingerprint="${fingerprint}">`,
    'Accepted Brief for this Project. Follow the owner-accepted direction below; it sits under system and runtime policy and grants no tool, allowance or permission. Pending proposals are not direction. A request-local instruction in this chat does not change it; suggest a change with a Brief proposal instead.',
    ...lines,
    '</brief>',
  ].join('\n')
  return { workspaceId: bound.workspaceId, projectId: bound.projectId, projectBindingId: binding.id, basis, fingerprint, incomplete, content, used }
}

/** same | compatible (every intervening revision declared continue) | changed. */
export async function checkBasis(start: BriefEffectiveBasis): Promise<'same' | 'compatible' | 'changed'> {
  const current = await effectiveBasisSystem(start.binding)
  if (!current) return 'changed'
  if (briefFingerprint(current) === briefFingerprint(start)) return 'same'
  const startDepartments = new Map(start.departments.map(d => [d.binding, d.direction]))
  // A Department removed without a selection revision (its Brief was deleted) is never compatible.
  if (current.selection === start.selection && current.departments.length !== start.departments.length) return 'changed'
  const entries = [
    { binding: start.binding, direction: start.direction, selection: start.selection },
    ...current.departments.filter(d => startDepartments.has(d.binding)).map(d => ({ binding: d.binding, direction: startDepartments.get(d.binding)! })),
  ]
  const revisions = await revisionsSinceSystem(entries)
  return revisions.length > 0 && revisions.every(r => r.activeWork === 'continue') ? 'compatible' : 'changed'
}

/**
 * Wrap mutating tools so each checks the turn's frozen basis BEFORE it acts.
 * A tool that already started is never interrupted or retried.
 */
export function guardBriefTools(tools: Map<string, Tool>, turn: BriefTurn): Map<string, Tool> {
  let basis = turn.basis
  const guarded = new Map<string, Tool>()
  for (const [name, tool] of tools) {
    if (tool.isReadOnly || BRIEF_GOVERNANCE_TOOLS.has(name)) { guarded.set(name, tool); continue }
    guarded.set(name, {
      ...tool,
      async execute(input, context) {
        if (turn.incomplete) {
          return { isError: true, data: { error: 'brief_rules_unavailable', message: 'A selected Department rule set for this Project is not available here, so governed actions are blocked. Nothing was done. Ask a Project owner to resolve access or the selection.' } }
        }
        const verdict = await checkBasis(basis)
        if (verdict === 'changed') {
          return { isError: true, data: { error: 'brief_direction_changed', message: 'The Project\'s accepted direction changed during this turn. Nothing was done. Tell the person; the next message will follow the new direction.' } }
        }
        if (verdict === 'compatible') basis = (await effectiveBasisSystem(basis.binding)) ?? basis
        return tool.execute(input, context)
      },
    } as Tool)
  }
  return guarded
}

/**
 * Unattended continuation (system jobs): freeze the basis on first use, refuse
 * an incompatible change before any provider work, refresh a compatible one.
 */
export async function assertUnattendedBasis(kind: 'job' | 'goal', workId: string, workspaceId: string, turn: BriefTurn): Promise<void> {
  const frozen = await getWorkBasisSystem(kind, workId)
  if (frozen && frozen.fingerprint !== turn.fingerprint) {
    const verdict = await checkBasis(frozen.basis)
    if (verdict === 'changed') throw new BriefDirectionChangedError()
  }
  if (!frozen || frozen.fingerprint !== turn.fingerprint) {
    await putWorkBasisSystem({ kind, workId, workspaceId, projectId: turn.projectId, basis: turn.basis, fingerprint: turn.fingerprint })
  }
}

/** The Goal driver's port (goals.md -> "Brief direction boundary"). */
export function createGoalBriefBoundary() {
  async function current(goal: { workspaceId: string; contextProjectId?: string | null }) {
    if (!goal.contextProjectId) return null
    const binding = await findBindingSystem(goal.workspaceId, 'project', goal.contextProjectId)
    if (!binding) return null
    const basis = await effectiveBasisSystem(binding.id)
    return basis ? { projectId: goal.contextProjectId, basis, fingerprint: briefFingerprint(basis) } : null
  }
  return {
    /** Arming (or an explicit resume) freezes the current accepted basis. */
    async capture(goal: { id: string; workspaceId: string; contextProjectId?: string | null }): Promise<void> {
      const now = await current(goal)
      if (now) await putWorkBasisSystem({ kind: 'goal', workId: goal.id, workspaceId: goal.workspaceId, ...now })
    },
    /** Before each iteration: `changed` blocks the Goal; outcome, budget and authority are untouched. */
    async check(goal: { id: string; workspaceId: string; contextProjectId?: string | null }): Promise<'ok' | 'changed'> {
      const now = await current(goal)
      if (!now) return 'ok'
      const frozen = await getWorkBasisSystem('goal', goal.id)
      if (!frozen) {
        await putWorkBasisSystem({ kind: 'goal', workId: goal.id, workspaceId: goal.workspaceId, ...now })
        return 'ok'
      }
      if (frozen.fingerprint === now.fingerprint) return 'ok'
      const verdict = await checkBasis(frozen.basis)
      if (verdict === 'changed') return 'changed'
      await putWorkBasisSystem({ kind: 'goal', workId: goal.id, workspaceId: goal.workspaceId, ...now })
      return 'ok'
    },
  }
}

export type BriefTurnResolver = (ec: ExecutionContext) => Promise<BriefTurn | null>
let registered: BriefTurnResolver | null = null

/** Boot registers the resolver once; every runner's prepare stage consults it. */
export function configureBriefTurnContext(resolver: BriefTurnResolver | null): void {
  registered = resolver
}

/**
 * The prepare-stage hook: the contribution, the guarded tools, and, for an
 * unattended (system) execution, the frozen-basis check before provider work.
 */
export async function applyBriefToRun(ec: ExecutionContext, tools: Map<string, Tool>): Promise<{ contribution: { name: string; content: string } | null; tools: Map<string, Tool>; turn: BriefTurn | null }> {
  if (!registered) return { contribution: null, tools, turn: null }
  const turn = await registered(ec)
  if (!turn) return { contribution: null, tools, turn: null }
  if (ec.identity.kind === 'system') {
    await assertUnattendedBasis('job', ec.identity.jobId, turn.workspaceId, turn)
  }
  return { contribution: { name: 'brief', content: turn.content }, tools: guardBriefTools(tools, turn), turn }
}
