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
}

export type OfficeToolPort = {
  create(params: { userId: string; assistantId: string; workspaceId: string; family: 'document' | 'presentation' | 'spreadsheet'; outcome: string; audience: string; additionalContext?: string; sourceHandles: string[]; templateId?: string; idempotencyKey: string }): Promise<{ artifactId: string; jobId: string }>
  get(params: { userId: string; artifactId: string; targetOffset?: number }): Promise<OfficeArtifactToolProjection | null>
  revise(params: { userId: string; assistantId: string; artifactId: string; instruction: string; targetIds: string[]; expectedVersion: number; idempotencyKey: string }): Promise<{ jobId: string; mode: 'direct' | 'proposal' } | 'version_conflict' | null>
}

function link(origin: string | undefined, workspaceId: string, artifactId: string): string | undefined {
  return origin ? `${origin.replace(/\/$/, '')}/w/${workspaceId}/office/${artifactId}` : undefined
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
      if (!context.workspaceId) return { data: 'Office artifacts require a workspace.', isError: true }
      if (!canEnableOfficeCreation(input.family)) return { data: 'Office creation is unavailable because the model/editor/render/export/reparse capability barrier is incomplete.', isError: true }
      const result = await params.port.create({ userId: context.userId, assistantId: context.assistantId, workspaceId: context.workspaceId, ...input })
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
      if (!artifact) return { data: 'Office artifact not found or unavailable.', isError: true }
      return { data: { ...artifact, editorUrl: context.workspaceId ? link(params.appOrigin, context.workspaceId, artifact.artifactId) : undefined } }
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
      const result = await params.port.revise({ userId: context.userId, assistantId: context.assistantId, ...input })
      if (result === 'version_conflict') return { data: { code: 'version_conflict', message: 'The artifact changed. Re-read the current version before revising.' }, isError: true }
      if (!result) return { data: 'Office artifact not found or unavailable for revision.', isError: true }
      return { data: result }
    },
  })

  return [createOfficeArtifact, getOfficeArtifact, reviseOfficeArtifact]
}
