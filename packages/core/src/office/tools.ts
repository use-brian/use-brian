/**
 * First-party Office tool surface. [COMP:office/tools] [COMP:office/pdf-tools]
 *
 * Capability: every tool carries `requiresCapability: 'office'` so the
 * built-in primitive can be switched off per assistant — the grant is what
 * `filterToolsByCapabilities` reads, and a revoked grant drops these tools
 * before the model sees them. See docs/architecture/features/builtin-primitives.md.
 */
import { z } from 'zod'
import { canEnableOfficeCreation } from './templates/compiler.js'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import { resolveWriteScope, scopeEvidenceFromRows, type ScopeEvidence } from '../security/context-scope.js'

export const OfficeGenerationTemplateSelection = z.object({
  artifactId: z.string().uuid(), jobId: z.string().uuid(), templateVersionId: z.string().uuid(),
}).strict()
export type OfficeTemplateChoice = { templateVersionId: string; name: string }

export type OfficeArtifactToolProjection = {
  artifactId: string
  family: 'document' | 'presentation' | 'spreadsheet' | 'pdf'
  mode?: 'artifact' | 'template' | 'session'
  title: string
  version: number
  expiresAt?: string
  lifecycleState: 'active' | 'archived' | 'trash' | 'retained'
  role: 'view' | 'comment' | 'edit'
  sourceHash?: string
  targets?: Array<{
    id: string
    kind: string
    label: string
    parentId?: string
    locked?: boolean
    value?: string | boolean | string[] | null
    options?: string[]
    pageNumber?: number
    pageOrder?: number
    rect?: { x: number; y: number; width: number; height: number }
    rotation?: number
    resourceId?: string
  }>
  targetsTruncated?: boolean
  nextTargetOffset?: number
  job?: { id: string; status: string; stage: string; errorCode: string | null; inputQuestion?: string; canResumeTemplate?: boolean; templateChoices?: OfficeTemplateChoice[]; importDiagnostics?: Array<{ reason: string; part?: string }> }
  /** Internal-only root evidence; the tool strips it before model delivery. */
  scopeEvidence?: ScopeEvidence
}

export type OfficeToolPort = {
  resumeGeneration?(context: ToolContext, input: z.infer<typeof OfficeGenerationTemplateSelection>): Promise<{artifactId:string;jobId:string}>
  retryTemplateImport?(input: { userId: string; workspaceId: string; artifactId: string; failedJobId: string; fileId?: string; assistantId?: string; clearance?: 'public' | 'internal' | 'confidential'; compartmentGrant?: string[] | null; projectGrant?: string[] | null }): Promise<{ jobId: string } | null>
  inspectClassification?(context:ToolContext, artifactId:string): Promise<unknown>;
  restrictClassification?(context:ToolContext, input:{artifactId:string;expectedRevision:string;departmentId?:string;sensitivity:'public'|'internal'|'confidential'}): Promise<unknown>;

  create(params: { userId: string; assistantId: string; workspaceId: string; family: 'document' | 'presentation' | 'spreadsheet'; outcome: string; audience: string; additionalContext?: string; sourceHandles: string[]; templateId?: string; idempotencyKey: string; sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[]; compartmentGrant: string[] | null; projectGrant: string[] | null }): Promise<{ artifactId: string; jobId: string }>
  get(params: { userId: string; artifactId: string; targetOffset?: number; clearance?: 'public' | 'internal' | 'confidential'; compartmentGrant?: string[] | null; projectGrant?: string[] | null }): Promise<OfficeArtifactToolProjection | null>
  revise(params: { userId: string; assistantId: string; artifactId: string; instruction: string; targetIds: string[]; expectedVersion: number; idempotencyKey: string; sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[]; clearance?: 'public' | 'internal' | 'confidential'; compartmentGrant: string[] | null; projectGrant: string[] | null }): Promise<{ jobId: string; mode: 'direct' | 'proposal' } | 'version_conflict' | null>
  openPdfSession?(params: { userId: string; workspaceId: string; sessionId: string; sourceAttachmentId: string; signatureAttachmentId?: string; title: string; idempotencyKey: string; signal?: AbortSignal }): Promise<{ artifactId: string; version: number; expiresAt: string; editorUrl: string; targets: Array<{ targetId: string; pageId: string; pageNumber: number; rect: { x: number; y: number; width: number; height: number } }>; sourceHash: string; signatureResourceId?: string }>
  describePdfSignature?(params: { userId: string; artifactId: string; targetId: string; signatureResourceId: string; expectedSourceHash: string; expectedVersion: number }): Promise<{ title: string; fileName: string; pageNumber: number; rect: { x: number; y: number; width: number; height: number }; sourceHash: string; version: number; expiresAt: string } | null>
  placePdfSignature?(params: { userId: string; assistantId: string; approverUserId: string; approvalId: string; artifactId: string; targetId: string; signatureResourceId: string; expectedSourceHash: string; expectedVersion: number; idempotencyKey: string }): Promise<{ artifactId: string; version: number } | 'pdf_signature_approval_stale' | null>
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
  const signatureInput = z.object({
    artifactId: z.string().uuid(),
    targetId: z.string().uuid(),
    signatureResourceId: z.string().uuid(),
    expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedVersion: z.number().int().min(0),
    idempotencyKey: z.string().min(8).max(255),
  }).strict()
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
  const openPdfAskGate = params.resolvePolicy
    ? async (context: { userId: string; assistantId: string; currentTurnAttachmentIds?: ReadonlySet<string> }, raw: unknown) => {
        const input = raw && typeof raw === 'object' ? raw as { sourceAttachmentId?: unknown; signatureAttachmentId?: unknown } : {}
        const attached = context.currentTurnAttachmentIds
        const exactTurn = typeof input.sourceAttachmentId === 'string'
          && attached?.has(input.sourceAttachmentId) === true
          && (input.signatureAttachmentId === undefined
            || typeof input.signatureAttachmentId === 'string' && attached.has(input.signatureAttachmentId))
        // Invalid provenance reaches execute immediately and fails there. A
        // policy-driven prompt is created only after this exact turn proves
        // both opaque ids, so durable resume can treat that approval receipt
        // as the provenance checkpoint.
        return exactTurn && (await params.resolvePolicy!('openPdfEditingSession', context)) === 'ask'
      }
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
    description: 'Read the current permission-filtered metadata, collaboration role, version, lifecycle, generation state, and one bounded page of the semantic target outline for a Brian-native Office artifact. A draft paused for template selection includes job.inputQuestion and permission-filtered job.templateChoices with published version IDs. Use the returned stable target IDs with reviseOfficeArtifact. When nextTargetOffset is present, call again with that targetOffset to continue discovery. Returns no existence signal when the caller is ineligible and never returns binary resources or the complete canonical snapshot.',
    inputSchema: z.object({ artifactId: z.string().uuid(), targetOffset: z.number().int().min(0).optional() }),
    async execute(input, context) {
      const blocked = await blockGate('getOfficeArtifact', context)
      if (blocked) return blocked
      const artifact = await params.port.get({
        userId: context.userId,
        artifactId: input.artifactId,
        targetOffset: input.targetOffset,
        clearance: context.clearance,
        compartmentGrant: context.compartments ?? null,
        projectGrant: context.projectIds ?? null,
      })
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
    description: 'Start a fresh context-clean, command-native revision job against an explicit Office artifact version and stable target IDs returned by getOfficeArtifact or selected by the user in the editor. Brian may use the supported canonical Document, Presentation, Spreadsheet, or PDF command vocabulary inside those targets, except PDF signatures, which require placePdfSignature. PDF revisions require at least one explicit target and are owner-only direct edits. If a durable artifact advances before the job runs, the validated commands become a proposal instead of overwriting intervening edits. Never use this as implicit authorization to create, sign, export, share, send, publish, or overwrite intervening edits.',
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
      const result = await params.port.revise({ userId: context.userId, assistantId: context.assistantId, ...input, ...writeScope, clearance: context.clearance, compartmentGrant: context.compartments ?? null, projectGrant: context.projectIds ?? null })
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

  const openPdfEditingSession = buildTool({
    name: 'openPdfEditingSession',
    requiresCapability: 'office',
    resolveConfirmation: openPdfAskGate,
    isConcurrencySafe: false,
    isReadOnly: false,
    description: 'Open a bounded 24-hour canonical PDF editing session only after the user explicitly asks to edit, fill, or sign a PDF attached in this exact turn. The source and optional signature must be opaque IDs from current-turn <attached_file> envelopes. Intake is synchronous and makes no model call. Never accept a URL, workspace path, old attachment id, or reusable stored signature.',
    inputSchema: z.object({
      sourceAttachmentId: z.string().uuid(),
      signatureAttachmentId: z.string().uuid().optional(),
      title: z.string().min(1).max(1_000),
      idempotencyKey: z.string().min(8).max(255),
    }).strict(),
    async execute(input, context) {
      const blocked = await blockGate('openPdfEditingSession', context)
      if (blocked) return blocked
      if (!context.workspaceId || !params.port.openPdfSession) {
        return { data: 'openPdfEditingSession is unavailable in this workspace. Nothing was created.', isError: true }
      }
      const approvedProvenance = context.approvedToolInvocation?.toolName === 'openPdfEditingSession'
        && context.approvedToolInvocation.approverUserId === context.userId
      const request = context.userMessageText?.toLocaleLowerCase() ?? ''
      if (!/(?:edit|fill|complete|sign|annotate|modify|rotate|reorder|delete)\b/.test(request) && !approvedProvenance) {
        return { data: 'openPdfEditingSession did not run because this turn does not contain an explicit request to edit, fill, or sign the PDF. Nothing was created.', isError: true }
      }
      const attached = context.currentTurnAttachmentIds
      if ((!attached?.has(input.sourceAttachmentId) || input.signatureAttachmentId && !attached.has(input.signatureAttachmentId)) && !approvedProvenance) {
        return { data: 'openPdfEditingSession did not run because every attachment id must come from this exact turn. Ask the user to attach the PDF and optional signature image again.', isError: true }
      }
      const ready = await params.port.openPdfSession({
        userId: context.userId,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        ...input,
        signal: context.abortSignal,
      })
      return {
        data: {
          ...ready,
          editorUrl: link(params.appOrigin, context.workspaceId, ready.artifactId) ?? ready.editorUrl,
        },
      }
    },
  })

  const placePdfSignature = buildTool({
    name: 'placePdfSignature',
    requiresCapability: 'office',
    requiresConfirmation: true,
    confirmationMode: 'durable_attended',
    allowPersistentApproval: false,
    isConcurrencySafe: false,
    isReadOnly: false,
    description: 'Place one already-admitted image signature into an imported signature widget or a rectangle the owner created in the PDF editor. This always requires one attended, non-persistent approval for the exact source hash, version, target, and resource. It never creates coordinates and never claims certificate-based signing.',
    inputSchema: signatureInput,
    async describeConfirmation(raw, context) {
      if (!params.port.describePdfSignature) return null
      const input = signatureInput.parse(raw)
      const projection = await params.port.describePdfSignature({ userId: context.userId, ...input })
      if (!projection) return ['The PDF signature target is stale or unavailable. Do not approve this request.']
      const { rect } = projection
      return [
        `PDF: ${projection.title} (${projection.fileName})`,
        `Page ${projection.pageNumber}; rectangle x=${rect.x}, y=${rect.y}, width=${rect.width}, height=${rect.height}`,
        `Source ${projection.sourceHash.slice(0, 12)}; version ${projection.version}; expires ${projection.expiresAt}`,
        'This places an image-based signature. It is not a certificate-based digital signature.',
      ]
    },
    async execute(input, context) {
      const blocked = await blockGate('placePdfSignature', context)
      if (blocked) return blocked
      const approval = context.approvedToolInvocation
      if (!params.port.placePdfSignature || !approval || approval.toolName !== 'placePdfSignature' || approval.approverUserId !== context.userId) {
        return { data: 'placePdfSignature requires a fresh attended one-time approval. The signature was not placed.', isError: true }
      }
      const result = await params.port.placePdfSignature({
        userId: context.userId,
        assistantId: context.assistantId,
        approverUserId: approval.approverUserId,
        approvalId: approval.approvalId,
        ...input,
      })
      if (result === 'pdf_signature_approval_stale') {
        return { data: 'pdf_signature_approval_stale: the PDF source, version, target, resource, owner, or expiry changed after review. Nothing was changed. Read the current PDF session before asking again.', isError: true }
      }
      if (!result) return { data: artifactUnreachable('placePdfSignature', 'revise', input.artifactId), isError: true }
      return { data: result }
    },
  })

  const recoveryTools: Tool[] = params.port.retryTemplateImport ? [buildTool({
    name: 'retryOfficeTemplateImport',
    requiresCapability: 'office',
    isReadOnly: false, isConcurrencySafe: false,
    resolveConfirmation: askGate('retryOfficeTemplateImport'),
    description: 'Retry one explicitly selected failed template upload using its existing draft and stored source, optionally replacing the source with an accessible workspace file. Inspect getOfficeArtifact first for the failed job. Use only after the user requests recovery and the reported unsupported feature has been corrected or support has changed. Does not publish a template or overwrite an edited draft.',
    inputSchema: z.object({ artifactId: z.string().uuid(), failedJobId: z.string().uuid(), fileId: z.string().uuid().optional() }).strict(),
    async execute(input, context) {
      const blocked = await blockGate('retryOfficeTemplateImport', context)
      if (blocked) return blocked
      if (!context.workspaceId) return { data: 'Open a workspace chat before retrying a template import.', isError: true }
      const result = await params.port.retryTemplateImport!({ ...input, userId: context.userId, workspaceId: context.workspaceId, assistantId: context.assistantId, clearance: context.clearance, compartmentGrant: context.compartments ?? null, projectGrant: context.projectIds ?? null })
      return result ? { data: result } : { data: 'Import recovery was blocked: the failed draft or source is unavailable, already edited, or superseded. Inspect the current draft before taking another action. Do not repeat this request.', isError: true }
    },
  })] : []

  const classificationTools:Tool[] = []
  if (params.port.inspectClassification && params.port.restrictClassification) {
    classificationTools.push(buildTool({
      name: 'getOfficeClassification',
      requiresCapability: 'office',
      resolveConfirmation: askGate('getOfficeClassification'),
      isReadOnly: true,
      isConcurrencySafe: true,
      description:'Inspect department and sensitivity protections and recent classification history of one accessible Office artifact. Read before restrictOfficeClassification to obtain the current revision. Sharing does not override these protections.',
      inputSchema:z.object({artifactId:z.string().uuid()}).strict(),
      async execute(input,context) {
        const blocked=await blockGate('getOfficeClassification',context);if(blocked)return blocked
        const data=await params.port.inspectClassification!(context,input.artifactId)
        return data ? {data,scopeEvidence:scopeEvidenceFromRows([data])} : {data:artifactUnreachable('getOfficeClassification','read',input.artifactId),isError:true}
      },
    }),buildTool({
      name: 'restrictOfficeClassification',
      requiresCapability: 'office',
      isReadOnly: false,
      isConcurrencySafe: false,
      requiresConfirmation: true,
      description:'Add a department restriction or raise sensitivity on one Office artifact after explicit user approval. Supply the revision from getOfficeClassification. Preserves all existing source and department floors. This protection cannot be removed by Undo; broader sharing requires a reviewed derivative. Requires sharing-management and edit authority and current destination clearance.',
      inputSchema:z.object({artifactId:z.string().uuid(),expectedRevision:z.string().regex(/^[a-f0-9]{64}$/),departmentId:z.string().uuid().optional(),sensitivity:z.enum(['public','internal','confidential'])}).strict(),
      async execute(input,context) {
        const blocked=await blockGate('restrictOfficeClassification',context);if(blocked)return blocked
        const data=await params.port.restrictClassification!(context,input)
        return {data,scopeEvidence:scopeEvidenceFromRows([data])}
      },
    }))
  }
  const generationRecoveryTools = params.port.resumeGeneration ? [buildTool({
    name:'resumeOfficeGeneration', requiresCapability:'office', isReadOnly:false, isConcurrencySafe:false,
    resolveConfirmation:askGate('resumeOfficeGeneration'),
    description:'Resume one uninitialized Office draft paused for template selection. Read getOfficeArtifact first and select a published matching templateVersionId from job.templateChoices, or an exact version selected by the user. Requires the initiating user and current Edit authority. Preserves the draft, brief and execution protections. Never selects an unpublished template or resets an edited or completed draft. If no choices are available, ask the user to upload, review and publish a template in Office > Templates first.',
    inputSchema:OfficeGenerationTemplateSelection,
    async execute(input,context) {
      const blocked=await blockGate('resumeOfficeGeneration',context);if(blocked)return blocked
      const data=await params.port.resumeGeneration!(context,input)
      return {data:{...data,editorUrl:context.workspaceId ? link(params.appOrigin,context.workspaceId,data.artifactId) : undefined}}
    },
  })] : []
  return [createOfficeArtifact, getOfficeArtifact, reviseOfficeArtifact, openPdfEditingSession, placePdfSignature,...classificationTools, ...recoveryTools,...generationRecoveryTools]
}
