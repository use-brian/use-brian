/**
 * Research engine comparison (docs/architecture/features/research.md ->
 * "Improvement candidates and comparison").
 *
 * Offline: validates a case manifest and two trace files (baseline and
 * candidate) and produces a structured comparison. No provider, no network.
 * Deterministic hard failures are reported regardless of averaged scores, and
 * unknown/skipped/unavailable results are counted as unknown, never as zero
 * and never as a pass.
 *
 * [COMP:evals/research-comparison]
 */
import { z } from 'zod'

// ── Case manifest ─────────────────────────────────────────────────────────

const id = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)

export const researchCaseSchema = z.object({
  id,
  /** Revisions of one report share a family; a family lives in one split only. */
  family: id,
  split: z.enum(['target', 'heldout', 'regression']),
  request: z.string().trim().min(1).max(4000),
  context: z.object({
    projectBrief: z.string().max(4000).optional(),
    priorArtifacts: z.array(z.string().max(4000)).max(10).default([]),
  }).strict().default({ priorArtifacts: [] }),
  sources: z.array(z.object({
    id,
    kind: z.enum(['web', 'page', 'file', 'document', 'brain', 'connector', 'browser']),
    /** How a live run names this source (a fabricated example URL); matched by collection. */
    ref: z.string().max(2048).optional(),
    /** A source the run cannot actually read; reporting it as read is a hard failure. */
    available: z.boolean().default(true),
    content: z.string().max(20000).optional(),
  }).strict()).max(50).default([]),
  expected: z.object({
    claims: z.array(z.object({ id, text: z.string().min(1).max(1000), supportedBy: z.array(id).min(1) }).strict()).max(50).default([]),
    coverage: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    mustSaveArtifact: z.boolean().default(true),
    continuation: z.string().max(2000).optional(),
    feedbackKind: z.enum(['correction', 'request_correction', 'missing_coverage', 'preference', 'deeper_exploration', 'changed_objective', 'satisfaction', 'uncertain']).optional(),
  }).strict(),
  requirements: z.object({
    tools: z.array(z.string().max(100)).max(30).default([]),
    /** Needs live websites/accounts: never run by the deterministic build. */
    live: z.boolean().default(false),
    estimatedCostUsd: z.number().nonnegative().nullable().default(null),
  }).strict().default({ tools: [], live: false, estimatedCostUsd: null }),
}).strict()
export type ResearchCase = z.infer<typeof researchCaseSchema>

export const researchCaseManifestSchema = z.object({
  caseSetVersion: z.string().trim().min(1).max(100),
  datasetVersion: z.string().trim().min(1).max(100),
  cases: z.array(researchCaseSchema).min(1).max(500),
}).strict().superRefine((manifest, ctx) => {
  const ids = new Set<string>()
  const familySplit = new Map<string, string>()
  for (const c of manifest.cases) {
    if (ids.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate case id ${c.id}` })
    ids.add(c.id)
    const prior = familySplit.get(c.family)
    if (prior && prior !== c.split) {
      ctx.addIssue({ code: 'custom', message: `family ${c.family} spans splits ${prior} and ${c.split}` })
    }
    familySplit.set(c.family, c.split)
    const sourceIds = new Set(c.sources.map((s) => s.id))
    for (const claim of c.expected.claims) {
      for (const s of claim.supportedBy) if (!sourceIds.has(s)) ctx.addIssue({ code: 'custom', message: `case ${c.id} claim ${claim.id} cites unknown source ${s}` })
    }
  }
})
export type ResearchCaseManifest = z.infer<typeof researchCaseManifestSchema>

// ── Trace (one engine's results on a manifest) ────────────────────────────

const identitySchema = z.object({
  id: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(200),
}).strict()

export const researchTraceSchema = z.object({
  caseSetVersion: z.string().min(1).max(100),
  datasetVersion: z.string().min(1).max(100),
  engine: identitySchema.extend({ config: z.record(z.string(), z.unknown()).default({}) }),
  runtime: z.object({ model: z.string().min(1).max(200), tools: z.array(z.string().max(100)).max(200).default([]) }).strict(),
  /** `null` when no judge scored usefulness; usefulness is then unknown everywhere. */
  judge: identitySchema.nullable(),
  results: z.array(z.object({
    caseId: id,
    status: z.enum(['completed', 'skipped', 'unavailable', 'error']),
    claims: z.array(z.object({
      caseClaimId: id.nullable().default(null),
      sources: z.array(id).max(50).default([]),
      /** Judge/check verdict on the claim; null when unknown. */
      supported: z.boolean().nullable().default(null),
      contradicted: z.boolean().default(false),
    }).strict()).max(100).default([]),
    /** Sources the run reported as fully read. */
    readSources: z.array(id).max(100).default([]),
    /** Any cited source id not in the case fixtures counts as invented. */
    citedSources: z.array(z.string().max(2048)).max(200).default([]),
    coverage: z.array(z.string().max(200)).max(50).default([]),
    savedArtifact: z.object({ claimed: z.boolean(), verified: z.boolean() }).strict(),
    unauthorizedAccess: z.boolean().default(false),
    usefulness: z.number().min(0).max(4).nullable().default(null),
    humanCorrections: z.number().int().nonnegative().nullable().default(null),
    costUsd: z.number().nonnegative().nullable().default(null),
    latencyMs: z.number().int().nonnegative().nullable().default(null),
  }).strict()).max(500),
}).strict()
export type ResearchTrace = z.infer<typeof researchTraceSchema>

// ── Comparison ────────────────────────────────────────────────────────────

export type HardFailure = {
  caseId: string
  kind: 'invented_source' | 'unavailable_read_reported' | 'false_saved_success' | 'unauthorized_access' | 'missing_required_artifact'
}

export type SplitMetrics = {
  cases: number
  completed: number
  unknown: number
  claimSupport: number | null
  contradictions: number
  coverage: number | null
  usefulness: number | null
  savedSuccess: number | null
  humanCorrections: number | null
  costUsd: number | null
  latencyMs: number | null
}

export type ResearchComparisonResult = {
  identities: {
    caseSetVersion: string
    datasetVersion: string
    judge: string | null
    baseline: { engine: string; version: string; model: string }
    candidate: { engine: string; version: string; model: string }
  }
  splits: Record<'target' | 'heldout' | 'regression', { baseline: SplitMetrics; candidate: SplitMetrics }>
  hardFailures: { baseline: HardFailure[]; candidate: HardFailure[]; newInCandidate: HardFailure[] }
}

export class ResearchComparisonError extends Error {
  constructor(readonly reason: string) { super(reason) }
}

const mean = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
const sum = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) : null
const known = <T>(values: (T | null)[]): T[] => values.filter((v): v is T => v !== null)

function hardFailuresFor(manifest: ResearchCaseManifest, trace: ResearchTrace): HardFailure[] {
  const cases = new Map(manifest.cases.map((c) => [c.id, c]))
  const out: HardFailure[] = []
  for (const r of trace.results) {
    const c = cases.get(r.caseId)!
    const fixtureIds = new Set(c.sources.map((s) => s.id))
    const unavailable = new Set(c.sources.filter((s) => !s.available).map((s) => s.id))
    if (r.citedSources.some((s) => !fixtureIds.has(s)) || r.claims.some((cl) => cl.sources.some((s) => !fixtureIds.has(s)))) {
      out.push({ caseId: r.caseId, kind: 'invented_source' })
    }
    if (r.readSources.some((s) => unavailable.has(s))) out.push({ caseId: r.caseId, kind: 'unavailable_read_reported' })
    if (r.savedArtifact.claimed && !r.savedArtifact.verified) out.push({ caseId: r.caseId, kind: 'false_saved_success' })
    if (r.unauthorizedAccess) out.push({ caseId: r.caseId, kind: 'unauthorized_access' })
    if (r.status === 'completed' && c.expected.mustSaveArtifact && !r.savedArtifact.verified) out.push({ caseId: r.caseId, kind: 'missing_required_artifact' })
  }
  return out
}

function metrics(manifest: ResearchCaseManifest, trace: ResearchTrace, split: ResearchCase['split']): SplitMetrics {
  const cases = manifest.cases.filter((c) => c.split === split)
  const results = new Map(trace.results.map((r) => [r.caseId, r]))
  const completed = cases.map((c) => ({ c, r: results.get(c.id) })).filter((x) => x.r?.status === 'completed') as { c: ResearchCase; r: ResearchTrace['results'][number] }[]
  const support: number[] = []
  const coverage: number[] = []
  let contradictions = 0
  for (const { c, r } of completed) {
    const verdicts = known(r.claims.map((cl) => cl.supported))
    if (verdicts.length) support.push(verdicts.filter(Boolean).length / verdicts.length)
    contradictions += r.claims.filter((cl) => cl.contradicted).length
    if (c.expected.coverage.length) {
      const got = new Set(r.coverage.map((x) => x.toLowerCase()))
      coverage.push(c.expected.coverage.filter((x) => got.has(x.toLowerCase())).length / c.expected.coverage.length)
    }
  }
  return {
    cases: cases.length,
    completed: completed.length,
    unknown: cases.length - completed.length,
    claimSupport: mean(support),
    contradictions,
    coverage: mean(coverage),
    usefulness: trace.judge ? mean(known(completed.map(({ r }) => r.usefulness))) : null,
    savedSuccess: mean(completed.filter(({ c }) => c.expected.mustSaveArtifact).map(({ r }) => (r.savedArtifact.verified ? 1 : 0))),
    humanCorrections: sum(known(completed.map(({ r }) => r.humanCorrections))),
    costUsd: sum(known(completed.map(({ r }) => r.costUsd))),
    latencyMs: mean(known(completed.map(({ r }) => r.latencyMs))),
  }
}

/**
 * Compare two traces on one manifest. Refuses mismatched case-set, dataset or
 * judge identities and results for cases the manifest does not define.
 */
export function compareResearchTraces(manifestInput: unknown, baselineInput: unknown, candidateInput: unknown): ResearchComparisonResult {
  const manifest = researchCaseManifestSchema.parse(manifestInput)
  const baseline = researchTraceSchema.parse(baselineInput)
  const candidate = researchTraceSchema.parse(candidateInput)
  for (const [name, t] of [['baseline', baseline], ['candidate', candidate]] as const) {
    if (t.caseSetVersion !== manifest.caseSetVersion) throw new ResearchComparisonError(`${name} case set ${t.caseSetVersion} does not match manifest ${manifest.caseSetVersion}`)
    if (t.datasetVersion !== manifest.datasetVersion) throw new ResearchComparisonError(`${name} dataset ${t.datasetVersion} does not match manifest ${manifest.datasetVersion}`)
    const ids = new Set(manifest.cases.map((c) => c.id))
    const unknownCase = t.results.find((r) => !ids.has(r.caseId))
    if (unknownCase) throw new ResearchComparisonError(`${name} has a result for unknown case ${unknownCase.caseId}`)
  }
  const judgeKey = (t: ResearchTrace) => (t.judge ? `${t.judge.id}@${t.judge.version}` : null)
  if (judgeKey(baseline) !== judgeKey(candidate)) throw new ResearchComparisonError('baseline and candidate were scored by different judges')
  if (baseline.engine.id === candidate.engine.id && baseline.engine.version === candidate.engine.version) {
    throw new ResearchComparisonError('baseline and candidate are the same engine version')
  }
  const baseFailures = hardFailuresFor(manifest, baseline)
  const candFailures = hardFailuresFor(manifest, candidate)
  const seen = new Set(baseFailures.map((f) => `${f.caseId}\u0000${f.kind}`))
  const splits = Object.fromEntries((['target', 'heldout', 'regression'] as const).map((split) =>
    [split, { baseline: metrics(manifest, baseline, split), candidate: metrics(manifest, candidate, split) }])) as ResearchComparisonResult['splits']
  return {
    identities: {
      caseSetVersion: manifest.caseSetVersion,
      datasetVersion: manifest.datasetVersion,
      judge: judgeKey(candidate),
      baseline: { engine: baseline.engine.id, version: baseline.engine.version, model: baseline.runtime.model },
      candidate: { engine: candidate.engine.id, version: candidate.engine.version, model: candidate.runtime.model },
    },
    splits,
    hardFailures: { baseline: baseFailures, candidate: candFailures, newInCandidate: candFailures.filter((f) => !seen.has(`${f.caseId}\u0000${f.kind}`)) },
  }
}

// ── Dry run and collection ────────────────────────────────────────────────

export type ResearchDryRun = {
  caseSetVersion: string
  datasetVersion: string
  cases: Array<{ id: string; split: string; tools: string[]; live: boolean }>
  requiresLive: number
  /** Known only when every selected case declares an estimate; never a fabricated price. */
  estimatedCostUsd: number | null
  costKnown: boolean
}

export function dryRunResearchCases(manifestInput: unknown, filter: { split?: ResearchCase['split'] } = {}): ResearchDryRun {
  const manifest = researchCaseManifestSchema.parse(manifestInput)
  const cases = manifest.cases.filter((c) => !filter.split || c.split === filter.split)
  const estimates = cases.map((c) => c.requirements.estimatedCostUsd)
  const costKnown = estimates.every((e) => e !== null)
  return {
    caseSetVersion: manifest.caseSetVersion,
    datasetVersion: manifest.datasetVersion,
    cases: cases.map((c) => ({ id: c.id, split: c.split, tools: c.requirements.tools, live: c.requirements.live })),
    requiresLive: cases.filter((c) => c.requirements.live).length,
    estimatedCostUsd: costKnown ? estimates.reduce<number>((a, b) => a + (b ?? 0), 0) : null,
    costKnown,
  }
}

/** One configured-provider research run over one case, through the real research services. */
export type ResearchCollectionAdapter = {
  identity: { engine: { id: string; version: string; config: Record<string, unknown> }; runtime: { model: string; tools: string[] } }
  runCase(c: ResearchCase): Promise<ResearchTrace['results'][number]>
}

export class ResearchCollectionRefused extends Error {
  constructor(readonly reason: 'preflight_required' | 'confirmation_required' | 'live_not_allowed') { super(reason) }
}

/**
 * Collect a trace with a configured provider. Expensive by nature, so it
 * requires the cheap preflight (the dry run) and an explicit confirmation of
 * that exact preflight before any case runs.
 */
export async function collectResearchTrace(params: {
  manifest: unknown
  adapter: ResearchCollectionAdapter
  preflight: ResearchDryRun | null
  confirmed: boolean
  allowLive?: boolean
  onCase?: (caseId: string, result: ResearchTrace['results'][number]) => void
}): Promise<ResearchTrace> {
  const manifest = researchCaseManifestSchema.parse(params.manifest)
  if (!params.preflight || params.preflight.caseSetVersion !== manifest.caseSetVersion) throw new ResearchCollectionRefused('preflight_required')
  if (!params.confirmed) throw new ResearchCollectionRefused('confirmation_required')
  const selected = manifest.cases.filter((c) => params.preflight!.cases.some((p) => p.id === c.id))
  if (selected.some((c) => c.requirements.live) && !params.allowLive) throw new ResearchCollectionRefused('live_not_allowed')
  const results: ResearchTrace['results'] = []
  for (const c of selected) {
    const result = await params.adapter.runCase(c)
    results.push(result)
    params.onCase?.(c.id, result)
  }
  return researchTraceSchema.parse({
    caseSetVersion: manifest.caseSetVersion,
    datasetVersion: manifest.datasetVersion,
    engine: params.adapter.identity.engine,
    runtime: params.adapter.identity.runtime,
    judge: null,
    results,
  })
}

// ── Comparison bundles (what a command accepts) ───────────────────────────

/**
 * A locally verifiable bundle carries the manifest and both traces; it is
 * recomputed here and recorded as `local_verified`. A reported bundle carries
 * someone else's result and is recorded as `externally_reported`, never
 * shown as a locally checked comparison - an opaque `passed: true` cannot
 * impersonate one.
 */
export const researchComparisonBundleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('traces'), manifest: z.unknown(), baseline: z.unknown(), candidate: z.unknown() }).strict(),
  z.object({
    kind: z.literal('reported'),
    caseSetVersion: z.string().min(1).max(100),
    datasetVersion: z.string().min(1).max(100),
    judge: z.string().min(1).max(200),
    baseline: z.record(z.string(), z.unknown()),
    candidate: z.record(z.string(), z.unknown()),
    summary: z.record(z.string(), z.unknown()),
  }).strict(),
])
export type ResearchComparisonBundle = z.infer<typeof researchComparisonBundleSchema>

// ── Publishable eval-case preparation ─────────────────────────────────────

const EMAIL_RE = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi
const URL_HOST_RE = /https?:\/\/([^/\s"'<>)]+)/gi
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
const reservedHost = (host: string) => /(^|\.)example(\.(com|org|net))?$/i.test(host.replace(/:\d+$/, '')) || /\.(example|test|invalid)$/i.test(host)

/**
 * A case that leaves the workspace (a committed fixture, a published test)
 * must use fabricated identities and data. Simple redaction is not assumed to
 * deidentify a scenario, so this refuses rather than rewrites: any address,
 * link or phone outside the reserved fictional ranges, or any production-style
 * id, rejects the case and names the field.
 */
export function publishableCaseProblems(input: unknown): string[] {
  const parsed = researchCaseSchema.safeParse(input)
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  const problems: string[] = []
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(EMAIL_RE)) if (!reservedHost(m[1]!)) problems.push(`${path}: real-looking email domain ${m[1]}`)
      for (const m of value.matchAll(URL_HOST_RE)) if (!reservedHost(m[1]!)) problems.push(`${path}: real-looking link host ${m[1]}`)
      for (const m of value.match(PHONE_RE) ?? []) if (!/555/.test(m)) problems.push(`${path}: phone number outside the fictional 555 range`)
      if (UUID_RE.test(value)) problems.push(`${path}: production-style id`)
    } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`))
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k)
  }
  walk(parsed.data, '')
  return problems
}
