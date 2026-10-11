/**
 * The `office` chat lane: a turn in an Office file's shared conversation
 * (`channel_type='office_thread'`).
 *
 * Everyone the file admits reads this thread, so the turn is capped at the
 * file by mechanism, not by prompt: the read ceiling, compartments and Projects
 * are the file's labels intersected with the sender's reach (`maximumAccess`),
 * and everything the turn persists carries the file's labels
 * (`pinnedWriteDefaults`). No new predicate: `resolveExecutionContextSystem`
 * intersects with the existing helpers. Only a Comment- or Edit-role sender
 * with mutation reach may run a turn, and an edit still goes through the one
 * revision path (`reviseOfficeArtifact` -> `service.revise`), which re-resolves
 * access for the sender: Edit lands direct, Comment lands a proposal.
 *
 * Spec: docs/architecture/features/office.md -> "Brian conversation in the file".
 * [COMP:api/office-chat-lane]
 */
import { z } from 'zod'
import { ambientSurfaceLine, type AccessCeiling, type Tool } from '@use-brian/core'
import { resolveOfficeAccess, type ResolvedOfficeAccess } from '../office/access.js'
import {
  findOfficeArtifactForSessionSystem,
  latestOfficeJobSystem,
  readOfficeLaneArtifactSystem,
  type OfficeArtifactSessionLink,
} from '../db/office-artifact-sessions.js'

export type OfficeLaneArtifact = {
  id: string
  workspaceId: string
  family: string
  title: string
  headVersion: number
  lifecycleState: string
  sensitivity: 'public' | 'internal' | 'confidential'
  compartments: string[]
  projectIds: string[]
}

export type OfficeLaneJob = { id: string; jobKind: string; status: string } | null

export type OfficeLane = {
  artifact: OfficeLaneArtifact
  access: ResolvedOfficeAccess
  job: OfficeLaneJob
  selection: string[]
}

export type OfficeLaneRefusal = { code: string; error: string }

export type OfficeLaneDeps = {
  findLink(sessionId: string): Promise<OfficeArtifactSessionLink | null>
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  /** System-side read of the root's labels; the caller has already passed `resolveAccess`. */
  getArtifact(artifactId: string): Promise<OfficeLaneArtifact | null>
  latestJob(artifactId: string): Promise<OfficeLaneJob>
}

/** Generation jobs whose sends are steering or recovery, never a chat turn. */
const GENERATION_KINDS = new Set(['create', 'import', 'template_compile'])
const OPEN_STATUSES = new Set(['queued', 'running', 'needs_input'])
const SelectionSchema = z.object({ targetIds: z.array(z.string().uuid()).max(50) }).strict()

/** The sender's selection, as a bounded list of target ids. Anything else is dropped. */
export function parseOfficeSelection(raw: unknown): string[] {
  const parsed = SelectionSchema.safeParse(raw)
  return parsed.success ? [...new Set(parsed.data.targetIds)] : []
}

/**
 * Admit a turn in an Office thread, or refuse it. A non-sender (View-only,
 * temporary read, no mutation reach, inactive file) is refused; a caller who
 * cannot read the file gets the same refusal as a missing thread.
 */
export async function resolveOfficeLane(
  params: { userId: string; sessionId: string; selection?: unknown },
  deps: OfficeLaneDeps,
): Promise<{ lane: OfficeLane } | { refused: OfficeLaneRefusal }> {
  const link = await deps.findLink(params.sessionId)
  const access = link ? await deps.resolveAccess(params.userId, link.artifactId) : null
  if (!link || !access) return { refused: { code: 'session_access_denied', error: 'Session not found' } }
  if (!access.canComment) {
    return { refused: { code: 'office_chat_read_only', error: 'You can read this conversation but not send to it. Ask an editor of the file for Comment or Edit access.' } }
  }
  const [artifact, job] = await Promise.all([deps.getArtifact(link.artifactId), deps.latestJob(link.artifactId)])
  if (!artifact || artifact.workspaceId !== link.workspaceId) return { refused: { code: 'session_access_denied', error: 'Session not found' } }
  if (job && GENERATION_KINDS.has(job.jobKind) && OPEN_STATUSES.has(job.status)) {
    return { refused: { code: 'office_generation_active', error: 'This file is still being generated. Messages sent now steer the generation instead of starting a chat turn.' } }
  }
  return { lane: { artifact, access, job, selection: parseOfficeSelection(params.selection) } }
}

/**
 * The file as a ceiling: its sensitivity bounds the read clearance and the
 * response, its compartments and Projects bound what the turn may read and
 * write. Intersected with the sender's own reach by the resolver.
 */
export function officeLaneMaximumAccess(lane: Pick<OfficeLane, 'artifact'>, userId: string): AccessCeiling {
  const { artifact } = lane
  return {
    workspaceId: artifact.workspaceId,
    userId,
    clearance: artifact.sensitivity,
    compartments: [...artifact.compartments].sort(),
    mutationCompartments: [...artifact.compartments].sort(),
    projectIds: [...artifact.projectIds].sort(),
    visibilityAssistantIds: null,
  }
}

/** Everything a file-chat turn persists carries the file's labels. */
export function officeLaneWriteDefaults(lane: Pick<OfficeLane, 'artifact'>): { compartments: string[]; projectIds: string[] } {
  return { compartments: [...lane.artifact.compartments], projectIds: [...lane.artifact.projectIds] }
}

/**
 * Private runtime context for the turn (system channel only). Names the
 * product surface, never a tool. The selection is a hint, not a limit.
 */
export function officeLaneContextBlock(lane: OfficeLane): string {
  const { artifact, job, selection, access } = lane
  return [
    '# Office file conversation',
    ambientSurfaceLine('office'),
    `- File id: ${artifact.id}`,
    `- Family: ${artifact.family}`,
    `- Title: ${JSON.stringify(artifact.title)}`,
    `- Head version: ${artifact.headVersion}`,
    `- Lifecycle: ${artifact.lifecycleState}`,
    `- Sender's role on this file: ${access.canEdit ? 'edit (changes apply directly and are restorable in History)' : 'comment (changes become a proposal for an editor)'}`,
    `- Latest job: ${job ? `${job.jobKind} (${job.status})` : 'none'}`,
    selection.length
      ? `- Focus hint: the sender has these target ids selected: ${selection.join(', ')}. Treat them as a hint, not a limit; the request decides the scope.`
      : '- Focus hint: nothing is selected. Read the file outline and choose the targets the request needs.',
    'This conversation and its answers are visible to everyone who can read this file, so keep answers within what the file itself would show. Edits to this file run as a revision job that you start; its card in this thread reports the outcome, so do not wait for it or say it finished.',
  ].join('\n')
}

const BOUND_TOOLS = new Set(['getOfficeArtifact', 'reviseOfficeArtifact'])

/**
 * Replace every Office tool in the turn's registry with the two this lane
 * offers, bound to the thread's file. The capability grant is not required
 * here: the file's Brian tab is the Office surface itself, and every call
 * still runs the tool's own policy gate and the Office access checks.
 */
export function bindOfficeLaneTools(tools: Map<string, Tool>, source: ReadonlyMap<string, Tool>, artifactId: string): Map<string, Tool> {
  for (const [name, tool] of tools) if (tool.requiresCapability === 'office') tools.delete(name)
  for (const name of BOUND_TOOLS) {
    const tool = source.get(name)
    if (!tool) continue
    const bound: Tool = {
      ...tool,
      requiresCapability: undefined,
      async execute(input, context) {
        const requested = (input as { artifactId?: unknown }).artifactId
        if (requested !== artifactId) {
          return {
            data: `${name} did not run: this conversation belongs to Office file ${artifactId}, and ${name} here only works on that file (you passed ${String(requested)}). Nothing was read or changed. Call it again with artifactId ${artifactId}.`,
            isError: true,
          }
        }
        return tool.execute(input, context)
      },
    }
    tools.set(name, bound)
  }
  return tools
}

/**
 * The execution bounds for `resolveExecutionContextSystem`: the file as the
 * maximum ceiling, re-checked live so a revoked reader stops tool execution,
 * and the file's labels as the write defaults.
 */
export function officeLaneExecutionBounds(lane: OfficeLane, userId: string, deps: Pick<OfficeLaneDeps, 'resolveAccess'>) {
  const maximumAccess = officeLaneMaximumAccess(lane, userId)
  return {
    maximumAccess,
    maximumAccessCurrent: async () => (await deps.resolveAccess(userId, lane.artifact.id)) ? maximumAccess : null,
    pinnedWriteDefaults: officeLaneWriteDefaults(lane),
  }
}

export const DEFAULT_OFFICE_LANE_DEPS: OfficeLaneDeps = {
  findLink: findOfficeArtifactForSessionSystem,
  resolveAccess: resolveOfficeAccess,
  getArtifact: readOfficeLaneArtifactSystem,
  latestJob: latestOfficeJobSystem,
}
