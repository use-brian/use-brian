/** CRM-only bearer router. Mount before bare JWT /api guards.
 * [COMP:api/crm-integration-auth]
 */
import { sendCrmPrivacyExport } from '../crm-operations/privacy-export.js'
import { Router, raw, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  CRM_INTEGRATION_OPERATIONS, CRM_INTEGRATION_RESOURCE_CATALOG,
  CrmOperationsCommandSchema, CrmOperationsError, assertCrmOperationsAuthority,
  CrmPageQuerySchema, requireCrmIntegrationOperation, crmIntegrationResourceSelection,
  CrmReferenceLookupQuerySchema, CrmReferencePreviewQuerySchema, type CrmReferenceReadPort,
  CrmAccountListQuerySchema, CrmCommercialProfileQuerySchema, CrmResolutionQuerySchema, type CrmCommercialContextReadPort,
  CrmInvoiceListQuerySchema, type CrmCommercialDocumentReadPort,
  CrmChangeRequestQuerySchema, CrmEngagementQuerySchema, CrmBillingRequestQuerySchema, CrmBillingBalanceQuerySchema,
  CrmRecurringPreviewQuerySchema, type CrmGovernedReadPort,
  type CrmDeliveryServicePort,
  type CrmOperationsContext, type CrmOperationsServicePort, type AssociationServicePort,
} from '@use-brian/core'
import type { CrmIntegrationPrincipal, CrmIntegrationStore } from '../db/crm-integration-store.js'
import { CreateCrmIntegrationCredentialSchema } from '../db/crm-integration-store.js'
import { createDbCrmIntakeReadStore, type DbCrmOperationsReadStore } from '../db/crm-intake-store.js'
import {
  createCrmIntegrationRecordReadStore, CrmIntegrationMemberProfileUpdateSchema,
  CrmIntegrationMemberVerifiedEmailUpdateSchema,
  type CrmIntegrationMemberProfile,
} from '../db/crm-integration-records.js'
import { CrmPipelinesQuerySchema, CrmRecordFieldsQuerySchema } from '../db/crm-config-catalog.js'
import { MAX_CRM_IMPORT_SOURCE_BYTES, type CrmImportSources } from '../db/crm-import-sources.js'
import type { CrmProductionImportService } from '../crm-operations/import-service.js'
import { requireImportOperation } from '../crm-operations/import-authority.js'
import { listCrmOperationsAudit, listCrmEventDelivery } from '../crm-operations/privacy.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { associationErrorResponse } from './association.js'
import { associationMemberContext, crmAssociationRoutes } from './crm-association.js'
import { sendWebsiteMedia, type WebsiteMediaDeps } from './association-media.js'
import { SubmissionQuery, SendabilityQuery, EntitlementPlansQuery, EntitlementsQuery, EventsQuery, ParticipationQuery, SegmentListQuery } from './crm-operations.js'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { CrmIntegrationBindingOptionsSchema } from '../crm-operations/integration-department-authority.js'
import { createCrmReferenceReadStore } from '../db/crm-business-reference-store.js'
import { createCrmCommercialContextReadStore } from '../db/crm-commercial-context-store.js'
import { createCrmCommercialDocumentReadStore } from '../db/crm-commercial-document-store.js'
import { createCrmGovernedReadStore } from '../db/crm-governed-store.js'

const UUID = z.string().uuid()
export function crmIntegrationContext(principal: CrmIntegrationPrincipal): CrmOperationsContext {
  return { workspaceId: principal.workspaceId, actor: { kind: 'integration_key', credentialId: principal.credentialId },
    authority: { role: 'system', canWrite: true,
      canConfigure: principal.grants.some((grant) => ['crm.catalog.configure', 'crm.references.configure', 'crm.commercial.configure'].includes(grant.operation)),
      trustedIdentitySources: [], integration: { credentialId: principal.credentialId, grants: principal.grants } } }
}

export function crmIntegrationRoutes(options: {
  credentials: Pick<CrmIntegrationStore, 'authenticate'>
  service: CrmOperationsServicePort
  association: AssociationServicePort
  deliveries?: CrmDeliveryServicePort
  imports?: CrmProductionImportService
  importSources?: CrmImportSources
  reads?: (principal: CrmIntegrationPrincipal) => DbCrmOperationsReadStore
  referenceReads?: CrmReferenceReadPort
  commercialReads?: CrmCommercialContextReadPort
  documentReads?: CrmCommercialDocumentReadPort
  governedReads?: CrmGovernedReadPort
  /** Website media library reads (`association.read`); absent → 404. */
  websiteMedia?: Pick<WebsiteMediaDeps, 'store' | 'resolver'>
  memberProfiles?: (principal: CrmIntegrationPrincipal) => {
    getMemberProfile(id: unknown): Promise<CrmIntegrationMemberProfile | null>
    updateMemberProfile(id: unknown, update: unknown): Promise<CrmIntegrationMemberProfile | null>
    updateMemberVerifiedEmail(id: unknown, update: unknown): Promise<CrmIntegrationMemberProfile | null>
  }
}): Router {
  const router = Router()
  router.use(async (req, res, next) => {
    try {
      const header = req.get('authorization')
      const token = /^Bearer (sk_crm_\S+)$/i.exec(header ?? '')?.[1]
      const principal = token ? await options.credentials.authenticate(token) : null
      if (!principal) { res.status(401).json({ error: 'invalid_crm_integration_credential' }); return }
      res.locals.crmIntegration = principal
      if (principal.departmentRead) {
        runWithAgentAccess({ workspaceId: principal.workspaceId, userId: principal.departmentRead.userId,
          clearance: 'confidential', compartments: null, ...principal.executionLimits, departmentRead: principal.departmentRead }, next)
      } else next()
    } catch (error) { associationErrorResponse(error, res) }
  })
  const principal = (res: Response): CrmIntegrationPrincipal => res.locals.crmIntegration as CrmIntegrationPrincipal
  const reads = (res: Response) => (options.reads ?? createDbCrmIntakeReadStore)(principal(res))
  const memberProfiles = (res: Response) => (options.memberProfiles ?? createCrmIntegrationRecordReadStore)(principal(res))
  const endpoint = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try { await fn(req, res) } catch (error) { associationErrorResponse(error, res) }
  }
  router.get('/catalog', (_req, res) => res.set('Cache-Control', 'no-store').json({
    workspaceId: principal(res).workspaceId, credentialId: principal(res).credentialId,
    operations: CRM_INTEGRATION_OPERATIONS,
    selectors: CRM_INTEGRATION_RESOURCE_CATALOG, grants: principal(res).grants }))
  router.post('/operations/import-sources', (req, res, next) => {
    try {
      requireImportOperation(crmIntegrationContext(principal(res)), 'crm.imports.write')
      if (!req.is('text/csv')) { res.status(415).json({ error: 'csv_required' }); return }
      UUID.parse(req.get('Idempotency-Key'))
      next()
    } catch (error) { associationErrorResponse(error, res) }
  }, raw({ type: 'text/csv', limit: MAX_CRM_IMPORT_SOURCE_BYTES, inflate: false }), endpoint(async (req, res) => {
    if (!options.importSources) { res.status(503).json({ error: 'import_unavailable' }); return }
    if (!Buffer.isBuffer(req.body)) throw new CrmOperationsError('invalid_input', 'CSV bytes are required.')
    const result = await options.importSources.stage(crmIntegrationContext(principal(res)), UUID.parse(req.get('Idempotency-Key')), req.body)
    res.status(result.created ? 201 : 200).json(result)
  }))
  const imports = () => {
    if (!options.imports) throw new CrmOperationsError('not_found', 'CRM import service is unavailable.')
    return options.imports
  }
  router.post('/operations/imports/dry-run', endpoint(async (req, res) => {
    res.json(await imports().dryRun(crmIntegrationContext(principal(res)), req.body))
  }))
  router.post('/operations/imports', endpoint(async (req, res) => {
    res.status(201).json(await imports().confirm(crmIntegrationContext(principal(res)), req.body))
  }))
  router.get('/operations/imports', endpoint(async (req, res) => {
    res.json(await imports().list(crmIntegrationContext(principal(res)), CrmPageQuerySchema.parse(req.query)))
  }))
  router.get('/operations/imports/:id', endpoint(async (req, res) => {
    const job = await imports().get(crmIntegrationContext(principal(res)), UUID.parse(req.params.id))
    if (!job) { res.status(404).json({ error: 'not_found' }); return }
    res.json(job)
  }))
  for (const action of ['resume', 'cancel'] as const) router.post(`/operations/imports/:id/${action}`, endpoint(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {})
    res.json(await imports()[action](crmIntegrationContext(principal(res)), UUID.parse(req.params.id)))
  }))
  router.get('/operations/imports/:id/errors.csv', endpoint(async (req, res) => {
    const csv = await imports().errorsCsv(crmIntegrationContext(principal(res)), UUID.parse(req.params.id))
    if (csv === null) { res.status(404).json({ error: 'not_found' }); return }
    res.type('text/csv').attachment('crm-import-errors.csv').send(csv)
  }))
  router.get('/operations/imports/:id/results.csv', endpoint(async (req, res) => {
    const csv = await imports().resultsCsv(crmIntegrationContext(principal(res)), UUID.parse(req.params.id))
    if (csv === null) { res.status(404).json({ error: 'not_found' }); return }
    res.type('text/csv').attachment('crm-import-results.csv').send(csv)
  }))
  for (const path of ['audit', 'event-delivery'] as const) {
    router.get(`/operations/${path}`, endpoint(async (req, res) => {
      requireCrmIntegrationOperation(principal(res), 'crm.audit.read')
      const actor=principal(res),filters=CrmPageQuerySchema.parse(req.query)
      res.json(await (path==='event-delivery'
        ? listCrmEventDelivery(crmIntegrationContext(actor),filters)
        : listCrmOperationsAudit(crmIntegrationContext(actor),filters)))
    }))
  }
  router.get('/operations/member-profiles/:id', endpoint(async (req, res) => {
    requireCrmIntegrationOperation(principal(res), 'crm.records.read')
    const profile = await memberProfiles(res).getMemberProfile(req.params.id)
    if (!profile) { res.status(404).json({ error: 'not_found' }); return }
    res.set('Cache-Control', 'no-store').json({ profile })
  }))
  router.patch('/operations/member-profiles/:id', endpoint(async (req, res) => {
    requireCrmIntegrationOperation(principal(res), 'crm.records.read')
    requireCrmIntegrationOperation(principal(res), 'crm.records.write')
    const profile = await memberProfiles(res).updateMemberProfile(
      req.params.id,
      CrmIntegrationMemberProfileUpdateSchema.parse(req.body),
    )
    if (!profile) { res.status(404).json({ error: 'not_found' }); return }
    res.set('Cache-Control', 'no-store').json({ profile })
  }))
  router.patch('/operations/member-profiles/:id/verified-email', endpoint(async (req, res) => {
    requireCrmIntegrationOperation(principal(res), 'crm.records.read')
    requireCrmIntegrationOperation(principal(res), 'crm.records.write')
    const profile = await memberProfiles(res).updateMemberVerifiedEmail(
      req.params.id,
      CrmIntegrationMemberVerifiedEmailUpdateSchema.parse(req.body),
    )
    if (!profile) { res.status(404).json({ error: 'not_found' }); return }
    res.set('Cache-Control', 'no-store').json({ profile })
  }))
  router.get('/operations/records', endpoint(async (req, res) => {
    res.json(await createCrmIntegrationRecordReadStore(principal(res)).list(req.query))
  }))
  router.get('/operations/records/:id', endpoint(async (req, res) => {
    const record = await createCrmIntegrationRecordReadStore(principal(res)).get(req.params.id, req.query)
    if (!record) { res.status(404).json({ error: 'not_found' }); return }
    res.json({ record })
  }))
  router.get('/operations/record-fields', endpoint(async (req, res) => {
    res.json(await reads(res).listRecordFields(principal(res).workspaceId, CrmRecordFieldsQuerySchema.parse(req.query)))
  }))
  router.get('/operations/pipelines', endpoint(async (req, res) => {
    const filters = CrmPipelinesQuerySchema.parse(req.query)
    res.json(await reads(res).listPipelines(principal(res).workspaceId, {
      ...filters, includeArchived: filters.includeArchived === 'true',
    }))
  }))
  router.get('/operations/privacy-export',endpoint(async(req,res)=>{
    z.object({format:z.literal('crm-privacy-v2').default('crm-privacy-v2')}).strict().parse(req.query)
    await sendCrmPrivacyExport(res,crmIntegrationContext(principal(res)))
  }))
  router.get('/operations/contacts/:contactId/privacy-export',endpoint(async(req,res)=>{
    z.object({format:z.literal('crm-privacy-v2').optional()}).strict().parse(req.query)
    await sendCrmPrivacyExport(res,crmIntegrationContext(principal(res)),{contactId:UUID.parse(req.params.contactId)})
  }))
  router.get('/operations/deliveries/:id', endpoint(async (req,res) => {
    const context=crmIntegrationContext(principal(res))
    requireCrmIntegrationOperation(principal(res),'crm.delivery.read')
    if(!options.deliveries) {res.status(503).json({error:'delivery_unavailable'});return}
    const receipt=await options.deliveries.get(context,UUID.parse(req.params.id))
    if(!receipt) {res.status(404).json({error:'not_found'});return}
    res.set('Cache-Control','no-store').json({receipt})
  }))
  // Reference reads run under the credential's bound department principal.
  const referenceReads = options.referenceReads ?? createCrmReferenceReadStore()
  const referenceViewer = (res: Response) => {
    const current = principal(res)
    requireCrmIntegrationOperation(current, 'crm.references.read')
    if (!current.departmentRead) throw new CrmOperationsError('not_authorized', 'Reference reads require a department-bound integration credential.')
    const selection = crmIntegrationResourceSelection(current, 'crm.references.read', 'referenceDefinitionKeys')
    return { viewer: { userId: current.departmentRead.userId, canConfigure: false }, allowed: selection === 'all' ? undefined : selection }
  }
  router.get('/operations/reference-definitions', endpoint(async (req, res) => {
    const { viewer, allowed } = referenceViewer(res)
    z.object({}).strict().parse(req.query)
    res.json(await referenceReads.listDefinitions(principal(res).workspaceId, viewer, { allowedDefinitionKeys: allowed }))
  }))
  router.get('/operations/references/preview', endpoint(async (req, res) => {
    const { viewer, allowed } = referenceViewer(res)
    const query = CrmReferencePreviewQuerySchema.parse(req.query)
    if (allowed && !allowed.includes(query.definitionKey)) throw new CrmOperationsError('not_found', 'Reference definition was not found.')
    res.set('Cache-Control', 'no-store').json(await referenceReads.preview(principal(res).workspaceId, viewer, query))
  }))
  router.get('/operations/references', endpoint(async (req, res) => {
    const { viewer, allowed } = referenceViewer(res)
    res.json(await referenceReads.lookup(principal(res).workspaceId, viewer, CrmReferenceLookupQuerySchema.parse(req.query), allowed))
  }))
  router.get('/operations/references/:id/history', endpoint(async (req, res) => {
    const { viewer, allowed } = referenceViewer(res)
    const found = await referenceReads.history(principal(res).workspaceId, viewer, UUID.parse(req.params.id), allowed)
    if (!found) { res.status(404).json({ error: 'not_found' }); return }
    res.json(found)
  }))
  // Commercial context reads; selectors filter by seller and operation before any row is returned.
  const commercialReads = options.commercialReads ?? createCrmCommercialContextReadStore()
  const commercialViewer = (res: Response) => {
    const current = principal(res)
    requireCrmIntegrationOperation(current, 'crm.commercial.read')
    if (!current.departmentRead) throw new CrmOperationsError('not_authorized', 'Commercial reads require a department-bound integration credential.')
    const sellers = crmIntegrationResourceSelection(current, 'crm.commercial.read', 'sellerKeys')
    const operations = crmIntegrationResourceSelection(current, 'crm.commercial.read', 'operationKeys')
    return { viewer: { userId: current.departmentRead.userId, canConfigure: false }, sellers, operations }
  }
  const sellerAllowed = (sellers: 'all' | readonly string[], key: unknown) => sellers === 'all' || (typeof key === 'string' && sellers.includes(key))
  router.get('/operations/accounts', endpoint(async (req, res) => {
    const { viewer, sellers } = commercialViewer(res)
    const query = CrmAccountListQuerySchema.parse(req.query)
    if (sellers !== 'all' && (!query.sellerKey || !sellers.includes(query.sellerKey))) throw new CrmOperationsError('invalid_input', 'Name a granted sellerKey.', { validValues: sellers })
    res.json(await commercialReads.listAccounts(principal(res).workspaceId, viewer, query))
  }))
  const accountSellerAllowed = async (res: Response, viewer: { userId: string }, sellers: 'all' | readonly string[], accountId: string) => {
    if (sellers === 'all') return
    const account = await commercialReads.getAccount(principal(res).workspaceId, viewer, accountId)
    if (!account || !sellerAllowed(sellers, account.sellerKey)) throw new CrmOperationsError('not_found', 'The record is unavailable in your current scope.')
  }
  router.get('/operations/commercial-profiles', endpoint(async (req, res) => {
    const { viewer, sellers } = commercialViewer(res)
    const query = CrmCommercialProfileQuerySchema.parse(req.query)
    if (query.accountId) await accountSellerAllowed(res, viewer, sellers, query.accountId)
    else if (!sellerAllowed(sellers, query.sellerKey)) throw new CrmOperationsError('not_found', 'The record is unavailable in your current scope.')
    res.json(await commercialReads.listProfiles(principal(res).workspaceId, viewer, query))
  }))
  router.get('/operations/commercial-profiles/resolve', endpoint(async (req, res) => {
    const { viewer, sellers, operations } = commercialViewer(res)
    const query = CrmResolutionQuerySchema.parse(req.query)
    if (operations !== 'all' && !operations.includes(query.operationKey)) throw new CrmOperationsError('not_found', 'The operation has no accepted version.')
    await accountSellerAllowed(res, viewer, sellers, query.accountId)
    res.set('Cache-Control', 'no-store').json(await commercialReads.resolve(principal(res).workspaceId, viewer, query))
  }))
  // Invoices and preparations: only all-seller read grants see documents; amounts follow the document's own scope.
  const documentReads = options.documentReads ?? createCrmCommercialDocumentReadStore()
  const documentViewer = (res: Response) => {
    const { viewer, sellers } = commercialViewer(res)
    if (sellers !== 'all') throw new CrmOperationsError('not_authorized', 'Document reads require a commercial read grant for every seller.')
    return viewer
  }
  router.get('/operations/invoices', endpoint(async (req, res) => {
    res.json(await documentReads.listInvoices(principal(res).workspaceId, documentViewer(res), CrmInvoiceListQuerySchema.parse(req.query)))
  }))
  router.get('/operations/invoices/:id', endpoint(async (req, res) => {
    const found = await documentReads.getInvoice(principal(res).workspaceId, documentViewer(res), UUID.parse(req.params.id))
    if (!found) { res.status(404).json({ error: 'not_found' }); return }
    res.json(found)
  }))
  router.get('/operations/preparations/:id', endpoint(async (req, res) => {
    const found = await documentReads.getPreparation(principal(res).workspaceId, documentViewer(res), UUID.parse(req.params.id))
    if (!found) { res.status(404).json({ error: 'not_found' }); return }
    res.json(found)
  }))
  // Governed records: workspace-wide read grants, evaluated as the credential's department-bound viewer.
  const governedReads = options.governedReads ?? createCrmGovernedReadStore()
  const governedViewer = (res: Response, operation: 'crm.changes.read' | 'crm.engagements.read' | 'crm.billing.read') => {
    const current = principal(res)
    requireCrmIntegrationOperation(current, operation)
    if (!current.departmentRead) throw new CrmOperationsError('not_authorized', 'Governed record reads require a department-bound integration credential.')
    return { userId: current.departmentRead.userId }
  }
  router.get('/operations/change-requests', endpoint(async (req, res) => {
    res.json(await governedReads.listChangeRequests(principal(res).workspaceId, governedViewer(res, 'crm.changes.read'), CrmChangeRequestQuerySchema.parse(req.query)))
  }))
  router.get('/operations/change-requests/:id', endpoint(async (req, res) => {
    const found = await governedReads.getChangeRequest(principal(res).workspaceId, governedViewer(res, 'crm.changes.read'), UUID.parse(req.params.id))
    if (!found) { res.status(404).json({ error: 'not_found' }); return }
    res.json(found)
  }))
  router.get('/operations/engagements', endpoint(async (req, res) => {
    const query = CrmEngagementQuerySchema.parse(req.query)
    // Protected values need the billing read grant as well as their own row protection.
    if (query.includeCommercialValues) governedViewer(res, 'crm.billing.read')
    res.json(await governedReads.listEngagements(principal(res).workspaceId, governedViewer(res, 'crm.engagements.read'), query))
  }))
  router.get('/operations/billing-requests', endpoint(async (req, res) => {
    res.json(await governedReads.listBillingRequests(principal(res).workspaceId, governedViewer(res, 'crm.billing.read'), CrmBillingRequestQuerySchema.parse(req.query)))
  }))
  router.get('/operations/billing-balance', endpoint(async (req, res) => {
    res.json(await governedReads.billingBalance(principal(res).workspaceId, governedViewer(res, 'crm.billing.read'), CrmBillingBalanceQuerySchema.parse(req.query)))
  }))
  router.get('/operations/recurring-successors/preview', endpoint(async (req, res) => {
    res.json(await governedReads.previewRecurringSuccessors(principal(res).workspaceId, governedViewer(res, 'crm.engagements.read'), CrmRecurringPreviewQuerySchema.parse(req.query)))
  }))
  router.get('/operations/operation-definitions', endpoint(async (_req, res) => {
    const { viewer, operations } = commercialViewer(res)
    const result = await commercialReads.listOperationDefinitions(principal(res).workspaceId, viewer)
    res.json({ ...result, operations: result.operations.filter((row) => operations === 'all' || operations.includes(row.operationKey as string)) })
  }))
  router.post('/operations/commands', endpoint(async (req, res) => {
    const context = crmIntegrationContext(principal(res))
    if (req.body && ['workspaceId', 'actor', 'authority'].some((key) => Object.hasOwn(req.body, key))) {
      throw new CrmOperationsError('invalid_input', 'Workspace and authority are credential-derived.')
    }
    const command = CrmOperationsCommandSchema.parse(req.body)
    assertCrmOperationsAuthority(context, command)
    const result = await options.service.execute(context, command)
    res.status(result.created ? 201 : 200).json(result)
  }))
  const commands = [
    ['/intake-definitions', 'save_intake_definition'], ['/consent-purposes', 'save_consent_purpose'],
    ['/entitlement-plans', 'save_entitlement_plan'], ['/events', 'save_event'], ['/submissions', 'record_submission'],
    ['/deliveries', 'send_message'], ['/entitlements', 'grant_entitlement'], ['/participation', 'record_participation'],
  ] as const
  for (const [path, kind] of commands) router.post(`/operations${path}`, endpoint(async (req, res) => {
    const context = crmIntegrationContext(principal(res))
    const raw = z.record(z.unknown()).parse(req.body)
    if (['kind', 'workspaceId', 'actor', 'authority'].some((key) => Object.hasOwn(raw, key))) throw new CrmOperationsError('invalid_input', 'Use only command business fields.')
    const command = CrmOperationsCommandSchema.parse({ ...raw, kind })
    assertCrmOperationsAuthority(context, command)
    const result = await options.service.execute(context, command)
    res.status(result.created ? 201 : 200).json(result)
  }))
  router.get('/operations/intake-definitions', endpoint(async (req, res) => {
    res.json(await reads(res).listDefinitions(principal(res).workspaceId, CrmPageQuerySchema.parse(req.query)))
  }))
  router.get('/operations/segments', endpoint(async (req, res) => {
    const query = SegmentListQuery.parse(req.query)
    res.json(await reads(res).listSegments(principal(res).workspaceId, {
      ...query, includeArchived: query.includeArchived === 'true',
    }))
  }))
  router.get('/operations/consent-purposes', endpoint(async (req, res) => {
    const query = CrmPageQuerySchema.extend({ includeArchived: z.enum(['true', 'false']).optional() }).strict().parse(req.query)
    res.json(await reads(res).listConsentPurposes(principal(res).workspaceId, query.includeArchived === 'true', query))
  }))
  router.get('/operations/submissions', endpoint(async (req, res) => {
    res.json(await reads(res).listSubmissions(principal(res).workspaceId, SubmissionQuery.parse(req.query)))
  }))
  router.get('/operations/submissions/:id', endpoint(async (req, res) => {
    const submission = await reads(res).getSubmission(principal(res).workspaceId, UUID.parse(req.params.id))
    if (!submission) { res.status(404).json({ error: 'not_found' }); return }
    res.json({ submission })
  }))
  router.get('/operations/entitlement-plans', endpoint(async (req, res) => {
    res.json(await reads(res).listEntitlementPlans(principal(res).workspaceId, EntitlementPlansQuery.parse(req.query)))
  }))
  router.get('/operations/entitlements', endpoint(async (req, res) => {
    res.json(await reads(res).listEntitlements(principal(res).workspaceId, EntitlementsQuery.parse(req.query), crmIntegrationContext(principal(res)).actor))
  }))
  router.get('/operations/events', endpoint(async (req, res) => {
    res.json(await reads(res).listEvents(principal(res).workspaceId, EventsQuery.parse(req.query)))
  }))
  router.get('/operations/participation', endpoint(async (req, res) => {
    res.json(await reads(res).listParticipation(principal(res).workspaceId, ParticipationQuery.parse(req.query), crmIntegrationContext(principal(res)).actor))
  }))
  router.get('/operations/contacts/:id/consent', endpoint(async (req, res) => {
    res.json(await reads(res).getConsent(principal(res).workspaceId, UUID.parse(req.params.id)))
  }))
  router.get('/operations/contacts/:id/sendability', endpoint(async (req, res) => {
    const query = SendabilityQuery.parse(req.query)
    res.json(await reads(res).checkSendability(principal(res).workspaceId, UUID.parse(req.params.id), query.channel, query.purposeKey))
  }))
  // Website media: one staff-published image/PDF by id, for the website
  // backend's image pipeline. Same grant as every other published website read.
  router.get('/association/media/:id', endpoint(async (req, res) => {
    const ctx = crmIntegrationContext(principal(res))
    requireCrmIntegrationOperation(ctx.authority.integration!, 'association.read')
    if (!options.websiteMedia) { res.status(404).json({ error: 'media_not_found' }); return }
    await sendWebsiteMedia(res, options.websiteMedia, ctx.workspaceId, String(req.params.id))
  }))
  router.use('/association', crmAssociationRoutes({ service: options.association, context: async (_req, res) => {
    const ctx = crmIntegrationContext(principal(res))
    return { ...ctx, authority: { ...ctx.authority, canRead: true, canReconcileProvider: true } }
  } }))
  // Terminate here. CRM keys must never fall through into member/admin routers.
  router.use((_req, res) => res.status(403).json({ error: 'integration_scope_denied' }))
  return router
}

export function crmIntegrationCredentialRoutes(options: { workspaceStore: WorkspaceStore; credentials: CrmIntegrationStore }): Router {
  const router = Router()
  const member = associationMemberContext(options.workspaceStore)
  const endpoint = (fn: (req: Request, res: Response, workspaceId: string, userId: string) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      const context = await member(req, res)
      if (!context) return
      if (context.actor.kind !== 'user' || !context.authority.canConfigure) throw new CrmOperationsError('not_authorized', 'An owner or admin is required for integration credentials.')
      res.setHeader('Cache-Control', 'no-store')
      await fn(req, res, context.workspaceId, context.actor.userId)
    } catch (error) { associationErrorResponse(error, res) }
  }
  const path = '/:workspaceId/operations/integration-credentials'
  router.get(`${path}/binding-options`, endpoint(async (req, res, workspaceId, userId) => {
    res.json(await options.credentials.bindingOptions(workspaceId, userId, CrmIntegrationBindingOptionsSchema.parse(req.query)))
  }))
  router.get(`${path}/catalog`, endpoint(async (_req, res) => { res.json({ operations: CRM_INTEGRATION_OPERATIONS, selectors: CRM_INTEGRATION_RESOURCE_CATALOG }) }))
  router.get(path, endpoint(async (req, res, workspaceId, userId) => { res.json(await options.credentials.listForMember(workspaceId, userId, CrmPageQuerySchema.parse(req.query))) }))
  router.post(path, endpoint(async (req, res, workspaceId, userId) => {
    res.status(201).json(await options.credentials.create(workspaceId, userId, CreateCrmIntegrationCredentialSchema.parse(req.body)))
  }))
  router.post(`${path}/:id/revoke`, endpoint(async (req, res, workspaceId, userId) => {
    z.object({}).strict().parse(req.body ?? {})
    res.json({ revoked: await options.credentials.revoke(workspaceId, userId, UUID.parse(req.params.id)) })
  }))
  return router
}
