/**
 * Introspection toolkit — read-only tools that give the workspace primary
 * assistant operational visibility over its own workspace, closing the P1
 * gaps in the assistant ability audit
 * (docs/plans/assistant-ability-audit.md §1.3 / §6):
 *
 *   - `listPendingApprovals`   — what is waiting on the user.
 *   - `listScheduledJobs`      — what will the assistant do, and when.
 *   - `listResearchRuns`       — what happened to that research job.
 *   - `listWorkspaceSessions`  — recent sessions of the workspace's assistants (§6-a).
 *   - `readSessionTranscript`  — what was said in one of those sessions (§6-a).
 *
 * All are `isReadOnly: true` + `isConcurrencySafe: true`. Workspace scope
 * comes from `ToolContext.workspaceId`, never from model input; the `limit`
 * param defaults to 20 and is capped at 50 so a large result can't blow the
 * model's context budget. The session-history pair (§6-a) is workspace-
 * bounded via the `assistants.workspace_id` join, so other members' PERSONAL
 * assistants are never visible; `readSessionTranscript` verifies the session
 * belongs to a workspace assistant before returning anything and renders an
 * identical not-found message whether the id is unknown or out of scope (no
 * existence oracle).
 *
 * EXPOSURE: this family is registered as an on-demand `mcp_search` local
 * source (serverName `'introspection'`), NEVER direct-injected — the
 * wiring lives in `packages/api/src/mcp/inject.ts` (the orchestrator's
 * job), not here. The factory only builds the tools + reads through the
 * ports in `types.ts`; there is no raw SQL in core.
 *
 * Spec: docs/architecture/engine/introspection-tools.md.
 *
 * [COMP:engine/introspection-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import { uuidId } from '../tools/schema-tolerance.js'
import type { StructuredSchedule } from '../scheduling/schedule.js'
import type {
  IntrospectionDeps,
  IntrospectionPendingApproval,
  IntrospectionScheduledJob,
  IntrospectionWorkerRun,
  IntrospectionSessionSummary,
  IntrospectionTranscriptMessage,
} from './types.js'

/**
 * Shared no-workspace failure for the five introspection tools — names the
 * cause and the retry verdict instead of the bare requirement.
 */
const INTROSPECTION_NO_WORKSPACE =
  'Introspection tools are workspace-scoped and this chat is not bound to a workspace, so there is no apparatus to inspect here. This is not a permission or setup failure, and retrying will not help — tell the user to run this from a workspace chat.'

/** Default row cap. */
const DEFAULT_LIMIT = 20
/** Hard ceiling — never let a model over-fetch and blow the context budget. */
const MAX_LIMIT = 50

/** Default transcript-message cap — the last N messages of a session. */
const DEFAULT_TRANSCRIPT_LIMIT = 30
/** Hard ceiling on transcript messages — a longer read blows the budget. */
const MAX_TRANSCRIPT_LIMIT = 100

/** Shared limit param: optional int, defaulted + capped in the tool body. */
const limitField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(`Max rows to return (default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}).`)

/** Clamp a caller-supplied limit into `[1, MAX_LIMIT]`, defaulting when absent. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  return Math.max(1, Math.min(limit, MAX_LIMIT))
}

/** Clamp a transcript-message limit into `[1, MAX_TRANSCRIPT_LIMIT]`, defaulting when absent. */
function clampTranscriptLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_TRANSCRIPT_LIMIT
  return Math.max(1, Math.min(limit, MAX_TRANSCRIPT_LIMIT))
}

/**
 * The single not-found message for `readSessionTranscript` — used
 * identically whether the session id is unknown OR belongs to a session
 * outside the caller's workspace. Keeping the wording identical is the
 * no-existence-oracle property: the model cannot distinguish "no such
 * session" from "that session is another workspace's".
 */
const SESSION_NOT_FOUND =
  'No session with that id is readable in this workspace. It may not exist, ' +
  'or it may belong to another workspace or a teammate\'s personal assistant ' +
  '(which are not visible here). Use listWorkspaceSessions to find a session id.'

/**
 * Build the introspection tools over the injected ports. Returns a `Tool[]`
 * (the exposure lane in `inject.ts` registers them by name); the order is
 * stable — approvals, scheduled jobs, research runs, workspace sessions,
 * session transcript.
 */
export function createIntrospectionTools(deps: IntrospectionDeps): Tool[] {
  const listPendingApprovals = buildTool({
    name: 'listPendingApprovals',
    description:
      'List the approvals currently awaiting the user in this workspace ' +
      '(read-only). "Pending" means the request is queued and blocked until ' +
      'the user acts on it in the Approvals panel — you cannot approve or ' +
      'reject anything yourself. Use this to answer "what is waiting on me?" ' +
      'or to check whether an action you proposed is still blocked. Returns ' +
      'each pending row: id, kind, the tool it will run (when it has one), ' +
      'when it was created, when it expires, and a short gist.',
    inputSchema: z.object({ limit: limitField }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: INTROSPECTION_NO_WORKSPACE, isError: true }
      }
      const limit = clampLimit(input.limit)
      // The store method is RLS-gated on the caller's userId + returns the
      // whole pending set newest-first; we cap client-side for context safety.
      const rows = (
        await deps.pendingApprovals.listPendingForWorkspace(context.userId, context.workspaceId)
      ).slice(0, limit)
      if (rows.length === 0) {
        return { data: 'No approvals are pending in this workspace.' }
      }
      return { data: rows.map(renderApproval).join('\n') }
    },
  })

  const listScheduledJobs = buildTool({
    name: 'listScheduledJobs',
    description:
      'List this workspace\'s scheduled jobs — reminders and workflow ' +
      'schedule triggers (read-only). Answers "what will you do, and when?" ' +
      'and "is that recurring job still running?". Scope is your own ' +
      'reminders plus every workflow trigger in the workspace (a teammate\'s ' +
      'private reminder stays private). Returns each job: id, its gist, a ' +
      'schedule summary, next / last run time, last status, and whether it ' +
      'is enabled.',
    inputSchema: z.object({ limit: limitField }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: INTROSPECTION_NO_WORKSPACE, isError: true }
      }
      const limit = clampLimit(input.limit)
      const { jobs } = await deps.scheduledJobs.search({
        assistantId: context.assistantId,
        userId: context.userId,
        workspaceId: context.workspaceId,
        limit,
      })
      if (jobs.length === 0) {
        return { data: 'No scheduled jobs in this workspace.' }
      }
      return { data: jobs.map(renderJob).join('\n') }
    },
  })

  const listResearchRuns = buildTool({
    name: 'listResearchRuns',
    description:
      'List recent research fan-out workers in this workspace and their ' +
      'status (read-only). Answers "what happened to that research job?" — ' +
      'use it instead of guessing when a background research run was ' +
      'spawned this session or a recent one. Returns each run: id, status ' +
      '(running / completed / failed / stopped), its query gist, start and ' +
      'finish time (a running row shows no finish), and the originating ' +
      'session id.',
    inputSchema: z.object({ limit: limitField }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: INTROSPECTION_NO_WORKSPACE, isError: true }
      }
      const limit = clampLimit(input.limit)
      const runs = await deps.workerRuns.listRecentForWorkspace(context.workspaceId, limit)
      if (runs.length === 0) {
        return { data: 'No research runs recorded in this workspace.' }
      }
      return { data: runs.map(renderRun).join('\n') }
    },
  })

  const listWorkspaceSessions = buildTool({
    name: 'listWorkspaceSessions',
    description:
      'List recent conversation sessions of this workspace\'s assistants ' +
      '(read-only). As the workspace primary you may read the workspace\'s ' +
      'assistants\' transcripts across channels — use this to answer "what ' +
      'have we been talking about?" or to find a session id for ' +
      'readSessionTranscript. Scope is workspace-bounded: other members\' ' +
      'PERSONAL assistants are never visible. Returns each session: id, the ' +
      'owning assistant\'s name + id, channel type, status, when it started, ' +
      'and last-activity time. Optional channelType filter (e.g. "telegram", ' +
      '"web").',
    inputSchema: z.object({
      limit: limitField,
      channelType: z
        .string()
        .optional()
        .describe(
          'Optional channel filter (e.g. "web", "telegram", "slack", "cron"). Omit for all channels.',
        ),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: INTROSPECTION_NO_WORKSPACE, isError: true }
      }
      const limit = clampLimit(input.limit)
      const sessions = await deps.sessionHistory.listSessionsForWorkspaceSystem(
        context.workspaceId,
        { limit, channelType: input.channelType },
      )
      if (sessions.length === 0) {
        return {
          data: input.channelType
            ? `No ${input.channelType} sessions in this workspace.`
            : 'No sessions in this workspace.',
        }
      }
      return { data: sessions.map(renderSession).join('\n') }
    },
  })

  const readSessionTranscript = buildTool({
    name: 'readSessionTranscript',
    description:
      'Read the recent messages of ONE session by id (read-only). As the ' +
      'workspace primary you may read the workspace\'s assistants\' ' +
      'transcripts; the session must belong to a workspace assistant — a ' +
      'teammate\'s personal-assistant session or another workspace\'s session ' +
      'is reported as not found (no confirmation the id exists). Returns each ' +
      'message as role + a short text gist; tool calls and their results show ' +
      'as one-line markers, never full payloads. Get a sessionId from ' +
      'listWorkspaceSessions first. Optional limit = how many of the most ' +
      `recent messages to return (default ${DEFAULT_TRANSCRIPT_LIMIT}, capped ` +
      `at ${MAX_TRANSCRIPT_LIMIT}).`,
    inputSchema: z.object({
      sessionId: uuidId('session'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `How many recent messages to return (default ${DEFAULT_TRANSCRIPT_LIMIT}, capped at ${MAX_TRANSCRIPT_LIMIT}).`,
        ),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: INTROSPECTION_NO_WORKSPACE, isError: true }
      }
      const limit = clampTranscriptLimit(input.limit)
      const messages = await deps.sessionHistory.getSessionTranscriptForWorkspaceSystem(
        input.sessionId,
        context.workspaceId,
        { limit },
      )
      // A session outside the workspace (or a nonexistent id) returns null —
      // rendered with the SAME wording either way (no existence oracle).
      if (messages === null) {
        return { data: SESSION_NOT_FOUND, isError: true }
      }
      if (messages.length === 0) {
        return { data: 'That session has no messages yet.' }
      }
      return { data: messages.map(renderTranscriptMessage).join('\n') }
    },
  })

  return [
    listPendingApprovals,
    listScheduledJobs,
    listResearchRuns,
    listWorkspaceSessions,
    readSessionTranscript,
  ]
}

// ── Renderers ────────────────────────────────────────────────────────

/** One pending-approval line: id · kind · tool · created · expires · gist. */
function renderApproval(a: IntrospectionPendingApproval): string {
  const parts = [
    `${a.id.slice(0, 8)} · ${a.kind}`,
    a.toolName ? `tool: ${a.toolName}` : null,
    `created ${a.createdAt.toISOString()}`,
    `expires ${a.expiresAt ? a.expiresAt.toISOString() : '(never)'}`,
  ].filter((s): s is string => s !== null)
  const gist = approvalGist(a)
  if (gist) parts.push(`— ${gist}`)
  return parts.join(' · ')
}

/** Best-effort short gist for an approval: payload description, else the tool + a hint of its args. */
function approvalGist(a: IntrospectionPendingApproval): string | null {
  const desc = a.approvalPayload?.description
  if (typeof desc === 'string' && desc.trim() !== '') return truncate(desc, 140)
  // Fall back to a compact hint of the frozen arguments so the model can
  // tell two same-tool approvals apart without echoing the whole input.
  const argKeys = a.arguments ? Object.keys(a.arguments) : []
  if (argKeys.length > 0) return `args: ${argKeys.slice(0, 6).join(', ')}`
  return null
}

/** One scheduled-job line: id · schedule · next · last · status · enabled · gist. */
function renderJob(j: IntrospectionScheduledJob): string {
  const parts = [
    `${j.id.slice(0, 8)} · ${summarizeSchedule(j.schedule)}`,
    j.workflowId ? 'workflow trigger' : 'reminder',
    `next ${j.nextRunAt.toISOString()}`,
    `last ${j.lastRunAt ? j.lastRunAt.toISOString() : '(never run)'}`,
    `status: ${j.lastStatus ?? 'none'}`,
    j.enabled ? 'enabled' : 'disabled',
  ]
  const gist = truncate(j.instructions, 140)
  if (gist) parts.push(`— ${gist}`)
  return parts.join(' · ')
}

/** One worker-run line: id · status · started · finished · session · gist. */
function renderRun(r: IntrospectionWorkerRun): string {
  const terminal = r.status !== 'running'
  const parts = [
    `${r.id.slice(0, 8)} · ${r.status}`,
    `started ${r.createdAt.toISOString()}`,
    `finished ${terminal ? r.updatedAt.toISOString() : '(running)'}`,
    `session ${r.sessionId.slice(0, 8)}`,
  ]
  // Prefer the task description; fall back to the seed prompt.
  const gist = truncate(r.description?.trim() || r.prompt, 140)
  if (gist) parts.push(`— ${gist}`)
  return parts.join(' · ')
}

/** One session line: id · assistant · channel · status · created · last-active. */
function renderSession(s: IntrospectionSessionSummary): string {
  return [
    `${s.id.slice(0, 8)} · ${s.assistantName} (${s.assistantId.slice(0, 8)})`,
    `channel: ${s.channelType}`,
    `status: ${s.status}`,
    `created ${s.createdAt.toISOString()}`,
    `active ${s.lastActiveAt.toISOString()}`,
  ].join(' · ')
}

/**
 * One transcript line: `role: gist`. The gist arrives text-only from the
 * store adapter (tool_use / tool_result already collapsed to `[tool: …]` /
 * `[tool result]` markers); we cap defensively at 300 chars so no single
 * message can dominate the read.
 */
function renderTranscriptMessage(m: IntrospectionTranscriptMessage): string {
  return `${m.role}: ${truncate(m.gist, 300)}`
}

/** Compact human summary of a StructuredSchedule for the model to read. */
function summarizeSchedule(s: StructuredSchedule): string {
  switch (s.type) {
    case 'once':
      return `once @ ${s.datetime}`
    case 'daily':
      return `daily @ ${s.time}`
    case 'weekly':
      return `weekly ${s.days.join('/')} @ ${s.time}`
    case 'monthly':
      return `monthly day ${s.dayOfMonth} @ ${s.time}`
    case 'cron':
      return `cron ${s.expression}`
    default:
      // Exhaustiveness guard — an unknown discriminant renders opaquely
      // rather than throwing (a read tool must never fail on a bad row).
      return 'schedule (unknown)'
  }
}

/** Trim whitespace and cap length, appending an ellipsis when cut. */
function truncate(text: string | null | undefined, max: number): string {
  if (!text) return ''
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}
