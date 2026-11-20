#!/usr/bin/env node
/**
 * M6 results collector. Plan: brian-platform docs/plans/oss-chat-m6-qualification-plan.md.
 *
 * Reads a run directory written by run-matrix.mjs (run.json, steps/*.json and
 * the raw harness outputs), the transcribed baseline (baseline.json, which
 * includes the 2026-11-16 one-turn numbers) and the machine-readable receipts
 * it cites, and writes one results table with before / baseline / after /
 * budget / verdict columns, as Markdown and JSON.
 *
 *   node scripts/testing/m6/collect.mjs --run /abs/run-dir [--md out.md] [--json out.json]
 *   node scripts/testing/m6/collect.mjs --verify-baseline
 *
 * It aggregates (median, nearest-rank quantiles, max) and compares; it does
 * not measure. Verdicts: pass, fail, recorded (including a comparison with an
 * indicative target), insufficient-samples, unmeasured (required evidence absent).
 * A run is qualifying only when it is not a plumbing run, used the full profile
 * on a clean source that did not change, and meets all binding requirements.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUDGETS, FIXED20_SCENARIOS, METRICS, ROWS, SCENARIO_BUDGETS } from './matrix.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OSS = resolve(HERE, '../../..')
const PLATFORM = resolve(OSS, '..')

// ── Small statistics (aggregation only) ──────────────────────────────────

const nums = (xs) => xs.filter(x => typeof x === 'number' && Number.isFinite(x))
const median = (xs) => { const s = nums(xs).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const quantile = (xs, q) => { const s = nums(xs).sort((a, b) => a - b); if (!s.length) return null; return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] }
const max = (xs) => { const s = nums(xs); return s.length ? Math.max(...s) : null }
const min = (xs) => { const s = nums(xs); return s.length ? Math.min(...s) : null }
const round = (x) => (typeof x === 'number' ? (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10) : x)
const fmt = (x) => (x === null || x === undefined ? '' : typeof x === 'number' ? round(x).toLocaleString('en-US') : String(x))

function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
function platformPath(rel) { return join(PLATFORM, rel) }

// ── Baseline ─────────────────────────────────────────────────────────────

function collectQuotes(node, inherited, out) {
  if (!node || typeof node !== 'object') return
  const source = node.source ?? inherited
  for (const [key, value] of Object.entries(node)) {
    if ((key === 'quote' || key === 'quoteHosted') && typeof value === 'string') out.push({ source, quote: value })
    else if (key === 'wall' && node.wallSource) collectQuotes(value, node.wallSource, out)
    else if (key === 'runtime' && node.runtimeSource) collectQuotes(value, node.runtimeSource, out)
    else if (key === 'boot' && node.bootSource) collectQuotes(value, node.bootSource, out)
    else if (value && typeof value === 'object') collectQuotes(value, value.source ?? source, out)
  }
}

export function verifyBaseline(baseline) {
  const quotes = []
  collectQuotes(baseline, undefined, quotes)
  const files = new Map()
  const failures = []
  for (const { source, quote } of quotes) {
    if (!source) { failures.push({ source, quote, problem: 'no source' }); continue }
    if (!files.has(source)) files.set(source, existsSync(platformPath(source)) ? readFileSync(platformPath(source), 'utf8') : null)
    const text = files.get(source)
    if (text === null) failures.push({ source, quote, problem: 'source missing' })
    else if (!text.includes(quote)) failures.push({ source, quote, problem: 'quote not found' })
  }
  for (const rel of [baseline.admission?.sourceJson, baseline.imports?.staticJson].filter(Boolean)) {
    if (!existsSync(platformPath(rel))) failures.push({ source: rel, problem: 'machine receipt missing' })
  }
  return { checked: quotes.length, failures }
}

// ── Row builders ─────────────────────────────────────────────────────────

const line = (row, cell, metric, values) => ({ row: row.id, title: row.title, cell, metric, unit: METRICS[metric]?.unit ?? values.unit ?? '', ...values })

// Per-scenario budgets (decided 2026-11-17): permission work is counted as nested
// statements, which are not complete physical units, so a pass stays provisional.
function scenarioBudget(workload, scenario, key) { return SCENARIO_BUDGETS[workload]?.[scenario]?.[key] ?? null }
function permissionLine(row, cell, workload, scenario, nested, extra) {
  const limit = scenarioBudget(workload, scenario, 'permissionWork')
  return line(row, cell, 'permissionWork', { after: nested, budget: limit === null ? 'no per-scenario budget' : `<=${fmt(limit)} (${BUDGETS.permissionWork.text})`,
    verdict: nested === null ? 'unmeasured' : limit === null ? 'recorded' : nested <= limit ? 'pass (provisional: nested statements are not complete physical units)' : 'fail',
    note: nested === null ? 'nested statistics absent (fixture without pg_stat_statements)' : undefined, ...extra })
}
function latencyLine(row, cell, workload, scenario, rs, extra) {
  const limit = scenarioBudget(workload, scenario, 'latencyP50'), p50 = quantile(rs.map(r => r.elapsedMs), 0.5)
  return line(row, cell, 'wallMs', { metricVariant: 'p50 (M6 latency metric)', after: p50, budget: limit === null ? 'no per-scenario budget' : `<=${fmt(limit)} ms (${BUDGETS.latencyP50.text})`,
    verdict: rs.length < BUDGETS.latencyP50.minSamples ? 'insufficient-samples' : limit === null ? 'recorded' : p50 <= limit ? 'pass' : 'fail', ...extra })
}

function budgetVerdict(key, value) {
  const b = BUDGETS[key]
  if (value === null || value === undefined) return 'unmeasured'
  if (b.op === '<=') return value <= b.limit ? 'pass' : 'fail'
  if (b.op === '==') return value === b.limit ? 'pass' : 'fail'
  return 'recorded'
}

function foregroundTarget(key, counts) {
  const { limit, text } = BUDGETS[key]
  const measured = counts.filter(value => Number.isInteger(value) && value >= 0)
  const after = max(measured)
  const comparison = { after, budget: text, target: limit }
  if (counts.length === 0 || measured.length !== counts.length) {
    return { ...comparison, verdict: 'unmeasured', note: `foreground counts recorded for ${measured.length} of ${counts.length} samples` }
  }
  return { ...comparison, verdict: 'recorded', overTargetBy: Math.max(0, after - limit) }
}

function fixed20Groups(harness, { phase } = {}) {
  const groups = new Map()
  for (const r of harness?.results ?? []) {
    if (r.verified !== true) continue
    // The cold step pairs a cold sample 0 with a warm sample 1 per restart.
    if (phase ? r.coldPhase !== phase : r.warmup) continue
    const key = `${r.scenario}/${r.permissionModel}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  return groups
}

const sharedReads = (r) => r.nestedSql ? (r.nestedSql.topLevel?.sharedReads ?? 0) + (r.nestedSql.nested?.sharedReads ?? 0) : null

/** Row A7: cold and paired warm columns per scenario from the cold step. */
function coldLines(row, ctx) {
  const stepId = 'fixed20-oss-cold'
  const s = ctx.steps[stepId]
  const cold = fixed20Groups(s?.harness, { phase: 'cold' }), warm = fixed20Groups(s?.harness, { phase: 'warm' })
  const out = []
  for (const cell of FIXED20_SCENARIOS) {
    const rc = cold.get(cell) ?? [], rw = warm.get(cell) ?? []
    if (!rc.length) { out.push(line(row, cell, 'foreground', { metricVariant: 'cold', verdict: 'unmeasured', note: stepNote(s, cell), source: stepId })); continue }
    const src = `${stepId} (${rc.length} cold / ${rw.length} warm samples, one restart each)`
    for (const [phase, rs] of [['cold', rc], ['warm', rw]]) {
      out.push(line(row, cell, 'foreground', {
        metricVariant: `${phase}, max`, ...foregroundTarget('foreground', rs.map(r => r.queries)),
        baseline: ctx.baseline.fixed20?.scenarios?.[cell]?.foreground, source: src,
      }))
    }
    for (const [phase, rs] of [['cold', rc], ['warm', rw]]) {
      if (!rs.length) continue
      out.push(line(row, cell, 'sharedReads', { metricVariant: `${phase}, median`, after: median(rs.map(sharedReads)), afterDetail: `nested ${fmt(median(rs.map(r => r.nestedSql?.nested?.calls ?? null)))}`, verdict: 'recorded', note: phase === 'cold' ? 'evidence that the restart emptied shared buffers; the OS page cache stays warm' : undefined, source: src }))
      out.push(line(row, cell, 'preparationMs', { metricVariant: `${phase}, median / max`, after: `${fmt(median(rs.map(r => r.turnTimings?.loop_started_at_ms ?? null)))} / ${fmt(max(rs.map(r => r.turnTimings?.loop_started_at_ms ?? null)))}`, budget: phase === 'cold' ? 'reported separately (section 7); the p95 budget applies to the warm distribution (A3)' : undefined, verdict: 'recorded', source: src }))
      out.push(line(row, cell, 'finalizationMs', { metricVariant: `${phase}, median / max`, after: `${fmt(median(rs.map(finalization)))} / ${fmt(max(rs.map(finalization)))}`, verdict: 'recorded', source: src }))
      out.push(line(row, cell, 'admissionMs', { metricVariant: `${phase}, median`, after: median(rs.map(r => r.turnTimings?.admission_ms ?? null)), verdict: 'recorded', source: src }))
      out.push(line(row, cell, 'wallMs', { metricVariant: `${phase}, median`, after: median(rs.map(r => r.elapsedMs)), verdict: 'recorded', source: src }))
    }
  }
  return out
}

/** Row A8: the one-lookup workload compared with its 100-statement indicative target. */
function lookupLines(row, ctx) {
  const stepId = 'fixed20-oss-lookup'
  const s = ctx.steps[stepId]
  const groups = fixed20Groups(s?.harness), noTool = fixed20Groups(ctx.steps['fixed20-oss-counts']?.harness)
  const out = []
  for (const cell of FIXED20_SCENARIOS) {
    const rs = (groups.get(cell) ?? []).filter(r => r.workload === 'one-lookup')
    if (!rs.length) { out.push(line(row, cell, 'foreground', { verdict: 'unmeasured', note: stepNote(s, cell), source: stepId })); continue }
    const src = `${stepId} (${rs.length} sample${rs.length === 1 ? '' : 's'})`
    const fg = rs.map(r => r.queries), nested = max(rs.map(r => r.nestedSql?.nested?.calls ?? null))
    const base = median((noTool.get(cell) ?? []).map(r => r.queries))
    out.push(line(row, cell, 'foreground', { ...foregroundTarget('oneLookup', fg), afterDetail: `median ${fmt(median(fg))}${base !== null ? `; no-tool median ${fmt(base)} in this run` : ''}`, source: src }))
    out.push(permissionLine(row, cell, 'oneLookup', cell, nested, { source: src }))
    out.push(latencyLine(row, cell, 'oneLookup', cell, rs, { source: src }))
    const ok = rs.every(r => r.lookup?.calls === 1 && r.lookup?.providerRounds === 2)
    out.push(line(row, cell, 'lookupCalls', { after: min(rs.map(r => r.lookup?.calls ?? null)), afterDetail: `${rs[0].lookup?.call?.name} to ${rs[0].lookup?.call?.server}/${rs[0].lookup?.call?.tool}; provider rounds ${fmt(rs[0].lookup?.providerRounds)}`, budget: 'exactly one lookup, its fixed result received by the provider (harness assertions)', verdict: ok ? 'pass' : 'fail', source: src }))
    out.push(line(row, cell, 'lookupStatements', { after: median(rs.map(r => r.lookup?.statements ?? null)), afterDetail: `connector network: ${rs[0].lookup?.connectorNetwork}; deferred jobs: ${rs[0].lookup?.deferredJobs}`, verdict: 'recorded', note: 'section 7 reports connector network and deferred jobs separately; this lookup has neither', source: src }))
    out.push(line(row, cell, 'outputFrames', { after: min(rs.map(r => r.outputEvents)), budget: BUDGETS.outputFrames.text, verdict: rs.every(r => r.outputEvents === 20) ? 'pass' : 'fail', source: src }))
    out.push(line(row, cell, 'wallMs', { after: median(rs.map(r => r.elapsedMs)), afterDetail: `admission ${fmt(median(rs.map(r => r.turnTimings?.admission_ms ?? null)))} ms; chat SQL ${fmt(median(rs.map(r => r.queryMs)))} ms`, verdict: 'recorded', source: src }))
  }
  return out
}

function finalization(r) { const t = r.turnTimings ?? {}; return typeof t.flush_ms === 'number' && typeof t.post_ms === 'number' ? t.flush_ms + t.post_ms : null }

function scalingLines(row, ctx) {
  const step = ctx.steps['fixed20-scaling']
  return row.cells.flatMap(cell => {
    const result = step?.harness?.results?.find(value => value.scalingCell === cell && value.verified === true)
    if (!result) return [line(row, cell, 'foreground', { verdict: 'unmeasured', source: 'fixed20-scaling', note: stepNote(step, cell) })]
    const fixture = result.scaling
    const expected = Number(cell.split(':')[1])
    const correct = fixture?.durableRetainedMessages === fixture?.retainedMessages &&
      (cell.startsWith('messages:') ? fixture.retainedMessages === expected && fixture.dependencyCaptures === 1 : fixture.retainedMessages === 10 && fixture.dependencyCaptures === expected)
    return [
      line(row, cell, 'outputFrames', { after: result.outputEvents, budget: '20 exact received frames; canonical retained size and distinct dependency count equal the selected cell', verdict: correct && result.outputEvents === 20 ? 'pass' : 'fail', source: 'fixed20-scaling' }),
      line(row, cell, 'foreground', { after: result.queries, afterDetail: `nested ${fmt(result.nestedSql?.nested?.calls)}; retained provider markers ${fmt(fixture?.providerRetainedMessages)}`, verdict: 'recorded', note: 'No new scaling numeric ceiling adopted; retain the full curve for structural review.', source: 'fixed20-scaling' }),
      line(row, cell, 'wallMs', { after: result.elapsedMs, afterDetail: `preparation ${fmt(result.turnTimings?.loop_started_at_ms)} ms; finalization ${fmt(finalization(result))} ms; canonical seeding ${fmt(fixture?.seedMs)} ms excluded`, verdict: 'recorded', source: 'fixed20-scaling' }),
      line(row, cell, 'permissionWork', { verdict: 'unmeasured', note: 'Physical accounting remains incomplete; nested statements and a finite-size curve do not certify bounded permission work.', source: 'fixed20-scaling' }),
    ]
  })
}

function fixed20Lines(row, ctx, stepId, mode) {
  const s = ctx.steps[stepId]
  const harness = s?.harness
  const groups = fixed20Groups(harness)
  const base = ctx.baseline
  const out = []
  const cells = mode.cells ?? FIXED20_SCENARIOS
  for (const cell of cells) {
    const scenario = mode.scenarioOf ? mode.scenarioOf(cell) : cell
    const rs = groups.get(scenario) ?? []
    const src = `${stepId} (${rs.length} sample${rs.length === 1 ? '' : 's'})`
    if (!rs.length) { out.push(line(row, cell, 'foreground', { verdict: 'unmeasured', note: stepNote(s, scenario), source: stepId })); continue }
    const fg = rs.map(r => r.queries), nested = rs.map(r => r.nestedSql?.nested?.calls ?? null)
    const bf = base.fixed20?.scenarios?.[scenario]
    if (mode.kind === 'counts') {
      out.push(line(row, cell, 'foreground', { ...foregroundTarget('foreground', fg), afterDetail: `median ${fmt(median(fg))}`, baseline: bf?.foreground, source: src }))
      const nestedMax = max(nested)
      out.push(permissionLine(row, cell, 'noTool', scenario, nestedMax, { afterDetail: `median ${fmt(median(nested))}`, baseline: bf?.nested, source: src }))
      out.push(line(row, cell, 'outputFrames', { after: min(rs.map(r => r.outputEvents)), afterDetail: `provider chunks ${fmt(rs[0].providerTextChunks)}`, budget: BUDGETS.outputFrames.text, verdict: rs.every(r => r.outputEvents === 20) ? 'pass' : 'fail', source: src }))
      out.push(line(row, cell, 'audienceChecks', { after: median(rs.map(r => r.turnTimings?.audience_check_count ?? null)), before: base.before.metrics.audienceChecks.value, budget: 'no numeric budget (section 7 structural rule; reviewed)', verdict: 'recorded', source: src }))
      out.push(line(row, cell, 'admissionMs', { after: median(rs.map(r => r.turnTimings?.admission_ms ?? null)), before: base.before.metrics.admissionMs.value, verdict: 'recorded', source: src }))
      out.push(line(row, cell, 'chatSqlMs', { after: median(rs.map(r => r.queryMs)), verdict: 'recorded', source: src }))
      out.push(line(row, cell, 'wallMs', { after: median(rs.map(r => r.elapsedMs)), before: base.before.metrics.wallMs.value, baseline: bf?.wallMs, verdict: 'recorded', note: 'before is a live-provider development-data turn, not comparable', source: src }))
      out.push(line(row, cell, 'functionCalls', { after: median(rs.map(r => r.functionCalls)), verdict: 'recorded', source: src }))
    } else if (mode.kind === 'classifiers') {
      const t = (k) => median(rs.map(r => r.turnTimings?.[k] ?? 0))
      out.push(line(row, cell, 'modelCalls', { after: `research ${fmt(t('research_classify_count'))} / topic ${fmt(t('topic_classify_count'))} / split ${fmt(t('split_classify_count'))}`, budget: 'no row for this turn in the routing table; recorded', verdict: 'recorded', source: src }))
    } else if (mode.kind === 'warm') {
      const bw = base.warm?.scenarios?.[scenario], bwall = base.warm?.wall?.[scenario]
      const enough = rs.length >= BUDGETS.preparationP95.minSamples
      const prep = quantile(rs.map(r => r.turnTimings?.loop_started_at_ms ?? null), 0.95)
      const fin = quantile(rs.map(finalization), 0.95)
      out.push(line(row, cell, 'preparationMs', { metricVariant: 'p95', after: prep, baseline: bw?.preparationP95, budget: BUDGETS.preparationP95.text, verdict: enough ? budgetVerdict('preparationP95', prep) : 'insufficient-samples', source: src }))
      out.push(line(row, cell, 'finalizationMs', { metricVariant: 'p95', after: fin, baseline: bw?.finalizationP95, budget: BUDGETS.finalizationP95.text, verdict: enough ? budgetVerdict('finalizationP95', fin) : 'insufficient-samples', source: src }))
      out.push(line(row, cell, 'wallMs', { metricVariant: 'p50 / p95', after: `${fmt(quantile(rs.map(r => r.elapsedMs), 0.5))} / ${fmt(quantile(rs.map(r => r.elapsedMs), 0.95))}`, baseline: bwall ? `${fmt(bwall.p50)} / ${fmt(bwall.p95)}` : undefined, verdict: 'recorded', source: src }))
      out.push(latencyLine(row, cell, 'noTool', scenario, rs, { source: src }))
      out.push(line(row, cell, 'foreground', { metricVariant: 'max over warm samples', ...foregroundTarget('foreground', fg), baseline: bf?.foreground, source: src }))
    } else if (mode.kind === 'fragments') {
      const ref = fixed20Groups(ctx.steps['fixed20-oss-frag-20']?.harness).get(scenario)
      const refFg = median((ref ?? []).map(r => r.queries)), refNested = median((ref ?? []).map(r => r.nestedSql?.nested?.calls ?? null))
      const fgNow = median(fg), nestedNow = median(nested)
      const ratio = (a, b) => (a !== null && b) ? a / b : null
      const growth = Math.max(ratio(fgNow, refFg) ?? 0, ratio(nestedNow, refNested) ?? 0)
      const fragFg = mode.fragments === '2000' ? base.fragments?.['2000']?.foreground : undefined
      out.push(line(row, cell, 'foreground', { after: fgNow, afterDetail: `nested ${fmt(nestedNow)}; output frames ${fmt(median(rs.map(r => r.outputEvents)))} of ${fmt(rs[0].providerTextChunks)} provider chunks; wall ${fmt(median(rs.map(r => r.elapsedMs)))} ms`, baseline: fragFg, budget: 'statement counts within 5% of the 20-chunk run (counts must not grow with provider fragmentation)', verdict: ref?.length ? (growth <= 1.05 ? 'pass' : 'fail') : (mode.fragments === '20' ? 'recorded (reference)' : 'unmeasured'), source: src }))
    } else if (mode.kind === 'stale') {
      out.push(line(row, cell, 'reclaim', { unit: 'claims', after: s.status === 'completed' ? 'one atomic claim (harness assertion)' : s.status, verdict: s.status === 'completed' ? 'pass' : 'fail', source: src }))
    }
  }
  return out
}

function stepNote(s, what) {
  if (!s) return 'step not part of this run'
  if (s.status === 'skipped') return `skipped: ${s.reason}`
  if (s.status !== 'completed' && s.status !== 'partial') return `${s.status}: ${s.reason}`
  return `no verified samples for ${what} (filtered out or failed assertions)`
}

function unmeasuredLine(row, reason) { return line(row, row.cells.join(', '), '', { verdict: 'unmeasured', note: reason }) }

function admissionLines(row, ctx) {
  const s = ctx.steps.admission
  const results = (s?.harness?.results ?? []).filter(r => !r.warmup)
  const m2 = readJson(platformPath(ctx.baseline.admission.sourceJson))
  const prior = (m2?.isolatedRun?.results ?? []).filter(r => !r.warmup)
  const before = ctx.baseline.before.metrics
  const out = []
  for (const cell of row.cells) {
    const rs = results.filter(r => r.scenario === cell), ps = prior.filter(r => r.scenario === cell)
    if (!rs.length) { out.push(line(row, cell, 'audienceChecks', { verdict: 'unmeasured', note: stepNote(s, cell), source: 'admission' })); continue }
    const src = `admission (${rs.length} warm samples)`
    const measuredFrames = rs.every(r => Number.isInteger(r.outputFrames) && r.outputFrames > 0 && Number.isInteger(r.outputFrameAdmissions))
    out.push(line(row, cell, 'outputFrames', { metricVariant: 'one protected admission per received text frame',
      after: measuredFrames ? `${fmt(median(rs.map(r => r.outputFrameAdmissions)))} / ${fmt(median(rs.map(r => r.outputFrames)))}` : null,
      budget: 'exactly one admission per received text frame, including one per-frame assertion in the real route harness',
      verdict: !measuredFrames ? 'unmeasured' : rs.every(r => {
        const sequence = r.outputAdmissionSequence?.filter(event => event.type === 'text_delta')
        return r.outputFrameAdmissions === r.outputFrames && sequence?.length === r.outputFrames && sequence.every(event => event.admissions === 1 && event.kernelAdmissions === 1 && event.hostSinkAudienceChecks === 0)
      }) ? 'pass' : 'fail', source: src }))
    out.push(line(row, cell, 'audienceChecks', { after: median(rs.map(r => r.audienceCheckCount)), afterDetail: `${fmt(median(rs.map(r => r.audienceCallsDuringAdmission)))} during admission`, before: before.audienceChecks.value, baseline: median(ps.map(r => r.audienceCheckCount)), budget: 'no numeric budget; one output admission per emitted frame and one evaluation per distinct boundary (reviewed from the per-site attribution)', verdict: 'recorded', source: src }))
    out.push(line(row, cell, 'admissionMs', { after: median(rs.map(r => r.admissionMs)), before: before.admissionMs.value, baseline: median(ps.map(r => r.admissionMs)), verdict: 'recorded', note: 'before is development data with a live provider', source: src }))
    out.push(line(row, cell, 'foreground', { metricVariant: 'per-turn SQL ledger (9-word reply)', after: median(rs.map(r => r.sql?.statements)), afterDetail: `control ${fmt(median(rs.map(r => r.sql?.control)))}`, baseline: median(ps.map(r => r.sql?.statements)), budget: 'cross-check of A1; the <=50 budget is qualified on the fixed-20 workload', verdict: 'recorded', source: src }))
    out.push(line(row, cell, 'wallMs', { after: median(rs.map(r => r.elapsedMs)), before: before.wallMs.value, baseline: median(ps.map(r => r.elapsedMs)), verdict: 'recorded', source: src }))
  }
  return out
}

/** Row A11: one 32-turn doc thread; the interim budget applies at turn 32. */
function docThreadLines(row, ctx) {
  const s = ctx.steps['doc-thread-32'], results = s?.harness?.results ?? []
  return row.cells.flatMap(cell => {
    const r = results.find(value => String(value.turn) === cell)
    if (!r) return [line(row, cell, 'docAudienceMs', { verdict: 'unmeasured', note: stepNote(s, `turn ${cell}`), source: 'doc-thread-32' })]
    const limit = cell === '32' ? BUDGETS.docThreadAudience.limit : null
    return [
      line(row, cell, 'docAudienceMs', { after: r.audienceMs ?? null, afterDetail: `${fmt(r.audienceChecks ?? null)} checks; closure ${r.closure ? `${r.closure.proofs ?? 0} proofs, ${r.closure.sharedProofs ?? 0} shared` : 'not logged'}`,
        budget: limit === null ? 'recorded (budget at turn 32)' : `<=${fmt(limit)} (${BUDGETS.docThreadAudience.text})`,
        verdict: r.audienceMs == null ? 'unmeasured' : limit === null ? 'recorded' : r.audienceMs <= limit ? 'pass (interim)' : 'fail', source: 'doc-thread-32' }),
      line(row, cell, 'docTurnMs', { after: r.totalMs ?? null, verdict: 'recorded', source: 'doc-thread-32' }),
    ]
  })
}

function modelCallLines(row, ctx) {
  const s = ctx.steps['model-calls']
  const results = s?.harness?.results ?? []
  if (!results.length) return [line(row, row.cells[0], 'modelCalls', { verdict: 'unmeasured', note: stepNote(s, 'routing turns'), source: 'model-calls' })]
  const table = ctx.baseline.modelCalls.turns
  return results.map(r => {
    const expected = table[r.turn.toLowerCase()]?.value ?? r.expected
    const ok = s.status === 'completed' && r.modelCalls === r.expected && r.modelCalls === expected
    return line(row, r.turn, 'modelCalls', { after: r.modelCalls, afterDetail: `research ${r.calls?.research} / topic ${r.calls?.topic} / split ${r.calls?.split}${r.timed ? `; turnTiming ${r.timed.research}/${r.timed.topic}/${r.timed.split}` : ''}`, baseline: expected, budget: `== ${r.expected} (routing table)`, verdict: ok ? 'pass' : 'fail', source: 'model-calls' })
  })
}

function importGraphLines(row, ctx, stepId, gated) {
  const s = ctx.steps[stepId]
  const entries = s?.harness?.summary?.entries
  const before = readJson(platformPath(ctx.baseline.imports.staticJson))?.summary?.entries ?? {}
  if (!entries) return [line(row, row.cells.join(', '), 'staticFiles', { verdict: 'unmeasured', note: stepNote(s, 'entries'), source: stepId })]
  return row.cells.map(entry => {
    const e = entries[entry]
    if (!e) return line(row, entry, 'staticFiles', { verdict: 'unmeasured', note: 'entry absent from the harness output', source: stepId })
    const forbidden = (e.forbiddenFiles ?? 0) + (e.forbiddenNpm?.length ?? 0)
    const b = before[entry]
    return line(row, entry, 'forbidden', { after: forbidden, afterDetail: `files ${fmt(e.files)}, npm ${fmt(e.npmPackages)}, forbidden files ${fmt(e.forbiddenFiles)}, forbidden npm ${fmt(e.forbiddenNpm?.length)}`, baseline: b ? `files ${fmt(b.files)}, forbidden ${fmt((b.forbiddenFiles ?? 0) + (b.forbiddenNpm?.length ?? 0))}` : undefined, budget: gated ? BUDGETS.forbiddenImports.text : 'recorded (boot entries load features by design)', verdict: gated ? budgetVerdict('forbiddenImports', forbidden) : 'recorded', source: stepId })
  })
}

function traceLines(row, ctx, stepId) {
  const s = ctx.steps[stepId]
  const h = s?.harness
  const snap = h?.snapshots?.find(x => x.label === 'startup')
  const rt = ctx.baseline.imports
  if (row.id === 'D5') {
    if (!h) return [unmeasuredLine(row, `${row.unmeasured} ${stepNote(s, 'trace')}`)]
    const delta = h.ordinaryTurnImportDelta
    return [line(row, 'after-turn', 'forbidden', { after: delta ? delta.forbiddenWorkspace.length + delta.forbiddenNpm.length : null,
      afterDetail: delta ? `${delta.addedModules} newly loaded modules; exact reply ${h.turn?.receivedExact}; durable ${h.turn?.savedReply}` : undefined,
      budget: BUDGETS.forbiddenImports.text, verdict: !delta || h.turn?.status !== 'pass' ? 'unmeasured' : budgetVerdict('forbiddenImports', delta.forbiddenWorkspace.length + delta.forbiddenNpm.length), source: stepId }),
    ...row.cells.filter(cell => cell !== 'after-turn').map(cell => {
      const probe = h.probes?.find(value => value.id === cell)
      return line(row, cell, 'loadedModules', { after: probe?.status ?? null, verdict: probe?.status === 'pass' && probe.loadedImplementation === true ? 'pass' : 'unmeasured',
        note: probe?.reason ?? 'activation probe absent or implementation loading not verified', source: stepId })
    })]
  }
  if (!snap) return [line(row, 'startup', 'loadedModules', { verdict: 'unmeasured', note: stepNote(s, 'startup snapshot'), source: stepId })]
  return [
    line(row, 'startup', 'loadedModules', { after: snap.loadedCount, afterDetail: `npm packages ${fmt(snap.npmPackages?.length)}; ${Object.entries(snap.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}`, baseline: `${fmt(rt.runtime.loadedModules)} (pre-M4 import of dist/boot.js, no boot)`, budget: 'recorded; the M4 exit rule applies to the after-turn delta (D5)', verdict: 'recorded', source: stepId }),
    line(row, 'startup', 'bootMs', { after: snap.elapsedMs, baseline: `${fmt(rt.boot.ossHealthMs)} (OSS /health, launcher path)`, verdict: 'recorded', source: stepId }),
    line(row, 'startup', 'rssBytes', { after: snap.rssBytes, baseline: `${rt.runtime.rssMb} MB (pre-M4 import)`, verdict: 'recorded', source: stepId }),
  ]
}

function codemodLines(row, ctx) {
  const s = ctx.steps['codemod-verify']
  const h = s?.harness
  if (!h) return [line(row, row.cells.join(', '), 'd13', { verdict: 'unmeasured', note: stepNote(s, 'verify'), source: 'codemod-verify' })]
  return row.cells.map(cell => line(row, cell, cell, { unit: 'edges', after: h[cell], baseline: ctx.baseline.d13?.[cell]?.value, budget: BUDGETS.d13Residue.text, verdict: budgetVerdict('d13Residue', h[cell]), source: 'codemod-verify' }))
}

function browserLines(row, ctx) {
  const base = ctx.baseline.browser.rows[row.id] ?? {}
  return row.steps.map(stepId => {
    const s = ctx.steps[stepId]
    const width = stepId.match(/-(390|1440)$/)?.[1]
    const checks = s?.harness?.checks
    if (!Array.isArray(checks)) return line(row, width, 'journey', { unit: 'checks', baseline: base[width], verdict: 'unmeasured', note: stepNote(s, 'result.json'), source: stepId })
    const passed = checks.filter(c => c.ok).length
    return line(row, width, 'journey', { unit: 'checks', after: `${passed}/${checks.length}`, afterDetail: checks.filter(c => !c.ok).map(c => c.id).join(', ') || undefined, baseline: base[width], budget: BUDGETS.journey.text, verdict: passed === checks.length && checks.length > 0 ? 'pass' : 'fail', note: ['E5', 'E9', 'E12', 'E13', 'E14', 'E15', 'E16', 'E17'].includes(row.id) ? 'shared journey run; split its checks by row when reviewing result.json' : undefined, source: stepId })
  })
}

function gateLine(row, ctx, stepId, extra = {}) {
  const s = ctx.steps[stepId]
  if (!s || s.status === 'skipped') return line(row, row.cells[0], 'gate', { verdict: 'unmeasured', note: stepNote(s, 'gate'), source: stepId, ...extra })
  const tests = s.tests ? `${s.tests.passed}/${s.tests.total} tests passed, ${s.tests.failed} failed, ${s.tests.skipped} skipped` : undefined
  return line(row, row.cells[0], 'gate', { after: s.status, afterDetail: tests, budget: BUDGETS.gate.text, verdict: s.status === 'completed' ? 'pass' : 'fail', note: s.status === 'completed' ? undefined : s.reason, source: stepId, ...extra })
}

function transferLines(row, ctx) {
  const s = ctx.steps.transfer
  const chat = s?.harness?.chat
  if (row.id === 'A6') {
    if (!chat) return [line(row, 'transferred', 'outputFrames', { verdict: 'unmeasured', note: stepNote(s, 'transfer receipt'), source: 'transfer' })]
    const sqlMeasured = Number.isInteger(chat.sql?.statements) && chat.sql.statements > 0 &&
      ['statements', 'fingerprints', 'frames'].every(key => Number.isInteger(chat.sql?.overflow?.[key]))
    const foreground = foregroundTarget('foreground', [chat.sql?.statements])
    if (!sqlMeasured) {
      delete foreground.overTargetBy
      foreground.verdict = 'unmeasured'
      foreground.note = 'foreground count or required SQL accounting counters absent'
    } else if (Object.values(chat.sql.overflow).some(value => value !== 0)) {
      foreground.verdict = 'fail'
      foreground.note = 'SQL accounting overflow'
    }
    return [line(row, 'transferred', 'outputFrames', { after: chat.textFrames, afterDetail: `wall ${fmt(chat.elapsedMs)} ms; exact ${chat.receivedExact}; guard calls ${fmt(chat.functionCalls?.['native_turn_helpers_current()'])}`, budget: BUDGETS.outputFrames.text, verdict: chat.textFrames === 20 && chat.receivedExact ? 'pass' : 'fail', source: 'transfer' }),
      line(row, 'transferred', 'foreground', { ...foreground, afterDetail: `control ${fmt(chat.sql?.control)}; failures ${fmt(chat.sql?.failed)}`, source: 'transfer' }),
      line(row, 'transferred', 'permissionWork', { after: null, verdict: 'unmeasured', note: chat.nestedSql?.reason ?? 'nested statements absent from transfer receipt', source: 'transfer' })]
  }
  return [gateLine(row, ctx, 'transfer', { baseline: ctx.baseline.transfer.G1.value })]
}

function buildLines(ctx) {
  const lines = []
  for (const row of ROWS) {
    const ran = row.steps.some(id => ctx.steps[id])
    if (row.unmeasured && row.id !== 'D5') { lines.push(unmeasuredLine(row, row.unmeasured)); continue }
    switch (row.id) {
      case 'A1': lines.push(...fixed20Lines(row, ctx, 'fixed20-oss-counts', { kind: 'counts' })); break
      case 'A2': lines.push(...fixed20Lines(row, ctx, 'fixed20-hosted-counts', { kind: 'counts' })); break
      case 'A3': lines.push(...fixed20Lines(row, ctx, 'fixed20-oss-warm', { kind: 'warm' })); break
      case 'A4': for (const n of ['20', '200', '2000']) lines.push(...fixed20Lines(row, ctx, `fixed20-oss-frag-${n}`, { kind: 'fragments', fragments: n, cells: FIXED20_SCENARIOS.map(s => `${n}:${s}`), scenarioOf: c => c.split(':')[1] })); break
      case 'A5': lines.push(...fixed20Lines(row, ctx, 'fixed20-oss-stale-room', { kind: 'stale', cells: row.cells })); break
      case 'A6': case 'G1': lines.push(...transferLines(row, ctx)); break
      case 'A7': lines.push(...coldLines(row, ctx)); break
      case 'A8': lines.push(...lookupLines(row, ctx)); break
      case 'A9': lines.push(...scalingLines(row, ctx)); break
      case 'A11': lines.push(...docThreadLines(row, ctx)); break
      case 'B1': lines.push(...admissionLines(row, ctx)); break
      case 'C1': lines.push(...modelCallLines(row, ctx)); break
      case 'C2': lines.push(...fixed20Lines(row, ctx, 'fixed20-oss-counts', { kind: 'classifiers' })); break
      case 'D1': lines.push(...importGraphLines(row, ctx, 'import-graph-chat', true)); break
      case 'D2': lines.push(...importGraphLines(row, ctx, 'import-graph-m4', false)); break
      case 'D3': case 'D5': lines.push(...traceLines(row, ctx, 'runtime-trace-oss')); break
      case 'D4': lines.push(...traceLines(row, ctx, 'runtime-trace-oss-workers')); break
      case 'D6': lines.push(...codemodLines(row, ctx)); break
      case 'G2': lines.push(gateLine(row, ctx, 'launcher-receiving', { baseline: ctx.baseline.transfer.G2.value })); break
      default:
        if (row.section === 'E') lines.push(...browserLines(row, ctx))
        else if (row.section === 'F' || row.section === 'H') lines.push(gateLine(row, ctx, row.steps[0], { baseline: ctx.baseline.gates?.[row.id]?.value }))
        else lines.push(line(row, '', '', { verdict: ran ? 'recorded' : 'unmeasured' }))
    }
  }
  return lines
}

// ── Run loading and rendering ────────────────────────────────────────────

function loadRun(dir) {
  const run = readJson(join(dir, 'run.json'))
  if (!run) throw new Error(`no run.json in ${dir}`)
  const steps = {}
  for (const file of readdirSync(join(dir, 'steps')).filter(f => f.endsWith('.json'))) {
    const s = readJson(join(dir, 'steps', file))
    if (!s) continue
    const usable = s.status === 'completed' || s.status === 'partial' || s.status === 'failed'
    s.harness = usable && s.outputs?.harness && existsSync(s.outputs.harness) ? readJson(s.outputs.harness) : null
    steps[s.stepId] = s
  }
  return { run, steps }
}

export function qualification(run, lines, steps = {}) {
  const reasons = []
  if (run.plumbing) reasons.push('plumbing run (plumbing proof, not a qualification result)')
  if (run.profile !== 'full') reasons.push(`profile ${run.profile}, not full`)
  for (const [key, label] of [['oss', 'OSS'], ['platform', 'platform']]) {
    const start = run.source?.start?.[key], end = run.source?.end?.[key]
    const valid = identity => identity?.git === true && /^[a-f0-9]{40,64}$/.test(identity.head ?? '') &&
      ['diffSha256', 'untrackedSha256'].every(field => /^[a-f0-9]{64}$/.test(identity[field] ?? ''))
    if (!valid(start) || !valid(end)) reasons.push(`${label} source identity missing or incomplete`)
    if (start?.dirty !== false) reasons.push(`${label} tree not proven clean at start (M6 qualifies committed final source)`)
    if (end?.dirty !== false) reasons.push(`${label} tree not proven clean at end`)
    const same = valid(start) && valid(end) && ['head', 'diffSha256', 'untrackedSha256'].every(field => start[field] === end[field])
    if (!same || run.source?.unchangedDuringRun?.[key] !== true) reasons.push(`${label} source unchanged state not proven`)
  }
  const missingRows = ROWS.filter(row => !lines.some(result => result.row === row.id))
  if (missingRows.length) reasons.push(`missing matrix results: ${missingRows.map(row => row.id).join(', ')}`)
  for (const [id, step] of Object.entries(steps)) if (step.measurementConditions?.qualifiesControlledLoad === false) {
    reasons.push(`${id}: controlled-load acceptance not proven (${step.measurementConditions.reason})`)
  }
  const notPass = lines.filter(l => l.verdict !== 'pass' && l.verdict !== 'recorded')
  const count = (pred) => notPass.filter(pred).length
  if (notPass.length) reasons.push(`${notPass.length} result line(s) not passing: ${count(l => l.verdict === 'fail')} fail, ${count(l => l.verdict === 'unmeasured')} unmeasured, ${count(l => l.verdict === 'pending-decision')} pending-decision, ${count(l => String(l.verdict).startsWith('pass (provisional'))} provisional (incomplete permission-work accounting), ${count(l => l.verdict === 'insufficient-samples')} insufficient samples`)
  return { qualifying: reasons.length === 0, reasons }
}

const esc = (x) => fmt(x).replaceAll('|', '\\|').replaceAll('\n', ' ')

function renderMarkdown(run, steps, lines, q) {
  const md = []
  md.push(`# M6 results: ${run.runId}`, '')
  if (run.plumbing) md.push('**Plumbing proof, not a qualification result.**', '')
  for (const [id, step] of Object.entries(steps)) if (step.measurementConditions?.qualifiesControlledLoad === false) {
    md.push(`Measurement conditions, \`${id}\`: ${step.measurementConditions.reason}. Numeric threshold verdicts are retained; controlled-load acceptance is not proven.`, '')
  }
  md.push(`Profile \`${run.profile}\`; steps ${run.steps.length}; started ${run.startedAt}; finished ${run.finishedAt ?? 'unfinished'}; Node ${run.node}.`)
  const o = run.source?.start?.oss
  md.push(`OSS source: HEAD \`${o?.head?.slice(0, 12) ?? '?'}\`, dirty ${o?.dirty}, diff \`${o?.diffSha256?.slice(0, 12) ?? '?'}\`, untracked ${o?.untrackedFiles ?? '?'}; unchanged during run: ${run.source?.unchangedDuringRun?.oss}.`, '')
  md.push(`**Qualifying: ${q.qualifying ? 'yes' : 'no'}.**${q.reasons.length ? ' ' + q.reasons.join('; ') + '.' : ''}`, '')
  md.push('Fixed-20 foreground SQL counts are compared with indicative targets of 50 for no tool and 100 for one lookup. Required counts must be present. Exceeding an indicative target alone does not fail qualification.', '')
  md.push('Permission work and latency are per-scenario budgets (decided 2026-11-17: fused admission adopted, the 999 nested-statement ceiling retired). Permission work is the measured fused-admission nested statements plus 20%; nested statements are the M1 receipts\' unit and are not complete physical permission work, so a pass stays provisional until the accounting is reviewed as complete. Latency is the warm wall-time p50 per scenario against the measured fused-admission p50.', '')
  md.push('## Steps', '', '| Step | Rows | Status | Duration (command, plus fixture provisioning) | Reason |', '|---|---|---|---:|---|')
  for (const id of run.steps) {
    const s = steps[id]
    md.push(`| ${id} | ${s?.rows?.join(', ') ?? ''} | ${s?.status ?? 'missing'} | ${s?.durationMs !== undefined ? fmt(s.durationMs / 1000) + ' s' : ''}${s?.fixture ? ` (+ fixture ${fmt(s.fixture.provisionMs / 1000)} s)` : ''} | ${esc(s?.reason ?? '')} |`)
  }
  md.push('', '## Results', '', '| Row | Cell | Metric | Before | Baseline | After | Budget | Verdict | Source / note |', '|---|---|---|---:|---:|---:|---|---|---|')
  for (const l of lines) {
    const metric = l.metric ? `${l.metric}${l.metricVariant ? ` (${l.metricVariant})` : ''}` : ''
    const after = l.after !== undefined ? `${esc(l.after)}${l.afterDetail ? ` (${esc(l.afterDetail)})` : ''}` : (l.afterDetail ? esc(l.afterDetail) : '')
    const targetNote = l.overTargetBy > 0 ? `${fmt(l.overTargetBy)} over indicative target` : undefined
    md.push(`| ${l.row} | ${esc(l.cell)} | ${metric} | ${esc(l.before)} | ${esc(l.baseline)} | ${after} | ${esc(l.budget)} | ${l.verdict} | ${esc([l.source, l.note, targetNote].filter(Boolean).join('; '))} |`)
  }
  md.push('', 'Before: the 2026-11-16 one-turn baseline (development data, live provider). Baseline: the latest receipt for the same harness (see baseline.json for each source). Verdict rules: docs/plans/oss-chat-m6-qualification-plan.md.', '')
  return md.join('\n')
}

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => argv[++i]
    if (a === '--run') o.run = resolve(v())
    else if (a === '--md') o.md = resolve(v())
    else if (a === '--json') o.json = resolve(v())
    else if (a === '--baseline') o.baseline = resolve(v())
    else if (a === '--verify-baseline') o.verify = true
    else throw new Error(`unknown argument ${a}`)
  }
  return o
}

function main() {
  const o = parseArgs(process.argv.slice(2))
  const baseline = readJson(o.baseline ?? join(HERE, 'baseline.json'))
  if (!baseline) throw new Error('baseline.json unreadable')
  const verified = verifyBaseline(baseline)
  if (o.verify) {
    console.log(JSON.stringify(verified, null, 2))
    return verified.failures.length ? 1 : 0
  }
  if (!o.run) throw new Error('--run <dir> is required (or --verify-baseline)')
  const { run, steps } = loadRun(o.run)
  const lines = buildLines({ run, steps, baseline })
  for (const result of lines) {
    const row = ROWS.find(row => row.id === result.row)
    const conditions = (row?.steps ?? []).filter(id => steps[id]?.measurementConditions).map(id => ({ step: id, ...steps[id].measurementConditions }))
    if (conditions.length) result.measurementConditions = conditions
  }
  const q = qualification(run, lines, steps)
  const md = renderMarkdown(run, steps, lines, q)
  const json = { tool: 'use-brian/scripts/testing/m6/collect.mjs', schema: 1, runId: run.runId, plumbing: run.plumbing, ...(run.plumbing ? { note: 'plumbing proof, not a qualification result' } : {}),
    qualification: q, baselineVerification: verified, steps: Object.fromEntries(run.steps.map(id => [id, { status: steps[id]?.status, reason: steps[id]?.reason, durationMs: steps[id]?.durationMs, rows: steps[id]?.rows,
      ...(steps[id]?.measurementConditions ? { measurementConditions: steps[id].measurementConditions } : {}) }])), lines }
  writeFileSync(o.md ?? join(o.run, 'results.md'), md)
  writeFileSync(o.json ?? join(o.run, 'results.json'), JSON.stringify(json, null, 2) + '\n')
  const overTarget = lines.filter(l => l.overTargetBy > 0).length
  console.error(`collect: ${lines.length} result lines; qualifying ${q.qualifying}; ${overTarget} over indicative foreground SQL target; baseline quotes ${verified.checked - verified.failures.length}/${verified.checked} verified`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main() } catch (error) { console.error(error.message); process.exitCode = 2 }
}
