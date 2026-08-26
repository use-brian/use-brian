/**
 * First-party Office tool surface. [COMP:office/tools]
 *
 * Capability: every tool carries `requiresCapability: 'office'` so the
 * built-in primitive can be switched off per assistant — the grant is what
 * `filterToolsByCapabilities` reads, and a revoked grant drops these tools
 * before the model sees them. See docs/architecture/features/builtin-primitives.md.
 */
import { z } from 'zod'
import { canEnableOfficeCreation } from './templates/compiler.js'
import { buildTool, type Tool } from '../tools/types.js'
import { resolveWriteScope, scopeEvidenceFromRows, type ScopeEvidence } from '../security/context-scope.js'

export type OfficeArtifactToolProjection = {
  artifactId: string
  family: 'document' | 'presentation' | 'spreadsheet'
  mode?: 'artifact' | 'template'
  title: string
  version: number
  lifecycleState: 'active' | 'archived' | 'trash' | 'retained'
  role: 'view' | 'comment' | 'edit'
  targets?: Array<{ id: string; kind: string; label: string; parentId?: string; locked?: boolean }>
  targetsTruncated?: boolean
  nextTargetOffset?: number
  job?: { id: string; status: string; stage: string; errorCode: string | null }
  /** Internal-only root evidence; the tool strips it before model delivery. */
  scopeEvidence?: ScopeEvidence
}

export type OfficeToolPort = {
  create(params: { userId: string; assistantId: string; workspaceId: string; family: 'document' | 'presentation' | 'spreadsheet'; outcome: string; audience: string; additionalContext?: string; sourceHandles: string[]; templateId?: string; idempotencyKey: string; sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[]; compartmentGrant: string[] | null; projectGrant: string[] | null }): Promise<{ artifactId: string; jobId: string }>
  get(params: { userId: string; artifactId: string; targetOffset?: number }): Promise<OfficeArtifactToolProjection | null>
  revise(params: { userId: string; assistantId: string; artifactId: string; instruction: string; targetIds: string[]; expectedVersion: number; idempotencyKey: string; sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[]; compartmentGrant: string[] | null; projectGrant: string[] | null }): Promise<{ jobId: string; mode: 'direct' | 'proposal' } | 'version_conflict' | null>
}

function link(origin: string | undefined, workspaceId: string, artifactId: string): string | undefined {
  return origin ? `${origin.replace(/\/$/, '')}/w/${workspaceId}/office/${artifactId}` : undefined
}

/**
 * The "no artifact came back" miss, in the one shape both reads and revisions
 * use (docs/architecture/engine/tool-executor.md → "Failure copy").
 *
 * `Office artifact not found or unavailable.` was true and useless: it never
 * said which id, never explained that ineligibility and absence are
 * deliberately indistinguishable here (the tool returns no existence signal to
 * an ineligible caller), never named where a real id comes from, and never
 * told the model to stop. There is no list tool to point at — an Office id
 * reaches a session from a createOfficeArtifact result, an editor URL, or the
 * user — so the discovery pointer names those instead.
 */
function artifactUnreachable(tool: string, verb: string, artifactId: string): string {
  return (
    `${tool} could not ${verb} Office artifact ${artifactId}: no artifact with that id is reachable for this caller. ` +
    'Either nothing has that id, or it exists and this session is not eligible to see it — the two are deliberately ' +
    `indistinguishable, because an existence signal would leak the artifact. ${
      verb === 'revise' ? 'Nothing was changed and no job was queued. ' : ''
    }` +
    'Artifact ids come from a createOfficeArtifact result, the /office/<artifactId> editor URL, or the user — ask for ' +
    'the link if you do not have one. Do NOT retry this exact id.'
  )
}

/**
 * Effective allow/ask/block for an Office tool. Boot wires the same L1 (app
 * sentinel) + L2 (per-assistant) strictest-wins resolution over
 * `mcp_tool_settings` (serverName='office') that the files and computer
 * primitives use, and that the Studio / Assistant governance tables already
 * WRITE. Without this hook those writes went nowhere: the toggle persisted and
 * no execution path ever read it, so a user who blocked `reviseOfficeArtifact`
 * still had it run. Absent (tests, open default) the tools' static flags stand.
 */
export type OfficeToolPolicy = 'allow' | 'ask' | 'block'
export type ResolveOfficeToolPolicy = (
  toolName: string,
  context: { userId: string; assistantId: string },
) => Promise<OfficeToolPolicy>

export function createOfficeTools(params: {
  port: OfficeToolPort
  appOrigin?: string
  resolvePolicy?: ResolveOfficeToolPolicy
}): Tool[] {
  /** Execute-time block gate — mirrors workspace-files' `policyBlockGate`.
   *  Fail-open on a resolver error: a policy-lookup outage must not take the
   *  Office surface down. */
  const blockGate = async (
    toolName: string,
    context: { userId: string; assistantId: string },
  ): Promise<{ data: string; isError: true } | null> => {
    if (!params.resolvePolicy) return null
    try {
      if ((await params.resolvePolicy(toolName, context)) === 'block') {
        return {
          data: `ERROR: "${toolName}" is blocked by tool policy for this assistant. A workspace member can change it under Studio > Connectors > Office.`,
          isError: true,
        }
      }
    } catch {
      return null
    }
    return null
  }
  /** Dynamic confirmation — 'ask' overrides the static flag when wired. */
  const askGate = (toolName: string) =>
    params.resolvePolicy
      ? async (context: { userId: string; assistantId: string }) =>
          (await params.resolvePolicy!(toolName, context)) === 'ask'
      : undefined

  const createOfficeArtifact = buildTool({
    name: 'createOfficeArtifact',
    requiresCapability: 'office',
    resolveConfirmation: askGate('createOfficeArtifact'),
    isConcurrencySafe: false,
    isReadOnly: false,
    description: 'Start a durable Brian-native Document, Presentation, or Spreadsheet only after an explicit user request to create/build/draft one. Returns an artifact shell and background job immediately. The worker requires an admitted template and permission-filtered brain grounding. Optional additional context can carry user-supplied facts, constraints, examples, or reference URLs. This tool creates inside the workspace; it does not export, share, send, publish, or bypass a missing-fact/template/permission gate.',
    inputSchema: z.object({
      family: z.enum(['document', 'presentation', 'spreadsheet']),
      outcome: z.string().min(1).max(4_000).describe('The requested deliverable and intended outcome'),
      audience: z.string().min(1).max(1_000),
      additionalContext: z.string().min(1).max(4_000).optional().describe('Optional user-supplied facts, constraints, examples, or reference URLs for this artifact'),
      sourceHandles: z.array(z.string().min(1).max(1_000)).max(100).default([]).describe('Explicit accessible page/file/URL handles named by the user or resolved during the turn'),
      templateId: z.string().uuid().optional(),
      idempotencyKey: z.string().min(8).max(255),
    }),
    async execute(input, context) {
      const blocked = await blockGate('createOfficeArtifact', context)
      if (blocked) return blocked
      if (!context.workspaceId) {
        return {
          data: 'createOfficeArtifact did not run: this chat is not bound to a workspace, and Office artifacts are stored per workspace (`office_artifacts` rows carry the workspace id), so there is nowhere to create one. Nothing was created. No argument change or retry helps in this session — ask the user to open a workspace-scoped chat and request the artifact there.',
          isError: true,
        }
      }
      if (!canEnableOfficeCreation(input.family)) {
        return {
          data:
            `createOfficeArtifact did not create the ${input.family}: this build does not have the complete ` +
            `${input.family} capability barrier (model, editor, render, export, reparse) yet, and creation stays off ` +
            'until every side of it ships. Nothing was created. This is a build-state limit, not a problem with the ' +
            `arguments — no ${input.family} can be created through this tool in this deployment, so do not retry with ` +
            'different arguments. Tell the user the format is not available yet and offer to capture the work another way.',
          isError: true,
        }
      }
      const writeScope = resolveWriteScope({
        sensitivity: 'internal',
        baseCompartments: context.assistantDefaultCompartments,
        baseProjectIds: context.assistantDefaultProjectIds,
        evidence: context.scopeAccumulator,
        compartmentGrant: context.assistantCompartments,
        projectGrant: context.assistantProjectIds,
      })
      const result = await params.port.create({ userId: context.userId, assistantId: context.assistantId, workspaceId: context.workspaceId, ...input, ...writeScope, compartmentGrant: context.compartments ?? null, projectGrant: context.projectIds ?? null })
      return { data: { ...result, status: 'queued', editorUrl: link(params.appOrigin, context.workspaceId, result.artifactId) } }
    },
  })

  const getOfficeArtifact = buildTool({
    name: 'getOfficeArtifact',
    requiresCapability: 'office',
    resolveConfirmation: askGate('getOfficeArtifact'),
    isConcurrencySafe: true,
    isReadOnly: true,
    description: 'Read the current permission-filtered metadata, collaboration role, version, lifecycle, generation state, and one bounded page of the semantic target outline for a Brian-native Office artifact. Use the returned stable target IDs with reviseOfficeArtifact. When nextTargetOffset is present, call again with that targetOffset to continue discovery. Returns no existence signal when the caller is ineligible and never returns binary resources or the complete canonical snapshot.',
    inputSchema: z.object({ artifactId: z.string().uuid(), targetOffset: z.number().int().min(0).optional() }),
    async execute(input, context) {
      const blocked = await blockGate('getOfficeArtifact', context)
      if (blocked) return blocked
      const artifact = await params.port.get({ userId: context.userId, artifactId: input.artifactId, targetOffset: input.targetOffset })
      if (!artifact) return { data: artifactUnreachable('getOfficeArtifact', 'read', input.artifactId), isError: true }
      const { scopeEvidence, ...visibleArtifact } = artifact
      return {
        data: { ...visibleArtifact, editorUrl: context.workspaceId ? link(params.appOrigin, context.workspaceId, artifact.artifactId) : undefined },
        scopeEvidence: scopeEvidence ?? scopeEvidenceFromRows([]),
      }
    },
  })

  const reviseOfficeArtifact = buildTool({
    name: 'reviseOfficeArtifact',
    requiresCapability: 'office',
    resolveConfirmation: askGate('reviseOfficeArtifact'),
    isConcurrencySafe: false,
    isReadOnly: false,
    description: 'Start a fresh context-clean, command-native revision job against an explicit Office artifact version and stable target IDs returned by getOfficeArtifact or selected by the user in the editor. Brian may use the supported canonical Document, Presentation, or Spreadsheet command vocabulary inside those targets. If the artifact advances before the job runs, the validated commands become a proposal instead of overwriting intervening edits. Comment-only callers always receive a proposal. Never use this as implicit authorization to create, export, share, send, publish, or overwrite intervening edits.',
    inputSchema: z.object({
      artifactId: z.string().uuid(),
      instruction: z.string().min(1).max(10_000),
      targetIds: z.array(z.string().uuid()).min(1).max(1_000),
      expectedVersion: z.number().int().min(0),
      idempotencyKey: z.string().min(8).max(255),
    }),
    async execute(input, context) {
      const blocked = await blockGate('reviseOfficeArtifact', context)
      if (blocked) return blocked
      const writeScope = resolveWriteScope({
        sensitivity: 'internal',
        baseCompartments: context.assistantDefaultCompartments,
        baseProjectIds: context.assistantDefaultProjectIds,
        evidence: context.scopeAccumulator,
        compartmentGrant: context.assistantCompartments,
        projectGrant: context.assistantProjectIds,
      })
      const result = await params.port.revise({ userId: context.userId, assistantId: context.assistantId, ...input, ...writeScope, compartmentGrant: context.compartments ?? null, projectGrant: context.projectIds ?? null })
      if (result === 'version_conflict') {
        return {
          data:
            `reviseOfficeArtifact did not start a revision of artifact ${input.artifactId}: it has moved past the ` +
            `version you passed (expectedVersion ${input.expectedVersion}) — a collaborator edited it, or an earlier ` +
            'revision job landed, between your read and this call (version_conflict). Nothing was changed and no job ' +
            `was queued. Call getOfficeArtifact on ${input.artifactId} to read its current version and target ids, ` +
            `then re-issue this instruction against those. Re-sending expectedVersion ${input.expectedVersion} will ` +
            'conflict again.',
          isError: true,
        }
      }
      if (!result) return { data: artifactUnreachable('reviseOfficeArtifact', 'revise', input.artifactId), isError: true }
      return { data: result }
    },
  })

  return [createOfficeArtifact, getOfficeArtifact, reviseOfficeArtifact]
}
