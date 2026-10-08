/** Closed operation and resource authority for CRM-only keys.
 * Spec: docs/architecture/features/crm-operations.md
 * [COMP:crm/integration-authority]
 */
import { z } from 'zod'
import { WorkflowAuthoritySourceSchema } from '../security/authority-source.js'

export const CRM_INTEGRATION_OPERATIONS = [
  'crm.records.read', 'crm.records.write', 'crm.catalog.read', 'crm.catalog.configure',
  'crm.submissions.read', 'crm.submissions.write', 'crm.consent.read', 'crm.consent.write',
  'crm.entitlements.read', 'crm.entitlements.write', 'crm.participation.read', 'crm.participation.write',
  'crm.imports.read', 'crm.imports.write', 'crm.audit.read', 'crm.privacy.export', 'crm.privacy.retention',
  'crm.delivery.read', 'crm.delivery.dispatch', 'association.read', 'association.orders.write',
  'association.provider_events.write',
] as const
export const CrmIntegrationOperationSchema = z.enum(CRM_INTEGRATION_OPERATIONS)
export type CrmIntegrationOperation = z.infer<typeof CrmIntegrationOperationSchema>

const Id = z.string().uuid()
export const CrmCredentialDepartmentSelectionSchema = z.object({
  departmentIds: z.array(Id).max(100).optional(),
  assistantId: Id.nullable().optional(),
  cap: z.enum(['public', 'internal', 'confidential']).default('internal'),
}).strict()
const Key = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/)
function selector<T extends z.ZodTypeAny>(item: T) {
  return z.union([z.literal('all'), z.array(item).min(1).max(200).refine((values) => new Set(values).size === values.length, 'Selectors must be unique')])
}
export const CrmIntegrationSelectorsSchema = z.object({
  definitionIds: selector(Id).optional(), purposeKeys: selector(Key).optional(),
  planIds: selector(Id).optional(), eventIds: selector(Id).optional(), providerKeys: selector(Key).optional(),
}).strict()
export type CrmIntegrationSelectors = z.infer<typeof CrmIntegrationSelectorsSchema>
export type CrmIntegrationSelector = keyof CrmIntegrationSelectors

const catalogs = ['definitionIds', 'purposeKeys', 'planIds', 'eventIds'] as const
export const CRM_INTEGRATION_RESOURCE_CATALOG = {
  'crm.records.read': [], 'crm.records.write': [],
  'crm.catalog.read': catalogs, 'crm.catalog.configure': catalogs,
  'crm.submissions.read': ['definitionIds'], 'crm.submissions.write': ['definitionIds'],
  'crm.consent.read': ['purposeKeys'], 'crm.consent.write': ['purposeKeys'],
  'crm.entitlements.read': ['planIds'], 'crm.entitlements.write': ['planIds'],
  'crm.participation.read': ['eventIds'], 'crm.participation.write': ['eventIds'],
  'crm.imports.read': [...catalogs, 'providerKeys'], 'crm.imports.write': [...catalogs, 'providerKeys'],
  'crm.audit.read': [], 'crm.privacy.export': [], 'crm.privacy.retention': [],
  'crm.delivery.read': ['purposeKeys', 'providerKeys'], 'crm.delivery.dispatch': ['purposeKeys', 'providerKeys'],
  'association.read': ['eventIds'], 'association.orders.write': ['eventIds'],
  'association.provider_events.write': ['eventIds', 'providerKeys'],
} as const satisfies Record<CrmIntegrationOperation, readonly CrmIntegrationSelector[]>

export const CrmIntegrationGrantSchema = z.object({
  operation: CrmIntegrationOperationSchema,
  selectors: CrmIntegrationSelectorsSchema.default({}),
}).strict().superRefine((grant, context) => {
  const allowed: readonly string[] = CRM_INTEGRATION_RESOURCE_CATALOG[grant.operation]
  for (const dimension of Object.keys(grant.selectors)) {
    if (!allowed.includes(dimension)) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['selectors', dimension], message: `Selector does not constrain ${grant.operation}. Valid selectors: ${allowed.join(', ') || '(none; workspace-wide operation)'}` })
  }
})
export type CrmIntegrationGrant = z.infer<typeof CrmIntegrationGrantSchema>
export const CrmIntegrationGrantsSchema = z.array(CrmIntegrationGrantSchema).min(1).max(CRM_INTEGRATION_OPERATIONS.length)
  .refine((grants) => new Set(grants.map((grant) => grant.operation)).size === grants.length, 'One grant per operation is required')

export const CrmIntegrationAuthoritySchema = z.object({
  credentialId: Id, grants: CrmIntegrationGrantsSchema,
}).strict()
export type CrmIntegrationAuthority = z.infer<typeof CrmIntegrationAuthoritySchema>

export class CrmIntegrationScopeError extends Error {
  readonly code = 'integration_scope_denied'
  constructor(readonly operation: string, readonly dimension?: CrmIntegrationSelector) {
    super(dimension ? `Integration grant does not permit this ${dimension} resource for ${operation}`
      : `Integration operation is not granted: ${operation}`)
    this.name = 'CrmIntegrationScopeError'
  }
}

/** Retained request authority can shrink, but a current grant cannot expand it. */
export function intersectCrmIntegrationAuthorities(left: CrmIntegrationAuthority, right: CrmIntegrationAuthority): CrmIntegrationAuthority {
  if (left.credentialId !== right.credentialId) throw new CrmIntegrationScopeError('credential_identity')
  const grants: CrmIntegrationGrant[] = []
  for (const original of left.grants) {
    const current = right.grants.find(grant => grant.operation === original.operation)
    if (!current) continue
    const selectors: CrmIntegrationSelectors = {}
    for (const dimension of CRM_INTEGRATION_RESOURCE_CATALOG[original.operation]) {
      const a = original.selectors[dimension] ?? [], b = current.selectors[dimension] ?? []
      const allowed = a === 'all' ? b : b === 'all' ? a : a.filter(value => b.includes(value))
      if (allowed === 'all') selectors[dimension] = 'all'
      else if (allowed.length) selectors[dimension] = [...new Set(allowed)].sort()
      // An omitted selector means none; [] is intentionally not serialized as
      // a grant selector because the persisted schema requires nonempty lists.
    }
    grants.push({ operation: original.operation, selectors })
  }
  if (!grants.length) throw new CrmIntegrationScopeError('credential_operations')
  return { credentialId: left.credentialId, grants: grants.sort((a, b) => a.operation.localeCompare(b.operation)) }
}

/** The existence of an operation grant never implies all its resources. */
export function requireCrmIntegrationOperation(authority: CrmIntegrationAuthority, operation: CrmIntegrationOperation): CrmIntegrationGrant {
  if (!CRM_INTEGRATION_OPERATIONS.includes(operation)) throw new CrmIntegrationScopeError(operation)
  const grant = authority.grants.find((item) => item.operation === operation)
  if (!grant) throw new CrmIntegrationScopeError(operation)
  return grant
}

/** Use the returned allowlist in SQL before limit/cursor, never filter a page after reading it. */
export function crmIntegrationResourceSelection(authority: CrmIntegrationAuthority, operation: CrmIntegrationOperation,
  dimension: CrmIntegrationSelector): 'all' | readonly string[] {
  const grant = requireCrmIntegrationOperation(authority, operation)
  const allowed: readonly string[] = CRM_INTEGRATION_RESOURCE_CATALOG[operation]
  if (!allowed.includes(dimension)) throw new CrmIntegrationScopeError(operation, dimension)
  return grant.selectors[dimension] ?? []
}

export function requireCrmIntegrationResources(authority: CrmIntegrationAuthority, operation: CrmIntegrationOperation,
  resources: Partial<Record<CrmIntegrationSelector, string | readonly string[] | null>>): void {
  requireCrmIntegrationOperation(authority, operation)
  for (const [key, value] of Object.entries(resources)) {
    const dimension = key as CrmIntegrationSelector
    const allowed = crmIntegrationResourceSelection(authority, operation, dimension)
    // null is an as-yet nonexistent catalog resource, which requires all.
    if (allowed === 'all') continue
    if (value === null) throw new CrmIntegrationScopeError(operation, dimension)
    const requested = typeof value === 'string' ? [value] : value
    if (!requested?.length || requested.some((item) => !allowed.includes(item))) throw new CrmIntegrationScopeError(operation, dimension)
  }
}

/** Host-owned exact OAuth parent evidence; never a model input. */
export const CrmOAuthCredentialParentSchema = z.object({
  version: z.literal(1), kind: z.literal('oauth_token'), credentialId: z.string().uuid(),
  workspaceId: z.string().uuid(), userId: z.string().uuid(), clientId: z.string().min(1),
  expiresAt: z.string().datetime(), tokenFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type CrmOAuthCredentialParent = z.infer<typeof CrmOAuthCredentialParentSchema>

/** Exact host-owned Brain-key parent evidence, including its original admission. */
export const CrmBrainCredentialParentSchema = z.object({
  version: z.literal(1), kind: z.literal('brain_key'), credentialId: z.string().uuid(),
  workspaceId: z.string().uuid(), userId: z.string().uuid(), tokenFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  maxClearance: z.enum(['public', 'internal', 'confidential']).nullable(),
  contextGroupId: z.string().uuid().nullable(), contextProjectId: z.string().uuid().nullable(),
  configurationSessionId: z.string().uuid().nullable(),
  admittedCompartments: z.array(z.string()).nullable(), admittedProjectIds: z.array(z.string().uuid()).nullable(),
}).strict()
export const CrmHomeAppCredentialParentSchema = z.object({
  version: z.literal(1), kind: z.literal('home_app'), credentialId: z.string().uuid(),
  workspaceId: z.string().uuid(), userId: z.string().uuid(), tokenFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  signerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(), maxClearance: z.enum(['public', 'internal', 'confidential']).nullable(),
  grantedScopes: z.object({ data: z.literal('read_write'), store: z.enum(['none', 'read', 'write']).optional(),
    agent: z.enum(['none', 'ask']).optional() }).strict(),
}).strict()
const workflowParentSchema = z.object({
  version: z.literal(1), kind: z.literal('workflow'), credentialId: z.string().uuid(),
  workspaceId: z.string().uuid(), userId: z.string().uuid(), source: WorkflowAuthoritySourceSchema,
}).strict()
export const CrmCredentialParentSchema = z.discriminatedUnion('kind', [CrmOAuthCredentialParentSchema, CrmBrainCredentialParentSchema, CrmHomeAppCredentialParentSchema, workflowParentSchema])
export type CrmCredentialParent = z.infer<typeof CrmCredentialParentSchema>
