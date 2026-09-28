import { MembershipDraftSaveSchema, MembershipPublishSchema } from './membership-catalogue.js'
import { ProgrammeDraftSaveSchema, ProgrammePublishSchema } from './programme-catalogue.js'
import { SiteContentCollectionSchema, SiteContentDraftSaveSchema, SiteContentPublishSchema, type SiteContentCollection } from './site-content.js'
import { EventPageEditSchema, SiteContentOperationsSchema, eventPageOperations, siteContentChanges, siteContentOutline, siteContentValueAt } from './site-content-edit.js'
import { preserveCompatText, restoreCompatText } from './compat-text.js'
/** Native adapters to the canonical commerce service. [COMP:crm/association-tools] */
import { z } from 'zod'
import { WorkspaceModuleError } from '@use-brian/shared'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import { missingToolCapability } from '../tools/capability-gate.js'
import { crmOperationsToolContext } from '../crm/operations-tools.js'
import { CrmOperationsError } from '../crm/operations-types.js'
import {
  AssociationError, AssociationListPageSchema, AssociationOrderCreateSchema,
  AssociationOrderStatusSchema, AssociationRegistrationStatusSchema,
  AssociationRegistrationUpdateSchema, AssociationTicketInputSchema,
} from './domain.js'
import { AssociationWaitlistOfferInputSchema } from './waitlist.js'
import { ProviderReceiptStateSchema } from './provider-inbox.js'
import { AssociationCommandSchema, type AssociationCommand, type AssociationCommandResult, type AssociationServicePort } from './operations.js'

const Id = z.string().uuid()
const OrderId = z.object({ orderId: Id }).strict()
const followPages = ' Follow nextCursor with identical filters until null.'

export function createAssociationTools(service: AssociationServicePort) {
  function command<Input extends z.ZodType>(
    name: string, description: string, inputSchema: Input,
    isReadOnly: boolean, contacts: boolean,
    toCommand: (input: z.infer<Input>) => unknown,
    requiresConfirmation = false,
  ): Tool<Input> {
    const tool: Tool<Input> = buildTool({
      name, description, inputSchema, isReadOnly, isConcurrencySafe: isReadOnly,
      requiresConfirmation,
      requiresCapability: contacts ? 'crm' : 'association',
      homeAppToolSet: { app: 'association', set: isReadOnly ? 'read' : 'write' },
      async execute(rawInput, context) {
        // Gate direct MCP/gateway calls as well as executor-mediated calls.
        const missing = missingToolCapability(tool, context.activeCapabilities)
        if (missing) return { isError: true, data: { error: 'not_authorized', requiredCapability: missing } }
        const crm = crmOperationsToolContext(context)
        if (!crm) return { isError: true, data: { error: 'not_authorized', message: 'Association requires a workspace-scoped assistant or credential.' } }
        try {
          const operation: AssociationCommand = AssociationCommandSchema.parse(toCommand(inputSchema.parse(rawInput)))
          return { data: await service.execute({ ...crm, authority: {
            ...crm.authority, canRead: isReadOnly, canWrite: !isReadOnly,
            canConfigure: false, canReconcileProvider: false,
          } }, operation) }
        } catch (error) {
          if (error instanceof AssociationError || error instanceof CrmOperationsError || error instanceof WorkspaceModuleError) {
            return { isError: true, data: { error: error.code, message: error.message, details: error.details } }
          }
          if (error instanceof z.ZodError) return { isError: true, data: { error: 'invalid_input', message: 'Use the declared fields, returned resource ids and valid quantities.' } }
          return { isError: true, data: { error: 'internal', message: 'Association could not complete this operation.' } }
        }
      },
    })
    return tool
  }
  type ContentCommand = Exclude<AssociationCommand, { kind: 'module_action' }>
  /**
   * Catalogue, website content and media tools: owner/admin configuration work. The configure grant lets the
   * assistant reach them; the service also requires the person it acts for to be an owner or admin.
   */
  function contentTool<Input extends z.ZodType>(name: string, description: string, schema: Input, readOnly: boolean,
    run: (input: z.infer<Input>, exec: (command: ContentCommand) => Promise<AssociationCommandResult>, context: ToolContext) => Promise<unknown>,
    confirmation?: { describe?: (input: z.infer<Input>, exec: (command: ContentCommand) => Promise<AssociationCommandResult>) => Promise<string[] | null> }) {
    const execFor = (context: ToolContext) => {
      const crm = crmOperationsToolContext(context)
      if (!crm) throw new CrmOperationsError('not_authorized', 'Association requires a workspace-scoped assistant or credential.')
      return (command: ContentCommand) => service.execute({ ...crm, authority: { ...crm.authority, canRead: true, canWrite: true, canConfigure: true, canReconcileProvider: false } },
        AssociationCommandSchema.parse(command))
    }
    const tool = buildTool({ name, description, inputSchema: schema, requiresCapability: 'configure',
      homeAppToolSet: { app: 'association' as const, set: readOnly ? 'read' as const : 'write' as const },
      isReadOnly: readOnly, isConcurrencySafe: readOnly, requiresConfirmation: !!confirmation,
      ...(confirmation?.describe ? { describeConfirmation: async (input: unknown, context: ToolContext) => {
        try { return await confirmation.describe!(schema.parse(input), execFor(context)) } catch { return null }
      } } : {}),
      async execute(input, context) {
        const missing = missingToolCapability(tool, context.activeCapabilities)
        if (missing) return { isError: true, data: { error: 'not_authorized', requiredCapability: missing } }
        if (!crmOperationsToolContext(context)) return { isError: true, data: { error: 'not_authorized' } }
        try {
          return { data: await run(schema.parse(input), execFor(context), context) }
        } catch (error) {
          if (error instanceof z.ZodError) return { isError: true, data: { error: 'invalid_input', message: error.issues.slice(0, 5).map(issue => `${issue.path.join('/') || 'input'}: ${issue.message}`).join('; ') } }
          return { isError: true, data: { error: error instanceof AssociationError || error instanceof CrmOperationsError ? error.code : 'invalid_input',
            message: error instanceof Error ? error.message : 'Catalogue operation failed.' } }
        }
      },
    })
    return tool
  }
  const direct = <K extends ContentCommand['kind']>(kind: K) => async (input: object, exec: (command: ContentCommand) => Promise<AssociationCommandResult>) =>
    exec({ ...input, kind } as ContentCommand)
  /** A whole document some providers' tool schemas show to the model as text. */
  const jsonText = (value: unknown) => { if (typeof value !== 'string') return value; try { return JSON.parse(value) as unknown } catch { return value } }
  const record = (result: AssociationCommandResult) => (result.record ?? {}) as Record<string, unknown>
  /** Draft/published text is stored with compatibility escapes; the model reads and writes the real characters. */
  const readable = (result: AssociationCommandResult) => ({ ...result, record: restoreCompatText(result.record) })
  const Collection = SiteContentCollectionSchema.describe('Which website content: people, partners, settings, news, event-pages, or a site home page collection (home-*).')
  const publishSummary = (kind: 'site_content_draft', collectionOf: (input: { collection: SiteContentCollection }) => SiteContentCollection) =>
    async (input: { collection: SiteContentCollection; expectedVersion: number }, exec: (command: ContentCommand) => Promise<AssociationCommandResult>) => {
      const draft = record(restoreCompatText(await exec({ kind, collection: collectionOf(input) })))
      const changes = siteContentChanges(draft.published, draft.document)
      const sites = ((draft.readers as string[] | undefined) ?? []).map(site => site.toUpperCase()).join(', ')
      return [`Publish ${input.collection} (draft version ${input.expectedVersion}) to ${sites || 'the websites'}:`, ...(changes.length ? changes : ['no content changes'])]
    }
  return {
    previewMembershipCatalogue: contentTool('previewMembershipCatalogue', 'Read the current membership draft, published version, validation issues and website synchronization status. Show the admin the exact before/after changes for both sites and all affected languages before requesting publication.', z.object({}).strict(), true, direct('membership_catalogue_draft')),
    saveMembershipCatalogueDraft: contentTool('saveMembershipCatalogueDraft', 'Save a complete membership catalogue draft using the expected version from previewMembershipCatalogue. Preserve unrelated plans, locales and page sections. This does not publish or change live prices. Read and preview again after saving.', MembershipDraftSaveSchema, false, direct('save_membership_catalogue')),
    publishMembershipCatalogue: contentTool('publishMembershipCatalogue', 'Publish the exact draft version the admin has reviewed and confirmed. Updates website content and new-purchase prices, never existing subscriptions. Report pending website synchronization until both website readers acknowledge this revision.', MembershipPublishSchema, false, direct('publish_membership_catalogue'), {}),
    previewProgrammeCatalogue: contentTool('previewProgrammeCatalogue', 'Read the current website programme draft, published version, validation issues and website synchronization status. Show the admin the exact before/after changes for every affected programme and language before requesting publication.', z.object({}).strict(), true, direct('programme_catalogue_draft')),
    saveProgrammeCatalogueDraft: contentTool('saveProgrammeCatalogueDraft', 'Save a complete website programme catalogue draft using the expected version from previewProgrammeCatalogue. Preserve unrelated programmes, locales and sections; never invent translations. This does not publish and changes no membership or ticket prices. Read and preview again after saving.', ProgrammeDraftSaveSchema, false, direct('save_programme_catalogue')),
    publishProgrammeCatalogue: contentTool('publishProgrammeCatalogue', 'Publish the exact programme draft version the admin has reviewed and confirmed. Updates website programme pages only; no fee, order or subscription record changes. Report pending website synchronization until the website reader acknowledges this revision.', ProgrammePublishSchema, false, direct('publish_programme_catalogue'), {}),
    getWebsiteStatus: contentTool('getWebsiteStatus',
      'Summarise every website page and catalogue: draft version, last published revision and time, which websites have picked up the latest publication, and how many issues block publishing. Use it to answer "what is unpublished or out of date" before opening a page.',
      z.object({}).strict(), true, direct('website_status')),
    previewWebsiteContent: contentTool('previewWebsiteContent',
      'Read one website content collection: the current draft, published version, validation issues and which websites read it. Large collections come back as an outline of entry references; pass `path` (e.g. "pages/<event-slug>", "partners/<id>", "sites/<site>") to read one entry in full. Show the person the before/after for every affected site and language before asking to publish.',
      z.object({ collection: Collection, path: z.string().trim().min(1).max(400).optional().describe('One entry, addressed by list references or positions separated by "/".') }).strict(), true,
      async (input, exec) => {
        const result = readable(await exec({ kind: 'site_content_draft', collection: input.collection }))
        const { document, published, ...meta } = record(result)
        if (input.path) return { ...meta, path: input.path, value: siteContentValueAt(document, input.path) ?? null, publishedValue: siteContentValueAt(published, input.path) ?? null }
        const large = JSON.stringify(document ?? null).length > 20_000
        return large ? { ...meta, outline: siteContentOutline(document), note: 'Large collection: read one entry with path.' } : { ...meta, document, published }
      }),
    updateWebsiteContent: contentTool('updateWebsiteContent',
      'Change entries in one website content draft without resending the whole collection. Pass the draft `expectedVersion` from previewWebsiteContent and up to 50 operations: set (replace or create the value at path), insert (add an entry to the list at path), remove, move (to index). Paths start at the collection root and address list entries by their reference (id, key, event slug) or position: event-pages "pages/<slug>/summary", partners "partners/<id>/href", news "items" (insert) or "items/<id>/title", people "groups/<key>/members/<id>/role", settings "sites/<site>/responseDays", home pages "hero/title". Read the entry with previewWebsiteContent path first. Objects and lists may be sent as JSON text. Text fields are language maps {en, zh-Hant, zh-Hans}; English is required and translations must never be invented. Images are {mediaId, alt} from listWebsiteMedia or addWebsiteMediaFromAttachment. The result must still satisfy the page; nothing is published. Report the returned changes and issues.',
      z.object({ collection: Collection, expectedVersion: z.number().int().nonnegative(), operations: SiteContentOperationsSchema }).strict(), false,
      async (input, exec) => readable(await exec({ kind: 'update_site_content', collection: input.collection, expectedVersion: input.expectedVersion, operations: preserveCompatText(input.operations) }))),
    updateEventPage: contentTool('updateEventPage',
      'Edit one event\'s public page (the event-pages collection) by event slug: set or clear the cover image and summary, and add, replace, remove, move or hide sections (text, image, gallery, speakers, partners, agenda, faq). Creates the page if the event has none. Section shapes (text values are {en, zh-Hant?, zh-Hans?}; images {mediaId, alt}; ids are lowercase-hyphen and unique on the page): text {id, kind:"text", heading?:{en}, body:{en}}; image {id, kind:"image", image, caption?}; gallery {id, kind:"gallery", heading?, images:[image]}; speakers {id, kind:"speakers", heading?, people:[{name (plain text), title?:{en}, bio?:{en}, photo?}]}; partners {id, kind:"partners", heading?, partners:[{name, logo?, href?}]}; agenda {id, kind:"agenda", heading?, items:[{time, title:{en}, detail?:{en}}]}; faq {id, kind:"faq", heading?, items:[{question:{en}, answer:{en}}]}. Use expectedVersion from previewWebsiteContent with collection "event-pages". Event dates, venue, tickets and status belong to the event record, not this page. Nothing is published.',
      EventPageEditSchema, false,
      async (input, exec) => {
        const draft = record(restoreCompatText(await exec({ kind: 'site_content_draft', collection: 'event-pages' })))
        if (draft.version !== input.expectedVersion) throw new AssociationError('conflict', 'The event pages changed. Read them again before editing.')
        const operations = eventPageOperations(draft.document, input)
        return readable(await exec({ kind: 'update_site_content', collection: 'event-pages', expectedVersion: input.expectedVersion, operations: preserveCompatText(operations) }))
      }),
    saveWebsiteContentDraft: contentTool('saveWebsiteContentDraft', 'Replace a whole website content draft using the expected version from previewWebsiteContent. Prefer updateWebsiteContent or updateEventPage for changes to some entries. Preserve unrelated entries and languages; English is required, never invent translations. Images refer to website media library ids. This does not publish. Read and preview again after saving.',
      SiteContentDraftSaveSchema.extend({ collection: Collection }), false,
      async (input, exec) => readable(await exec({ kind: 'save_site_content', collection: input.collection, expectedVersion: input.expectedVersion, document: preserveCompatText(jsonText(input.document)) }))),
    publishWebsiteContent: contentTool('publishWebsiteContent', 'Publish the exact website content draft version the person has reviewed and confirmed for one collection. Updates website pages only; they pick it up within about a minute. Report pending website synchronization until each website reader acknowledges this revision (getWebsiteStatus).',
      SiteContentPublishSchema.extend({ collection: Collection }), false, direct('publish_site_content'),
      { describe: publishSummary('site_content_draft', input => input.collection) }),
    listWebsiteMedia: contentTool('listWebsiteMedia',
      'List images and PDFs in the website media library (newest first, up to 100), optionally filtered by name. Use a returned mediaId in an image {mediaId, alt} or a news fileId.',
      z.object({ query: z.string().trim().max(120).optional() }).strict(), true, direct('list_website_media')),
    addWebsiteMediaFromAttachment: contentTool('addWebsiteMediaFromAttachment',
      'Add a file the person attached in chat to the website media library so a page can show it. Pass the fileId from the attachment\'s <attached_file id="…"> tag. JPEG, PNG, WebP, GIF, AVIF or PDF only. Returns the mediaId; then write alt text in each language the page uses. Adding a file publishes nothing.',
      z.object({ fileId: z.string().uuid(), name: z.string().trim().min(1).max(180).optional().describe('Library name; defaults to the uploaded file name.') }).strict(), false,
      direct('add_website_media')),
    getWebsitePreviewLink: contentTool('getWebsitePreviewLink',
      'Get the Brian console link where the person sees a website content draft rendered before publishing. For an event page pass its eventSlug; it opens with the live site preview.',
      z.object({ collection: Collection, eventSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/).optional() }).strict(), true,
      async (input, _exec, context) => {
        const base = `/w/${context.workspaceId}/association`
        return { consolePath: input.collection === 'event-pages'
          ? `${base}?section=events${input.eventSlug ? `&eventSlug=${input.eventSlug}` : ''}`
          : `${base}?section=website&collection=${input.collection}` }
      }),
    getAssociationModuleStatus: command('getAssociationModuleStatus',
      'Read workspace Association module state and version. Module enablement is a human owner/admin action.',
      z.object({}).strict(), true, false, () => ({ kind: 'module_status' })),
    listAssociationTickets: command('listAssociationTickets',
      'List tickets, prices, sale windows and inventory configuration for a returned CRM event id.',
      z.object({ eventId: Id }).strict(), true, false, input => ({ kind: 'list_tickets', ...input })),
    saveAssociationTicket: command('saveAssociationTicket',
      'Create or update an event ticket by its stable key using canonical inventory validation. Enumerate CRM event ids and plan keys first.',
      z.object({ eventId: Id, ticket: AssociationTicketInputSchema }).strict(), false, false, input => ({ kind: 'save_ticket', ...input })),
    listAssociationOrders: command('listAssociationOrders',
      'Read order history and currency-grouped settled/refund/pending totals, including while the module is disabled. Filters use returned event/contact ids.' + followPages,
      AssociationListPageSchema.extend({ eventId: Id.optional(), contactId: Id.optional(), status: AssociationOrderStatusSchema.optional() }).strict(),
      true, true, input => ({ kind: 'list_orders', ...input })),
    getAssociationOrder: command('getAssociationOrder',
      'Read one order with its lines and current state using a returned order id. A pending order is not proof of payment.',
      OrderId, true, true, input => ({ kind: 'get_order', ...input })),
    createAssociationOrder: command('createAssociationOrder',
      'Reserve ticket inventory for existing CRM contacts. Enumerate tickets first. Reuse the same idempotencyKey and identical envelope after an uncertain response. Member pricing is checked at reservation time. This never asserts payment.',
      z.object({ order: AssociationOrderCreateSchema }).strict(), false, true, input => ({ kind: 'create_order', ...input })),
    confirmFreeAssociationOrder: command('confirmFreeAssociationOrder',
      'Confirm an existing zero-total pending order after approval. The service refuses paid-price orders and expired reservations; provider evidence is required for payments.',
      OrderId, false, true, input => ({ kind: 'confirm_free_order', ...input }), true),
    cancelAssociationOrder: command('cancelAssociationOrder',
      'Cancel an unpaid pending order and release its reservation. Exact replay is safe. Paid orders need provider reconciliation.',
      OrderId, false, true, input => ({ kind: 'cancel_order', ...input })),
    listAssociationRegistrations: command('listAssociationRegistrations',
      'Read attendees and registration state for a returned event id.' + followPages,
      AssociationListPageSchema.extend({ eventId: Id, status: AssociationRegistrationStatusSchema.optional() }).strict(),
      true, true, input => ({ kind: 'list_registrations', ...input })),
    updateAssociationRegistration: command('updateAssociationRegistration',
      'Check in or cancel a returned registration through the canonical participation/inventory authority. This cannot create an attendee or assert payment.',
      z.object({ registrationId: Id, update: AssociationRegistrationUpdateSchema }).strict(),
      false, true, input => ({ kind: 'update_registration', ...input })),
    listAssociationWaitlist: command('listAssociationWaitlist',
      'Read validated waitlist submissions and existing offers. A listed submission does not reserve inventory.' + followPages,
      AssociationListPageSchema.extend({ eventId: Id.optional(), includeClosed: z.boolean().default(false) }).strict(),
      true, true, input => ({ kind: 'list_waitlist', ...input })),
    offerAssociationWaitlistPlace: command('offerAssociationWaitlistPlace',
      'Explicitly offer a listed waitlist submission a place by reserving available ticket inventory. Keep one promotionId for the same intended offer and retry it unchanged. An offer does not send a notification or confirm payment.',
      z.object({ offer: AssociationWaitlistOfferInputSchema }).strict(), false, true, input => ({ kind: 'offer_waitlist_place', ...input })),
    listAssociationModuleBlockers: command('listAssociationModuleBlockers',
      'Read pending orders blocking module drain completion. Resolve these through allowed cancellation or provider reconciliation.' + followPages,
      AssociationListPageSchema.strict(), true, true, input => ({ kind: 'module_blockers', ...input })),
    listAssociationProviderReceipts: command('listAssociationProviderReceipts',
      'Inspect safe provider receipt history and reconciliation states. A receipt needing reconciliation is not successful payment. Only an authenticated backend can apply provider evidence.' + followPages,
      AssociationListPageSchema.extend({ orderId: Id.optional(), entitlementId: Id.optional(), state: ProviderReceiptStateSchema.optional() }).strict(),
      true, true, input => ({ kind: 'list_provider_receipts', ...input })),
  }
}

export type AssociationTools = ReturnType<typeof createAssociationTools>
