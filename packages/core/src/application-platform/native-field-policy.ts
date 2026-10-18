/** Schema-bound module field masks over current host facts. [COMP:security/native-field-policy] */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { ApplicationPlatformError, applicationOriginSchema, applicationResourceRefSchema,
  type ApplicationResourceDefinition, type ApplicationResourceRef } from '@use-brian/shared'
import { validateApplicationResourceCatalog } from './contracts.js'

const key = z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/)
const fieldKey = z.string().min(1).max(128).refine(value => !['__proto__','prototype','constructor'].includes(value))
const version = z.string().min(1).max(128)
const rule = z.array(z.array(key).max(64)).max(8)
const releaseProfile = z.enum(['external_user','service'])
const policySchema = z.object({ moduleKey: key,version,roles: z.array(key).max(64),resources: z.array(z.object({
  origin: applicationOriginSchema,typeKey: key,schemaVersion: version,
  fields: z.array(z.object({ key: fieldKey,read: rule,write: rule,
    releaseReadTo: z.array(releaseProfile).max(2).default([]),releaseWriteTo: z.array(releaseProfile).max(2).default([]) }).strict()).max(128),
}).strict()).max(128) }).strict()
export type NativeApplicationFieldPolicyDefinition = z.infer<typeof policySchema>

const nativePolicyBrand: unique symbol = Symbol('native-field-policy-definition')
/** This handle proves catalog validation only; it is never caller or row authority. */
export interface NativeApplicationFieldPolicy {
  readonly moduleKey: string
  readonly version: string
  readonly [nativePolicyBrand]: true
}
const policies = new WeakMap<NativeApplicationFieldPolicy, {
  definition: NativeApplicationFieldPolicyDefinition
  catalog: ApplicationResourceDefinition[]
}>()

function invalid(): never { throw new ApplicationPlatformError('invalid_schema','The native field policy is invalid.') }
function resourceKey(ref: Pick<ApplicationResourceRef,'origin'|'typeKey'>): string | null {
  return ref.origin.kind === 'generic' ? JSON.stringify(['generic',ref.origin.entityTypeId])
    : ref.origin.kind === 'native' ? JSON.stringify(['native',ref.origin.moduleKey,ref.typeKey]) : null
}
const unique = (values: readonly string[]) => new Set(values).size === values.length

/** Deployed canonical catalog only. App-projected catalogs are not a policy definition. */
export function defineNativeApplicationFieldPolicy(raw: unknown, catalog: readonly ApplicationResourceDefinition[]): NativeApplicationFieldPolicy {
  const parsed = policySchema.safeParse(raw)
  if (!parsed.success) invalid()
  const policy = parsed.data, declarations = validateApplicationResourceCatalog(policy.moduleKey,catalog)
  if (!unique(policy.roles) || declarations.some(resource => resource.origin.kind === 'external')
    || declarations.length !== policy.resources.length) invalid()
  const byResource = new Map(declarations.map(resource => [resourceKey(resource),resource]))
  if (byResource.size !== declarations.length) invalid()
  const seen = new Set<string>()
  for (const resource of policy.resources) {
    const id = resourceKey(resource), canonical = id ? byResource.get(id) : undefined
    if (!id || seen.has(id) || !canonical || canonical.schemaVersion !== resource.schemaVersion
      || resource.origin.kind === 'native' && resource.origin.moduleKey !== policy.moduleKey
      || resource.origin.kind === 'generic' && resource.typeKey !== `record.${resource.origin.entityTypeId}`
      || resource.fields.length !== canonical.fields.length || !unique(resource.fields.map(field => field.key))) invalid()
    seen.add(id)
    const fields = new Set(canonical.fields.map(field => field.key))
    for (const field of resource.fields) {
      if (!fields.has(field.key) || !unique(field.releaseReadTo) || !unique(field.releaseWriteTo)) invalid()
      for (const constraints of [field.read,field.write]) {
        for (const alternatives of constraints) if (!unique(alternatives) || alternatives.some(role => !policy.roles.includes(role))) invalid()
        if (!unique(constraints.map(alternatives => JSON.stringify([...alternatives].sort())))) invalid()
      }
    }
  }
  // Zod has detached all nested input. Descriptor reads return another snapshot.
  const handle: NativeApplicationFieldPolicy = Object.freeze({ moduleKey: policy.moduleKey,version: policy.version,[nativePolicyBrand]: true as const })
  policies.set(handle,{ definition: policy,catalog: declarations })
  return handle
}

export function nativeApplicationFieldPolicyDescriptor(handle: NativeApplicationFieldPolicy): NativeApplicationFieldPolicyDefinition {
  const policy = policies.get(handle)?.definition
  if (!policy) invalid()
  return structuredClone(policy)
}

/** Runtime configuration can add restrictions; it cannot remove deployed floors. */
export function restrictNativeApplicationFieldPolicy(base: NativeApplicationFieldPolicy, rawRestriction: unknown): NativeApplicationFieldPolicy {
  const registered = policies.get(base)
  if (!registered) invalid()
  const restriction = policies.get(defineNativeApplicationFieldPolicy(rawRestriction,registered.catalog))!.definition
  const original = registered.definition
  if (restriction.moduleKey !== original.moduleKey) invalid()
  const constraints = (left: string[][], right: string[][]) => [...new Map([...left,...right]
    .map(roles => [...roles].sort()).map(roles => [JSON.stringify(roles),roles])).values()]
  const resources = original.resources.map(resource => {
    const narrowed = restriction.resources.find(candidate => resourceKey(candidate) === resourceKey(resource))!
    return { ...resource,fields: resource.fields.map(field => {
      const rule = narrowed.fields.find(candidate => candidate.key === field.key)!
      return { ...field,read: constraints(field.read,rule.read),write: constraints(field.write,rule.write),
        releaseReadTo: field.releaseReadTo.filter(profile => rule.releaseReadTo.includes(profile)),
        releaseWriteTo: field.releaseWriteTo.filter(profile => rule.releaseWriteTo.includes(profile)) }
    }) }
  })
  const version = createHash('sha256').update(JSON.stringify({ base: original,restriction })).digest('hex')
  return defineNativeApplicationFieldPolicy({ moduleKey: original.moduleKey,version,
    roles: [...new Set([...original.roles,...restriction.roles])].sort(),resources },registered.catalog)
}

const fields = z.array(fieldKey).max(128)
const factsSchema = z.object({ workspaceId: z.string().uuid(),moduleKey: key,userId: z.string().uuid(),
  resource: applicationResourceRefSchema,schemaVersion: version,policyVersion: version,
  profile: z.enum(['native_member','application_member','external_user','service']),
  roles: z.array(z.object({ workspaceId: z.string().uuid(),moduleKey: key,userId: z.string().uuid(),roleKey: key,
    startsAt: z.string().datetime({ offset: true }),expiresAt: z.string().datetime({ offset: true }).nullable() }).strict()).max(128),
  base: z.object({ allowed: z.boolean(),readFields: fields,writeFields: fields }).strict(),
  issuer: z.object({ workspaceId: z.string().uuid(),moduleKey: key,userId: z.string().uuid(),allowed: z.boolean(),
    resource: applicationResourceRefSchema,schemaVersion: version,policyVersion: version,
    readFields: fields,writeFields: fields,releaseReadFields: fields,releaseWriteFields: fields }).strict().optional(),
}).strict()
/** Host-resolved current facts, not a serializable grant or proof. */
export type NativeApplicationFieldFacts = z.infer<typeof factsSchema>
export interface NativeApplicationFieldDecision {
  allowed: boolean
  readFields: string[]
  writeFields: string[]
  policyVersion: string | null
}

/**
 * Pure projection only. The canonical host/SQL service must separately establish
 * current identity, record/app/issuer/source admission and the authority lease.
 */
export function decideNativeApplicationFields(handle: NativeApplicationFieldPolicy, requested: ApplicationResourceRef,
  rawFacts: NativeApplicationFieldFacts, now = Date.now()): NativeApplicationFieldDecision {
  const deny = (): NativeApplicationFieldDecision => ({ allowed: false,readFields: [],writeFields: [],policyVersion: null })
  const policy = policies.get(handle)?.definition, ref = applicationResourceRefSchema.safeParse(requested), parsed = factsSchema.safeParse(rawFacts)
  if (!policy || !ref.success || !parsed.success || !Number.isFinite(now)) return deny()
  const facts = parsed.data,id = resourceKey(ref.data), resource = policy.resources.find(resource => resourceKey(resource) === id)
  if (!id || !resource || !facts.base.allowed || facts.workspaceId !== ref.data.workspaceId || facts.moduleKey !== policy.moduleKey
    || facts.resource.workspaceId !== ref.data.workspaceId || facts.resource.id !== ref.data.id || facts.resource.version !== ref.data.version
    || resourceKey(facts.resource) !== id || facts.schemaVersion !== resource.schemaVersion || facts.policyVersion !== policy.version) return deny()
  const fieldNames = new Set(resource.fields.map(field => field.key))
  if ([...facts.base.readFields,...facts.base.writeFields].some(field => !fieldNames.has(field))) return deny()
  const application = facts.profile !== 'native_member', member = facts.profile === 'native_member' || facts.profile === 'application_member'
  const issuer = facts.issuer
  if (application && (!issuer?.allowed || issuer.workspaceId !== facts.workspaceId || issuer.moduleKey !== facts.moduleKey
    || issuer.resource.workspaceId !== ref.data.workspaceId || issuer.resource.id !== ref.data.id || issuer.resource.version !== ref.data.version
    || resourceKey(issuer.resource) !== id || issuer.schemaVersion !== resource.schemaVersion || issuer.policyVersion !== policy.version)) return deny()
  if (application && [...issuer!.readFields,...issuer!.writeFields,...issuer!.releaseReadFields,...issuer!.releaseWriteFields]
    .some(field => !fieldNames.has(field))) return deny()
  const roles = new Set(facts.roles.filter(role => member && role.workspaceId === facts.workspaceId && role.moduleKey === facts.moduleKey
    && role.userId === facts.userId && policy.roles.includes(role.roleKey) && Date.parse(role.startsAt) <= now
    && (role.expiresAt === null || Date.parse(role.expiresAt) > now)).map(role => role.roleKey))
  const roleAllows = (constraints: string[][]) => constraints.every(alternatives => alternatives.some(role => roles.has(role)))
  const read: string[] = [],write: string[] = []
  const release = facts.profile === 'external_user' || facts.profile === 'service' ? facts.profile : null
  for (const field of resource.fields) {
    const readRule = member ? roleAllows(field.read) : release !== null && field.releaseReadTo.includes(release)
    const writeRule = member ? roleAllows(field.write) : release !== null && field.releaseWriteTo.includes(release)
    if (readRule && facts.base.readFields.includes(field.key)
      && (!application || issuer!.readFields.includes(field.key) && issuer!.releaseReadFields.includes(field.key))) read.push(field.key)
    if (writeRule && facts.base.writeFields.includes(field.key)
      && (!application || issuer!.writeFields.includes(field.key) && issuer!.releaseWriteFields.includes(field.key))) write.push(field.key)
  }
  return { allowed: true,readFields: read.sort(),writeFields: write.sort(),policyVersion: policy.version }
}
