/** First-party Office tool surface. [COMP:office/tools] */
import { z } from 'zod'
import { canEnableOfficeCreation } from './templates/compiler.js'
import { buildTool, type Tool } from '../tools/types.js'

export type OfficeArtifactToolProjection = {
  artifactId: string
  family: 'document' | 'presentation'
  mode?: 'artifact' | 'template'
  title: string
  version: number
  lifecycleState: 'active' | 'archived' | 'trash' | 'retained'
  role: 'view' | 'comment' | 'edit'
  job?: { id: string; status: string; stage: string }
}

export type OfficeToolPort = {
  create(params: { userId: string; assistantId: string; workspaceId: string; family: 'document' | 'presentation'; outcome: string; audience: string; sourceHandles: string[]; templateId?: string; canonicalWebsite?: string; companyHasNoWebsite: boolean; idempotencyKey: string }): Promise<{ artifactId: string; jobId: string }>
  get(params: { userId: string; artifactId: string }): Promise<OfficeArtifactToolProjection | null>
  revise(params: { userId: string; assistantId: string; artifactId: string; instruction: string; targetIds: string[]; expectedVersion: number; idempotencyKey: string }): Promise<{ jobId: string; mode: 'direct' | 'proposal' } | 'version_conflict' | null>
}

function link(origin: string | undefined, workspaceId: string, artifactId: string): string | undefined {
  return origin ? `${origin.replace(/\/$/, '')}/w/${workspaceId}/office/${artifactId}` : undefined
}

export function createOfficeTools(params: { port: OfficeToolPort; appOrigin?: string }): Tool[] {
  const createOfficeArtifact = buildTool({
    name: 'createOfficeArtifact',
    isConcurrencySafe: false,
    isReadOnly: false,
    description: 'Start a durable Brian-native Document or Presentation only after an explicit user request to create/build/draft one. Returns an artifact shell and background job immediately. The worker requires an admitted template, permission-filtered brain grounding, and a canonical public website unless the user explicitly says the company has none. This tool creates inside the workspace; it does not export, share, send, publish, or bypass a missing-fact/template/permission gate.',
    inputSchema: z.object({
      family: z.enum(['document', 'presentation']),
      outcome: z.string().min(1).max(4_000).describe('The requested deliverable and intended outcome'),
      audience: z.string().min(1).max(1_000),
      sourceHandles: z.array(z.string().min(1).max(1_000)).max(100).default([]).describe('Explicit accessible page/file/URL handles named by the user or resolved during the turn'),
      templateId: z.string().uuid().optional(),
      canonicalWebsite: z.string().url().refine((url) => url.startsWith('https:')).optional(),
      companyHasNoWebsite: z.boolean().default(false),
      idempotencyKey: z.string().min(8).max(255),
    }),
    async execute(input, context) {
      if (!context.workspaceId) return { data: 'Office artifacts require a workspace.', isError: true }
      if (!canEnableOfficeCreation(input.family)) return { data: 'Office creation is unavailable because the model/editor/render/export/reparse capability barrier is incomplete.', isError: true }
      const result = await params.port.create({ userId: context.userId, assistantId: context.assistantId, workspaceId: context.workspaceId, ...input })
      return { data: { ...result, status: 'queued', editorUrl: link(params.appOrigin, context.workspaceId, result.artifactId) } }
    },
  })

  const getOfficeArtifact = buildTool({
    name: 'getOfficeArtifact',
    isConcurrencySafe: true,
    isReadOnly: true,
    description: 'Read the current permission-filtered metadata, collaboration role, version, lifecycle, and generation state for one Brian-native Office artifact. Returns no existence signal when the caller is ineligible.',
    inputSchema: z.object({ artifactId: z.string().uuid() }),
    async execute(input, context) {
      const artifact = await params.port.get({ userId: context.userId, artifactId: input.artifactId })
      if (!artifact) return { data: 'Office artifact not found or unavailable.', isError: true }
      return { data: { ...artifact, editorUrl: context.workspaceId ? link(params.appOrigin, context.workspaceId, artifact.artifactId) : undefined } }
    },
  })

  const reviseOfficeArtifact = buildTool({
    name: 'reviseOfficeArtifact',
    isConcurrencySafe: false,
    isReadOnly: false,
    description: 'Start a fresh context-clean revision job against an explicit Office artifact version and stable target IDs. The job rebases non-overlapping changes; overlaps become a proposal. Comment-only callers always receive a proposal. Never use this as implicit authorization to create, export, share, send, publish, or overwrite intervening edits.',
    inputSchema: z.object({
      artifactId: z.string().uuid(),
      instruction: z.string().min(1).max(10_000),
      targetIds: z.array(z.string().uuid()).max(1_000).default([]),
      expectedVersion: z.number().int().min(0),
      idempotencyKey: z.string().min(8).max(255),
    }),
    async execute(input, context) {
      const result = await params.port.revise({ userId: context.userId, assistantId: context.assistantId, ...input })
      if (result === 'version_conflict') return { data: { code: 'version_conflict', message: 'The artifact changed. Re-read the current version before revising.' }, isError: true }
      if (!result) return { data: 'Office artifact not found or unavailable for revision.', isError: true }
      return { data: result }
    },
  })

  return [createOfficeArtifact, getOfficeArtifact, reviseOfficeArtifact]
}
