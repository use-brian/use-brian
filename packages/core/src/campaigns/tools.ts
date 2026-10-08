/** Brian/Brain-MCP adapters over the canonical campaign ports. [COMP:campaigns/contracts] */
import { z } from 'zod'
import {
  campaignAttachContentSchema,
  campaignCreateLinkSchema,
  campaignEmailMetadataSchema,
  campaignSaveObjectSchema,
  campaignSaveSchema,
  campaignUuidSchema,
} from '@use-brian/shared/campaigns'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import { missingToolCapability } from '../tools/capability-gate.js'
import {
  CampaignError,
  type CampaignContext,
  type CampaignReadPort,
  type CampaignServicePort,
} from './types.js'

export type CampaignTools = {
  listCampaigns: Tool
  getCampaign: Tool
  saveCampaign: Tool
  archiveCampaign: Tool
  attachCampaignContent: Tool
  createCampaignLink: Tool
  listCampaignLinks: Tool
  getCampaignTrackingSetup: Tool
  verifyCampaignTracking: Tool
  getCampaignResults: Tool
  getCampaignAttribution: Tool
  previewCampaignAudience: Tool
  previewCampaignEmail: Tool
  sendCampaignTest: Tool
  prepareCampaignDispatch: Tool
  scheduleCampaignDispatch: Tool
  pauseCampaignDispatch: Tool
  cancelCampaignDispatch: Tool
}

function defaultContext(context: ToolContext): CampaignContext | null {
  if (!context.workspaceId) return null
  return {
    workspaceId: context.workspaceId,
    actor: { kind: 'assistant', assistantId: context.assistantId, userId: context.userId, sessionId: context.sessionId },
    authority: { role: 'member', canRead: true, canWrite: true, canConfigure: false, canSend: false },
  }
}

function failure(error: unknown) {
  if (error instanceof CampaignError) return { isError: true as const, data: { error: error.code, message: error.message, ...error.details } }
  if (error instanceof z.ZodError) return { isError: true as const, data: { error: 'invalid_input', message: error.issues.map(issue => issue.message).join('; ') } }
  return { isError: true as const, data: { error: 'internal', message: 'The campaign operation could not complete.' } }
}

export function createCampaignTools(options: {
  reads: CampaignReadPort
  service: CampaignServicePort
  resolveContext?: (context: ToolContext) => CampaignContext | null | Promise<CampaignContext | null>
}): CampaignTools {
  const resolveContext = options.resolveContext ?? defaultContext

  function read<Input extends z.ZodType>(name: string, description: string, inputSchema: Input,
    run: (workspaceId: string, input: z.infer<Input>, context: CampaignContext) => Promise<unknown>): Tool<Input> {
    const tool: Tool<Input> = buildTool({
      name, description, inputSchema, isReadOnly: true, requiresCapability: 'feed', homeAppToolSet: { app: 'feed', set: 'read' },
      async execute(input, toolContext) {
        const missing = missingToolCapability(tool, toolContext.activeCapabilities)
        if (missing) return { isError: true, data: { error: 'not_authorized', requiredCapability: missing } }
        const context = await resolveContext(toolContext)
        if (!context?.authority.canRead) return { isError: true, data: { error: 'not_authorized', message: 'Campaign read authority is required.' } }
        try { return { data: await run(context.workspaceId, inputSchema.parse(input), context) } } catch (error) { return failure(error) }
      },
    })
    return tool
  }

  function mutate<Input extends z.ZodType>(name: string, description: string, inputSchema: Input,
    command: (input: z.infer<Input>) => Record<string, unknown>, confirmation = false): Tool<Input> {
    const tool: Tool<Input> = buildTool({
      name, description, inputSchema, requiresCapability: 'feed', homeAppToolSet: { app: 'feed', set: 'write' }, requiresConfirmation: confirmation,
      async execute(input, toolContext) {
        const missing = missingToolCapability(tool, toolContext.activeCapabilities)
        if (missing) return { isError: true, data: { error: 'not_authorized', requiredCapability: missing } }
        const context = await resolveContext(toolContext)
        if (!context) return { isError: true, data: { error: 'not_authorized', message: 'A workspace-scoped campaign context is required.' } }
        try {
          const parsed = inputSchema.parse(input)
          const { idempotency_key, ...fields } = parsed as { idempotency_key: string } & Record<string, unknown>
          const receipt = await options.service.execute(context, { idempotencyKey: idempotency_key, command: command(fields) as never })
          return { data: receipt.result }
        } catch (error) { return failure(error) }
      },
    })
    return tool
  }

  const Idempotency = { idempotency_key: z.string().trim().min(8).max(200) }
  const listCampaigns = read('listCampaigns', 'List native Feed campaigns in this workspace, including archived campaigns when requested.',
    z.object({ state: z.enum(['draft', 'active', 'completed', 'archived']).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    (workspaceId, input) => options.reads.listCampaigns(workspaceId, input))
  const getCampaign = read('getCampaign', 'Get one campaign with its channel placements and stable tracked links.',
    z.object({ campaign_id: campaignUuidSchema }).strict(),
    (workspaceId, input) => options.reads.getCampaign(workspaceId, input.campaign_id))
  const saveCampaign = mutate('saveCampaign', 'Create or revise a workspace campaign. This does not publish content or authorize Email sending.',
    campaignSaveObjectSchema.extend(Idempotency).superRefine((value, ctx) => {
      const { idempotency_key: _idempotencyKey, ...campaign } = value
      const result = campaignSaveSchema.safeParse(campaign)
      if (!result.success) {
        for (const issue of result.error.issues) ctx.addIssue(issue)
      }
    }),
    input => ({ kind: 'save_campaign', ...input }))
  const archiveCampaign = mutate('archiveCampaign', 'Archive a campaign while preserving distributed links and historical attribution. This does not disable links.',
    z.object({ ...Idempotency, campaign_id: campaignUuidSchema }).strict(),
    input => ({ kind: 'archive_campaign', campaignId: input.campaign_id }), true)
  const attachCampaignContent = mutate('attachCampaignContent', 'Attach an existing Feed draft session as an explicit campaign/channel placement without copying its editable body.',
    z.object({ ...Idempotency, ...campaignAttachContentSchema.shape }).strict(),
    input => ({ kind: 'attach_content', ...input }))
  const createCampaignLink = mutate('createCampaignLink', 'Create a stable tracked destination for one campaign placement. Existing attribution parameters require an explicit replace or retain choice.',
    z.object({ ...Idempotency, ...campaignCreateLinkSchema.shape }).strict(),
    input => ({ kind: 'create_link', ...input }))
  const listCampaignLinks = read('listCampaignLinks', 'List a campaign\'s stable tracked links and enablement state.',
    z.object({ campaign_id: campaignUuidSchema }).strict(),
    (workspaceId, input) => options.reads.listLinks(workspaceId, input.campaign_id))
  const getCampaignTrackingSetup = read('getCampaignTrackingSetup', 'Get first-party tracker installation state, configured origins, storage mode, and supported conversion definitions.',
    z.object({ site_id: campaignUuidSchema.optional() }).strict(),
    (workspaceId, input) => options.reads.getTrackingSetup(workspaceId, input.site_id))
  const verifyCampaignTracking = read('verifyCampaignTracking', 'Verify tracker/site configuration without inventing traffic or conversion success.',
    z.object({ site_id: campaignUuidSchema }).strict(),
    (workspaceId, input) => options.reads.getTrackingSetup(workspaceId, input.site_id))
  const getCampaignResults = read('getCampaignResults', 'Read bounded native campaign results with explicit metric evidence and unavailable-state reasons.',
    z.object({ campaign_id: campaignUuidSchema, from: z.string().date().optional(), to: z.string().date().optional(), model: z.enum(['first_touch', 'last_touch']).default('last_touch'), include_test: z.boolean().default(false) }).strict(),
    (workspaceId, input) => options.reads.getResults(workspaceId, input.campaign_id, input))
  const getCampaignAttribution = read('getCampaignAttribution', 'Read bounded attributed conversions with first/last touch, numerator, evidence, date window, and limitations.',
    z.object({ campaign_id: campaignUuidSchema, from: z.string().date().optional(), to: z.string().date().optional(), model: z.enum(['first_touch', 'last_touch']).default('last_touch'), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    (workspaceId, input) => options.reads.getAttribution(workspaceId, input.campaign_id, input))
  const previewCampaignAudience = read('previewCampaignAudience', 'Preview the saved authorized CRM audience for campaign Email and explain eligible, excluded, unresolved, and duplicate counts.',
    z.object({ campaign_id: campaignUuidSchema, placement_id: campaignUuidSchema }).strict(),
    (workspaceId, input, context) => options.reads.previewAudience(workspaceId, input, context.actor))
  const previewCampaignEmail = read('previewCampaignEmail', 'Render HTML and plain-text Email previews for one Feed revision and explicitly selected sample contacts.',
    z.object({ campaign_id: campaignUuidSchema, placement_id: campaignUuidSchema, revision: z.number().int().nonnegative(), values: z.record(z.string(), z.string().max(2_000)).default({}) }).strict(),
    (workspaceId, input) => options.reads.previewEmail(workspaceId, input))
  const sendCampaignTest = mutate('sendCampaignTest', 'Send the reviewed Email revision only to explicitly selected test addresses. This never authorizes a live audience dispatch.',
    z.object({ ...Idempotency, campaign_id: campaignUuidSchema, placement_id: campaignUuidSchema, approved_revision: z.number().int().nonnegative(), contact_id: campaignUuidSchema, delivery_id: campaignUuidSchema }).strict(),
    input => ({ kind: 'send_test', campaignId: input.campaign_id, placementId: input.placement_id, approvedRevision: input.approved_revision, contactId: input.contact_id, deliveryId: input.delivery_id }), true)
  const prepareCampaignDispatch = mutate('prepareCampaignDispatch', 'Freeze the exact reviewed revision, sender, purpose, CRM audience, personalization, tracking, authority, and recipient snapshot for approval. This does not hand mail to SMTP.',
    z.object({ ...Idempotency, campaign_id: campaignUuidSchema, placement_id: campaignUuidSchema, approved_revision: z.number().int().nonnegative(), metadata: campaignEmailMetadataSchema, scheduled_at: z.string().datetime({ offset: true }).nullable().optional(), recipients: z.array(z.object({ contactId: campaignUuidSchema, address: z.string().email().max(320), personalization: z.record(z.string(), z.string()), eligibility: z.record(z.string(), z.unknown()) }).strict()).min(1).max(500) }).strict(),
    input => ({ kind: 'prepare_dispatch', campaignId: input.campaign_id, placementId: input.placement_id, approvedRevision: input.approved_revision, metadata: input.metadata, scheduledAt: input.scheduled_at, recipients: input.recipients }), true)
  const scheduleCampaignDispatch = mutate('scheduleCampaignDispatch', 'Schedule one already approved immutable campaign dispatch. Current sender authority and recipient eligibility are rechecked before every SMTP handoff.',
    z.object({ ...Idempotency, dispatch_id: campaignUuidSchema, scheduled_at: z.string().datetime({ offset: true }) }).strict(),
    input => ({ kind: 'schedule_dispatch', dispatchId: input.dispatch_id, scheduledAt: input.scheduled_at }), true)
  const pauseCampaignDispatch = mutate('pauseCampaignDispatch', 'Pause future recipient admissions for a campaign dispatch. SMTP-accepted messages cannot be recalled.',
    z.object({ ...Idempotency, dispatch_id: campaignUuidSchema }).strict(),
    input => ({ kind: 'pause_dispatch', dispatchId: input.dispatch_id }), true)
  const cancelCampaignDispatch = mutate('cancelCampaignDispatch', 'Cancel future recipient admissions for a campaign dispatch. SMTP-accepted messages cannot be recalled.',
    z.object({ ...Idempotency, dispatch_id: campaignUuidSchema }).strict(),
    input => ({ kind: 'cancel_dispatch', dispatchId: input.dispatch_id }), true)

  return { listCampaigns, getCampaign, saveCampaign, archiveCampaign, attachCampaignContent, createCampaignLink, listCampaignLinks, getCampaignTrackingSetup, verifyCampaignTracking, getCampaignResults, getCampaignAttribution, previewCampaignAudience, previewCampaignEmail, sendCampaignTest, prepareCampaignDispatch, scheduleCampaignDispatch, pauseCampaignDispatch, cancelCampaignDispatch }
}
