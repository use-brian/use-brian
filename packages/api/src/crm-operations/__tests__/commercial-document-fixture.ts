/**
 * Shared real-boundary fixture for the invoice preparation suites: a
 * fictional workspace, accounts and accepted terms, an issue-time numbering
 * definition, a template admitted from real XLSX bytes through the Office
 * compiler and stores, an accepted invoice operation, and the canonical
 * Office binding over local file storage. No service or Office mocks.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { compileOfficeTemplate, inferOfficeTemplateRouting, importOfficeSpreadsheet, type CrmOperationsCommand, type CrmOperationsContext } from '@use-brian/core'
import type { SpreadsheetSnapshot } from '@use-brian/office-model'
import { buildFictionalInvoiceXlsx, fictionalInvoiceFieldTypes, fictionalLogoPng, CRM_INVOICE_FIXTURE_LINES } from '../../../../core/src/office/__tests__/crm-invoice-fixture.js'
import { createCrmOperationsService } from '../service.js'
import { createDbCrmOperationsStore } from '../../db/crm-operations-store.js'
import { createCrmCommercialDocumentReadStore } from '../../db/crm-commercial-document-store.js'
import { createCrmOfficeBindingFromOffice, type CrmOfficeBindingPort } from '../office-binding.js'
import type { CrmCommercialDocumentRuntime } from '../commercial-preparations.js'
import { createOfficeReleaseRuntime, createOfficeTemplateBundleReader } from '../../office/release-runtime.js'
import { createOfficeArtifactStore } from '../../db/office-artifacts.js'
import { createOfficeLiveStore } from '../../db/office-live.js'
import { createOfficeReleaseStore } from '../../db/office-release.js'
import { createOfficeTemplateStore } from '../../db/office-templates.js'
import type { OfficeReleaseRouteDeps } from '../../routes/office-releases.js'

export const SEED_LINES = CRM_INVOICE_FIXTURE_LINES

export async function createCommercialDocumentHarness(pool: pg.Pool) {
  const { createFilesApi } = await import('../../files/files-api.js')
  const { createLocalFilesClient } = await import('../../files/local-files-client.js')
  const { createDbWorkspaceFilesStore } = await import('../../db/workspace-files-store.js')
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'crm-invoice-'))
  const filesApi = createFilesApi({ gcs: createLocalFilesClient({ baseDir }), bucket: 'crm-invoice-local', store: createDbWorkspaceFilesStore(),
    auditStore: { append: async () => {} } as never } as never)
  const artifacts = createOfficeArtifactStore(), live = createOfficeLiveStore(), releases = createOfficeReleaseStore(), templates = createOfficeTemplateStore()
  const runtime = createOfficeReleaseRuntime({ filesApi, artifacts, live, releases, templates })
  const releaseDeps: OfficeReleaseRouteDeps = {
    load: runtime.loadOfficeReleaseContext,
    resolveResource: (userId, workspaceId) => async (resourceId) => runtime.readOfficeResource(userId, workspaceId, resourceId),
    revalidate: runtime.revalidateOfficeRelease,
    saveReleasedFile: ({ userId, workspaceId, artifactId, version, action, extension, mime, bytes, hash, scope }) =>
      runtime.saveClassifiedOfficeFile({ userId, workspaceId, path: `/office/releases/${artifactId}/v${version}-${action}-${randomUUID()}.${extension}`, bytes, mime, hash, scope }),
    createRecord: releases.createRelease,
    createDerivative: async () => { throw new Error('not used') },
  }
  const readTemplateBundle = createOfficeTemplateBundleReader({ filesApi, templates, artifacts })
  const binding = createCrmOfficeBindingFromOffice({ filesApi, artifacts, live, readTemplateBundle: (u, w, v) => readTemplateBundle(u, w, v), releaseDeps })
  /** Tests may wrap the canonical binding to inject a boundary failure. */
  const documents: CrmCommercialDocumentRuntime = { binding }
  const store = createDbCrmOperationsStore(pool)
  const service = createCrmOperationsService(store, { documents })
  const reads = createCrmCommercialDocumentReadStore((sql, values) => pool.query(sql, values as unknown[]) as never)
  return { filesApi, artifacts, live, releases, templates, runtime, binding: binding as CrmOfficeBindingPort, documents, store, service, reads }
}

export type CommercialDocumentHarness = Awaited<ReturnType<typeof createCommercialDocumentHarness>>

export async function seedInvoiceWorkspace(pool: pg.Pool, harness: CommercialDocumentHarness, options: { reviewPolicy?: 'direct' | 'exact_version_review' } = {}) {
  const workspaceId = randomUUID(), owner = randomUUID(), admin = randomUUID(), member = randomUUID()
  for (const user of [owner, admin, member]) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
  await pool.query("INSERT INTO workspaces(id,name,purpose,owner_user_id,is_personal) VALUES($1,'Fictional invoicing fixture','test',$2,false)", [workspaceId, owner])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'admin','confidential'),($1,$4,'member','internal')`,
    [workspaceId, owner, admin, member])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id) VALUES(gen_random_uuid(),'Fixture assistant',$1,$2)", [owner, workspaceId])
  const entity = async (kind: 'company' | 'deal', name: string, attributes: Record<string, unknown> = {}) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,attributes,sensitivity)
      VALUES($1,$2,$3,$4,$5,'manual',$6::jsonb,'internal')`, [id, workspaceId, kind, name, owner, JSON.stringify(attributes)])
    return id
  }
  const ctx = (userId: string, role: 'owner' | 'admin' | 'member'): CrmOperationsContext => ({ workspaceId, actor: { kind: 'user', userId },
    authority: { role, canWrite: true, canConfigure: role !== 'member', trustedIdentitySources: [] } })
  const roles: Record<string, 'owner' | 'admin' | 'member'> = { [owner]: 'owner', [admin]: 'admin', [member]: 'member' }
  const exec = (userId: string, command: Record<string, unknown>) =>
    harness.service.execute(ctx(userId, roles[userId]!), { operationId: randomUUID(), ...command } as CrmOperationsCommand)

  const company = await entity('company', 'Example Buyer Limited')
  const deal = await entity('deal', 'Example advisory retainer', { company_id: company })
  const secondDeal = await entity('deal', 'Example audit support', { company_id: company })
  await exec(owner, { kind: 'save_seller_profile', seller: { sellerKey: 'studio', legalName: 'Example Studio Limited', displayName: 'Example Studio', timezone: 'Asia/Hong_Kong' } })
  await exec(owner, { kind: 'accept_commercial_profile', owner: { kind: 'seller', sellerKey: 'studio' }, expectedCurrentVersion: 0, evidence: { kind: 'manual', note: 'Fictional seller defaults' },
    fields: { currency: { type: 'currency', value: 'HKD' }, tax_rate: { type: 'percent', value: '0' }, payment_provider: { type: 'string', value: 'Example Bank (fictional)' },
      payment_instructions: { type: 'text', value: 'Account 000-000000-000 (fictional), reference the invoice number' }, payment_terms: { type: 'string', value: 'Net 30' } } })
  const account = (await exec(owner, { kind: 'save_customer_account', account: { sellerKey: 'studio', companyId: company, label: 'Example retainer account',
    billingAddress: '1 Example Road, Example City' } })).record.account as { id: string }

  await exec(owner, { kind: 'save_reference_definition', definition: { definitionKey: 'invoice-number', label: 'Invoice number', targetKinds: ['invoice'],
    assignmentMode: 'native', namespaceKey: 'invoice-numbers', assignmentEvent: 'issue', partitionDimensions: ['business_year'], timezone: 'Asia/Hong_Kong',
    format: [{ kind: 'literal', text: 'INV-' }, { kind: 'date', part: 'yyyy' }, { kind: 'literal', text: '-' }, { kind: 'counter', width: 6 }], counterStart: 123 } })

  const template = await admitFictionalInvoiceTemplate(harness, workspaceId, owner)
  const tokens: Record<string, string> = {
    SELLER_NAME: 'seller.display_name', INVOICE_NUMBER: 'invoice.number', ISSUE_DATE: 'invoice.issue_date', CUSTOMER: 'buyer.name',
    BILLING_ADDRESS: 'buyer.billing_address', ACCOUNT_LABEL: 'buyer.account_label', TAX_RATE: 'invoice.tax_rate', CURRENCY: 'invoice.currency',
    PAYMENT_PROVIDER: 'field.payment_provider', PAYMENT_INSTRUCTIONS: 'field.payment_instructions', PAYMENT_TERMS: 'field.payment_terms',
  }
  for (let line = 1; line <= SEED_LINES; line++) {
    tokens[`LINE_${line}_DESCRIPTION`] = `line.${line}.description`
    tokens[`LINE_${line}_QTY`] = `line.${line}.quantity`
    tokens[`LINE_${line}_PRICE`] = `line.${line}.unit_price`
  }
  const reconcile = [{ path: 'invoice.subtotal', cell: 'Invoice!H34' }, { path: 'invoice.tax_amount', cell: 'Invoice!H36' }, { path: 'invoice.total', cell: 'Invoice!H37' },
    ...Array.from({ length: SEED_LINES }, (_, index) => ({ path: `line.${index + 1}.amount`, cell: `Invoice!H${21 + index}` }))]
  const proposed = await exec(owner, { kind: 'save_operation_definition', operationKey: 'invoice', operationKind: 'invoice', label: 'Prepare invoice', expectedVersion: 0,
    version: { instructions: 'Bill accepted account terms. Ask for any missing fact before issue; never invent payment terms.',
      fieldBindings: [
        { fieldKey: 'currency', label: 'Currency', type: 'currency', requiredFor: 'draft' },
        { fieldKey: 'tax_rate', label: 'Tax rate', type: 'percent', requiredFor: 'draft' },
        { fieldKey: 'payment_provider', label: 'Payment provider', type: 'string', requiredFor: 'draft' },
        { fieldKey: 'payment_instructions', label: 'Payment instructions', type: 'text', requiredFor: 'draft' },
        { fieldKey: 'payment_terms', label: 'Payment terms', type: 'string', requiredFor: 'issue', protected: true, overridable: true },
      ],
      templateBinding: { templateId: template.templateId, templateVersionId: template.versionId, pdfPreset: 'invoice', map: { tokens, reconcile } },
      reviewPolicy: options.reviewPolicy ?? 'direct', referenceDefinitionKey: 'invoice-number' } })
  await exec(owner, { kind: 'accept_operation_version', operationKey: 'invoice', versionId: (proposed.record.version as { id: string }).id, expectedVersion: 1 })
  return { workspaceId, owner, admin, member, company, deal, secondDeal, accountId: account.id, template, exec, ctx }
}

export async function admitFictionalInvoiceTemplate(harness: CommercialDocumentHarness, workspaceId: string, userId: string) {
  const shell = await harness.artifacts.createShell({ userId, workspaceId, family: 'spreadsheet', title: 'Fictional invoice template', templateVersionId: null, mode: 'template',
    capabilityVersion: 1, sensitivity: 'internal' })
  const xlsx = await buildFictionalInvoiceXlsx()
  const imported = await importOfficeSpreadsheet(xlsx, { artifactId: shell.id, workspaceId, templateVersionId: null, locale: 'en-US', defaultLanguage: 'en-US', title: 'Fictional invoice' })
  if (!imported.ok || imported.snapshot?.family !== 'spreadsheet') throw new Error(`Fixture XLSX import failed: ${JSON.stringify(imported.diagnostics)}`)
  const snapshot = imported.snapshot as SpreadsheetSnapshot
  const logo = imported.resources[0] ?? null
  if (!logo) throw new Error('Fixture XLSX lost its logo')
  const scope = { sensitivity: 'internal' as const, compartments: [], projectIds: [] }
  const logoBytes = logo.bytes.length ? logo.bytes : await fictionalLogoPng()
  const logoHash = createHash('sha256').update(logoBytes).digest('hex')
  const logoFile = await harness.runtime.saveClassifiedOfficeFile({ userId, workspaceId, path: `/office/resources/internal/${logoHash}`, bytes: logoBytes, mime: logo.ref.mime, hash: logoHash, scope })
  const resource = await harness.templates.addResource({ userId, workspaceId, kind: 'brand_media', name: 'Fictional logo', fileId: logoFile, hash: logoHash, mime: logo.ref.mime,
    licence: { name: 'Fictional fixture logo' }, embeddingRights: 'allowed', sensitivity: 'internal' })
  for (const sheet of snapshot.worksheets) for (const image of sheet.images) image.resourceId = resource.id
  snapshot.resources = snapshot.resources.map((ref) => ({ ...ref, id: resource.id, hash: logoHash }))
  const fields = inferOfficeTemplateRouting(snapshot).fields.map((field) => ({ ...field, ...fictionalInvoiceFieldTypes(field.name) }))
  const draft = await harness.templates.createDraft({ userId, workspaceId, family: 'spreadsheet', name: 'Fictional invoice', description: 'Fictional light invoice for tests',
    sensitivity: 'internal', draftArtifactId: shell.id })
  const compiled = await compileOfficeTemplate({ authoringPath: 'upload', draft: {
    id: draft.id, workspaceId, family: 'spreadsheet', version: 1, status: 'draft', name: 'Fictional invoice', description: 'Fictional light invoice for tests',
    tags: ['invoice'], locales: ['en-US'], whenToUse: ['Prepare an invoice'], whenNotToUse: ['Quotes'], exampleRequests: ['Prepare an invoice'], fields,
    slideRecipes: [], snapshot, resources: snapshot.resources, lockedObjectIds: [], allowedRepeatTargetIds: [], requiredEvidence: [],
    sensitivity: 'internal', visibilityUserIds: [], capabilityVersion: 1, sourceHash: createHash('sha256').update(xlsx).digest('hex'),
  }, resources: [{ id: resource.id, hash: logoHash, bytes: logoBytes, mime: logo.ref.mime, licence: { name: 'Fictional fixture logo' }, embeddingRights: 'allowed' }] })
  if (!compiled.bundle || compiled.bundle.status !== 'admitted') throw new Error(`Fixture template was not admitted: ${JSON.stringify(compiled.receipt.diagnostics)}`)
  const bundleBytes = new TextEncoder().encode(JSON.stringify(compiled.bundle))
  const bundleHash = createHash('sha256').update(bundleBytes).digest('hex')
  const bundleFile = await harness.runtime.saveClassifiedOfficeFile({ userId, workspaceId, path: `/office/templates/${draft.id}/internal/${bundleHash}.json`, bytes: bundleBytes, mime: 'application/json', hash: bundleHash, scope })
  const version = await harness.templates.addVersion({ userId, templateId: draft.id, workspaceId, bundleFileId: bundleFile, bundleHash, capabilityVersion: 1, locales: ['en-US'], tags: ['invoice'],
    whenToUse: [], whenNotToUse: [], exampleRequests: [], fieldSchema: compiled.bundle.fields, admissionReceipt: compiled.receipt, provenance: { source: 'fictional-fixture' },
    resourceIds: [resource.id], status: 'admitted' })
  return { templateId: draft.id, versionId: version.id, xlsx, logoHash }
}

export const lines = (count: number) => Array.from({ length: count }, (_, index) => ({ description: `Fictional service ${index + 1}`, quantity: index === 0 ? '2' : '1.5',
  unitPrice: index === 0 ? '1250.005' : '333.333333', dealId: null }))
