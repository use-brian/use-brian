/**
 * Phase-1 contracts only: these packets are non-dispatchable, unapproved previews.
 * No approval, provisioning, browser isolation, network enforcement or evidence
 * collection exists here. Hashes bind supplied content, not its authenticity.
 * Shape validation cannot establish evidence integrity, independence, freshness,
 * provenance or whether an observation actually satisfies the scenario.
 *
 * Callers must supply only credential-free acceptance prose/environment facts.
 * Strict allowlists prevent extra context/credential fields, not secrets disguised
 * as ordinary prose or URL path segments. Never feed arbitrary parent context to
 * this builder. Authorized revision lookup and secret hygiene remain caller duties.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  acceptanceScenarioSchema,
  harnessDefinitionSchema,
  harnessScopeSchema,
  type HarnessRevision,
} from './contracts.js'

const id = z.string().uuid()
const label = z.string().trim().min(1).max(200)
const key = z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const revisionNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const statusSchema = z.enum(['passed', 'failed', 'blocked', 'inconclusive'])

// Full revision validation is deliberate: silently stripping unknown fields would
// hide context contamination. Only the selected scenario and identity leave here.
const revisionSchema = z.object({
  id,
  workspaceId: id,
  projectId: id,
  scope: harnessScopeSchema,
  revision: revisionNumber,
  definition: harnessDefinitionSchema,
  createdBy: id.nullable(),
  createdAt: z.string().datetime({ offset: true }),
}).strict() satisfies z.ZodType<HarnessRevision, z.ZodTypeDef, unknown>

function safeHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined
    // No parser-normalized alternate spellings, query/fragment delimiters, or wildcards.
    if (url.href !== value || value.includes('?') || value.includes('#') || url.hostname.includes('*')) return undefined
    return url
  } catch {
    return undefined
  }
}
const targetUrlSchema = z.string().max(2048).refine(value => !!safeHttpsUrl(value), {
  message: 'Use a canonical HTTPS URL without credentials, query or fragment',
})
const originSchema = z.string().max(2048).refine(value => {
  const url = safeHttpsUrl(`${value}/`)
  return !!url && url.origin === value
}, { message: 'Use an exact canonical HTTPS origin (no path, credentials or wildcard)' })
const targetSchema = z.object({
  url: targetUrlSchema,
  permittedOrigins: z.array(originSchema).min(1).max(20),
}).strict().superRefine((target, ctx) => {
  if (new Set(target.permittedOrigins).size !== target.permittedOrigins.length) {
    ctx.addIssue({ code: 'custom', path: ['permittedOrigins'], message: 'Duplicate origin' })
  }
  const url = safeHttpsUrl(target.url)
  if (url && !target.permittedOrigins.includes(url.origin)) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'Target origin is not permitted' })
  }
})
const buildSchema = z.object({ buildId: label, deploymentId: label }).strict()
// Deliberately not a free-form facts record, auth state, headers, cookies or tokens.
const environmentSchema = z.object({
  environmentId: label,
  locale: z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/),
  timezone: label,
  viewport: z.object({
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
  }).strict(),
}).strict()
const previewInputSchema = z.object({
  runId: id,
  revision: revisionSchema,
  scenarioKey: key,
  build: buildSchema,
  target: targetSchema,
  environment: environmentSchema,
}).strict()
const specificationSchema = z.object({
  workspaceId: id,
  projectId: id,
  scope: harnessScopeSchema,
  revisionId: id,
  revision: revisionNumber,
  definitionSha256: digest,
  scenarioSha256: digest,
}).strict()
const packetBodySchema = z.object({
  contractVersion: z.literal(1),
  kind: z.literal('non_dispatchable_acceptance_preview'),
  runId: id,
  specification: specificationSchema,
  build: buildSchema,
  target: targetSchema,
  environment: environmentSchema,
  scenario: acceptanceScenarioSchema,
}).strict()
const packetSchema = packetBodySchema.extend({ packetSha256: digest }).strict()

type DeepReadonly<T> = T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type VerificationPreviewInput = z.input<typeof previewInputSchema>
export type VerificationPreview = DeepReadonly<z.infer<typeof packetSchema>>

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)!
}
function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}
function reject(message: string): never {
  throw new z.ZodError([{ code: 'custom', path: [], message }])
}

/** Selects a scenario from a definition revision; never confers approval/authority. */
export function buildVerificationPreview(input: unknown): VerificationPreview {
  const parsed = previewInputSchema.parse(input)
  const { revision } = parsed
  const scenario = revision.definition.acceptanceScenarios.find(item => item.key === parsed.scenarioKey)
  if (!scenario) return reject('Scenario does not belong to the supplied definition revision')
  const body = packetBodySchema.parse({
    contractVersion: 1,
    kind: 'non_dispatchable_acceptance_preview',
    runId: parsed.runId,
    specification: {
      workspaceId: revision.workspaceId,
      projectId: revision.projectId,
      scope: revision.scope,
      revisionId: revision.id,
      revision: revision.revision,
      definitionSha256: sha256(revision.definition),
      scenarioSha256: sha256(scenario),
    },
    build: parsed.build,
    target: parsed.target,
    environment: parsed.environment,
    scenario,
  })
  // Zod clones all nested allowlisted fields; freezing never freezes caller objects.
  return freeze({ ...body, packetSha256: sha256(body) })
}

function parsePreview(input: unknown): z.infer<typeof packetSchema> {
  const packet = packetSchema.parse(input)
  const { packetSha256, ...body } = packet
  if (sha256(body) !== packetSha256 || sha256(packet.scenario) !== packet.specification.scenarioSha256) {
    return reject('Preview content does not match its binding hashes')
  }
  return packet
}
const bindingSchema = z.object({
  runId: id,
  packetSha256: digest,
  specification: specificationSchema,
  build: buildSchema,
  scenarioKey: key,
}).strict()
const criterionResultSchema = z.object({
  criterionKey: key,
  status: statusSchema,
  evidenceIds: z.array(label).max(100),
  reason: z.string().trim().min(1).max(4000).optional(),
}).strict()
const resultSchema = z.object({
  binding: bindingSchema,
  status: statusSchema,
  criteria: z.array(criterionResultSchema).min(1).max(50),
  evidence: z.array(z.object({
    id: label,
    criterionKey: key,
    kind: z.enum(['screenshot', 'recording', 'observation', 'artifact']),
    /** Opaque evidence-store reference, not fetched or trusted by this module. */
    reference: label,
  }).strict()).max(500),
}).strict()
export type VerificationResult = DeepReadonly<z.infer<typeof resultSchema>>

function bindingFor(packet: z.infer<typeof packetSchema>): z.infer<typeof bindingSchema> {
  return {
    runId: packet.runId,
    packetSha256: packet.packetSha256,
    specification: packet.specification,
    build: packet.build,
    scenarioKey: packet.scenario.key,
  }
}

/**
 * Checks structural completeness and binding only, NOT trusted acceptance.
 * In particular, a structurally valid `passed` report is not independently
 * verified evidence and must not authorize dispatch, approval or release.
 * Overall precedence is failed > blocked > inconclusive > passed.
 */
export function validateVerificationResult(preview: unknown, input: unknown): VerificationResult {
  const packet = parsePreview(preview)
  const result = resultSchema.parse(input)
  if (canonicalJson(result.binding) !== canonicalJson(bindingFor(packet))) {
    return reject('Result run/build/specification/packet binding mismatch')
  }
  const required = new Set(packet.scenario.criteria.map(item => item.key))
  const seen = new Set<string>()
  const evidence = new Map<string, z.infer<typeof resultSchema>['evidence'][number]>()
  for (const item of result.evidence) {
    if (evidence.has(item.id)) return reject('Duplicate evidence ID')
    if (!required.has(item.criterionKey)) return reject('Foreign evidence criterion')
    evidence.set(item.id, item)
  }
  const referenced = new Set<string>()
  for (const criterion of result.criteria) {
    if (!required.has(criterion.criterionKey)) return reject('Foreign result criterion')
    if (seen.has(criterion.criterionKey)) return reject('Duplicate result criterion')
    seen.add(criterion.criterionKey)
    const ownRefs = new Set<string>()
    for (const evidenceId of criterion.evidenceIds) {
      if (ownRefs.has(evidenceId)) return reject('Duplicate evidence reference')
      ownRefs.add(evidenceId)
      const item = evidence.get(evidenceId)
      if (!item || item.criterionKey !== criterion.criterionKey) return reject('Missing or foreign evidence ID')
      referenced.add(evidenceId)
    }
    if (criterion.status === 'passed' && ownRefs.size === 0) return reject('Passed criterion requires evidence')
    if (criterion.status !== 'passed' && !criterion.reason) return reject('Non-passed criterion requires a reason')
  }
  if (seen.size !== required.size) return reject('Incomplete criterion results')
  if (referenced.size !== evidence.size) return reject('Unreferenced evidence ID')
  const overall = (['failed', 'blocked', 'inconclusive', 'passed'] as const)
    .find(status => result.criteria.some(criterion => criterion.status === status))!
  if (result.status !== overall) return reject('Overall status does not match criterion results')
  return freeze(result)
}

/** No worker/browser fallback, dispatch hook or capability flags exist in phase 1. */
export function runAutomaticVerification(preview: unknown): VerificationResult {
  const packet = parsePreview(preview)
  return validateVerificationResult(packet, {
    binding: bindingFor(packet),
    status: 'blocked',
    criteria: packet.scenario.criteria.map(criterion => ({
      criterionKey: criterion.key,
      status: 'blocked',
      evidenceIds: [],
      reason: 'isolated_verifier_unavailable',
    })),
    evidence: [],
  })
}
