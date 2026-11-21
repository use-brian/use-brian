// [COMP:tooling/m6-qualification] M6 orchestrator and collector: registry
// consistency, never-optimistic status classification and the qualification gate.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ROWS, BUDGETS, FIXED20_SCENARIOS } from '../testing/m6/matrix.mjs'
import { STEPS, PROFILES, classify, parseArgs, selectSteps, sourceIdentity } from '../testing/m6/run-matrix.mjs'
import { qualification, verifyBaseline } from '../testing/m6/collect.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const M6 = resolve(HERE, '../testing/m6')

describe('[COMP:tooling/m6-qualification] M6 qualification harness', () => {
  it('maps every row to registered steps and every full-profile step to a row', () => {
    const ids = ROWS.map(r => r.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(ROWS.length, 61)
    for (const row of ROWS) for (const step of row.steps) assert.ok(STEPS[step], `${row.id} names unknown step ${step}`)
    for (const row of ROWS) if (!row.steps.length) assert.ok(row.unmeasured, `${row.id} has no step and no unmeasured reason`)
    for (const id of PROFILES.full) assert.ok(ROWS.some(r => r.steps.includes(id)), `${id} feeds no row`)
    for (const id of PROFILES['dry-run']) assert.ok(STEPS[id])
    assert.equal(FIXED20_SCENARIOS.length, 6)
    assert.equal(BUDGETS.permissionWork.status, 'binding')
  })

  it('requires clean and unchanged authenticated source in both repositories', () => {
    const identity = { git: true, dirty: false, head: 'a'.repeat(40), diffSha256: 'b'.repeat(64), untrackedSha256: 'c'.repeat(64) }
    const run = { profile: 'full', source: { start: { oss: identity, platform: identity }, end: { oss: identity, platform: identity }, unchangedDuringRun: { oss: true, platform: true } } }
    const lines = ROWS.map(row => ({ row: row.id, verdict: 'pass' }))
    assert.equal(qualification(run, lines).qualifying, true)
    assert.equal(qualification(run, lines, { 'fixed20-oss-warm': { measurementConditions: { qualifiesControlledLoad: false, reason: 'fixture replay overlap not excluded' } } }).qualifying, false)
    assert.equal(qualification(run, []).qualifying, false)
    assert.equal(qualification({ profile: 'full' }, []).qualifying, false)
    const withStart = platform => ({ ...run, source: { ...run.source, start: { ...run.source.start, platform } } })
    assert.equal(qualification(withStart({ ...identity, dirty: true }), lines).qualifying, false)
    assert.equal(qualification(withStart({ git: true }), lines).qualifying, false)
    assert.equal(qualification(withStart({ ...identity, diffSha256: 'd'.repeat(64) }), lines).qualifying, false)
    assert.equal(qualification({ ...run, source: { ...run.source, unchangedDuringRun: { oss: true } } }, lines).qualifying, false)
    assert.equal(qualification(run, [...lines, { verdict: 'pass (provisional: incomplete accounting)' }]).qualifying, false)
  })

  it('detects same-size untracked edits even when the timestamp is restored', () => {
    const repo = mkdtempSync(join(tmpdir(), 'm6-source-'))
    assert.equal(spawnSync('git', ['init', repo]).status, 0)
    assert.equal(spawnSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture']).status, 0)
    const file = join(repo, 'untracked.txt'), timestamp = new Date(1000)
    writeFileSync(file, 'before'); utimesSync(file, timestamp, timestamp)
    const before = sourceIdentity(repo)
    writeFileSync(file, 'after!'); utimesSync(file, timestamp, timestamp)
    assert.notEqual(sourceIdentity(repo).untrackedSha256, before.untrackedSha256)
  })

  it('never classifies a missing harness output or an all-skipped suite as a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm6-classify-'))
    const vitest = join(dir, 'vitest.json')
    writeFileSync(vitest, JSON.stringify({ numTotalTests: 6, numPassedTests: 0, numFailedTests: 0, numPendingTests: 6, success: true }))
    assert.equal(classify({ exitCode: 0, outputs: { harness: join(dir, 'absent.json'), vitest } }).status, 'error')
    const harness = join(dir, 'out.json'); writeFileSync(harness, '{}')
    assert.equal(classify({ exitCode: 0, outputs: { harness, vitest } }).status, 'error')
    assert.equal(classify({ exitCode: 1, outputs: { harness } }).status, 'failed')
    assert.equal(classify({ exitCode: 1, okExitCodes: [0, 1], outputs: { harness } }).status, 'completed')
    assert.equal(classify({ exitCode: 3, partialExitCodes: [3], outputs: { harness } }).status, 'partial')
    assert.equal(classify({ exitCode: null, timedOut: true, outputs: {} }).status, 'timeout')
  })

  it('reports an empty plumbing run as unmeasured and not qualifying', () => {
    const run = mkdtempSync(join(tmpdir(), 'm6-collect-'))
    mkdirSync(join(run, 'steps'))
    writeFileSync(join(run, 'run.json'), JSON.stringify({ runId: 't', profile: 'dry-run', plumbing: true, steps: ['gate-smoke'], startedAt: 'x', node: process.version, source: {} }))
    writeFileSync(join(run, 'steps', 'gate-smoke.json'), JSON.stringify({ stepId: 'gate-smoke', rows: ['H2'], status: 'skipped', reason: 'platform: absent' }))
    const r = spawnSync(process.execPath, [join(M6, 'collect.mjs'), '--run', run], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(readFileSync(join(run, 'results.json'), 'utf8'))
    assert.equal(out.qualification.qualifying, false)
    assert.ok(out.lines.every(l => l.verdict !== 'pass'))
    assert.match(readFileSync(join(run, 'results.md'), 'utf8'), /Plumbing proof, not a qualification result/)
  })

  it('retains a failed step byte for byte when resuming its run', () => {
    const run = mkdtempSync(join(tmpdir(), 'm6-resume-'))
    mkdirSync(join(run, 'steps'))
    writeFileSync(join(run, 'run.json'), JSON.stringify({ runId: 'resume-fixture', profile: 'explicit', steps: ['gate-check-subset'], source: {}, startedAt: 'fixture' }))
    const receiptPath = join(run, 'steps', 'gate-check-subset.json')
    const receipt = JSON.stringify({ stepId: 'gate-check-subset', status: 'failed', reason: 'original failure must remain', finishedAt: 'fixture' }) + '\n'
    writeFileSync(receiptPath, receipt)
    const r = spawnSync(process.execPath, [join(M6, 'run-matrix.mjs'), '--steps', 'gate-check-subset', '--out', run, '--resume'], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(receiptPath, 'utf8'), receipt)
    assert.equal(JSON.parse(readFileSync(join(run, 'run.json'), 'utf8')).resumptions.length, 1)
    assert.match(r.stderr, /retained failed/)
  })

  it('rejects duplicate host admissions and empty frame sequences in real-route receipts', () => {
    const run = mkdtempSync(join(tmpdir(), 'm6-frame-verdict-'))
    mkdirSync(join(run, 'steps'))
    const harness = join(run, 'admission.json')
    const observed = (scenario, over = {}) => ({ scenario, warmup: false, outputFrames: 1, outputFrameAdmissions: 1,
      outputAdmissionSequence: [{ type: 'text_delta', admissions: 1, kernelAdmissions: 1, hostSinkAudienceChecks: 0 }], ...over })
    writeFileSync(harness, JSON.stringify({ results: [observed('empty-private'), observed('populated-private', {
      outputFrameAdmissions: 2, outputAdmissionSequence: [{ type: 'text_delta', admissions: 2, kernelAdmissions: 1, hostSinkAudienceChecks: 1 }],
    }), observed('shared-room', { outputAdmissionSequence: [] })] }))
    writeFileSync(join(run, 'steps', 'admission.json'), JSON.stringify({ stepId: 'admission', status: 'completed', outputs: { harness } }))
    writeFileSync(join(run, 'run.json'), JSON.stringify({ runId: 'frame-fixture', profile: 'explicit', steps: ['admission'], source: {} }))
    const r = spawnSync(process.execPath, [join(M6, 'collect.mjs'), '--run', run], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const lines = JSON.parse(readFileSync(join(run, 'results.json'), 'utf8')).lines.filter(line => line.row === 'B1' && line.metric === 'outputFrames')
    assert.deepEqual(lines.map(line => [line.cell, line.verdict]), [['empty-private', 'pass'], ['populated-private', 'fail'], ['shared-room', 'fail']])
  })

  it('registers the cold (A7) and one-lookup (A8) steps and selects the cold step with --cold', () => {
    const row = (id) => ROWS.find(r => r.id === id)
    assert.deepEqual(row('A7').steps, ['fixed20-oss-cold'])
    assert.deepEqual(row('A8').steps, ['fixed20-oss-lookup'])
    assert.deepEqual(row('A12').steps, ['context-aware-chat'])
    assert.deepEqual(row('A13').steps, ['context-aware-chat-hosted'])
    assert.ok(STEPS['context-aware-chat-hosted'].needs.includes('platform'))
    assert.deepEqual(row('A14').steps, ['concurrent-context-chat'])
    assert.deepEqual(row('A15').steps, ['concurrent-context-chat-hosted'])
    assert.ok(STEPS['concurrent-context-chat-hosted'].needs.includes('platform'))
    assert.equal(row('A7').unmeasured, undefined)
    assert.equal(row('A8').unmeasured, undefined)
    assert.equal(BUDGETS.foreground.limit, 50)
    assert.equal(BUDGETS.oneLookup.limit, 100)
    assert.equal(BUDGETS.foreground.status, 'indicative')
    assert.equal(BUDGETS.oneLookup.status, 'indicative')
    for (const id of ['fixed20-oss-cold', 'fixed20-oss-lookup']) {
      assert.ok(PROFILES.full.includes(id))
      assert.ok(STEPS[id].needs.includes('pgStatStatements'), `${id} needs nested statistics`)
    }
    assert.equal(Object.keys(STEPS).length, 65)
    assert.ok(!PROFILES['dry-run'].includes('fixed20-oss-cold'))
    assert.ok(selectSteps(parseArgs(['--profile', 'dry-run', '--cold'])).includes('fixed20-oss-cold'))
    assert.deepEqual(selectSteps(parseArgs(['--steps', 'fixed20-oss-cold', '--cold'])), ['fixed20-oss-cold'])
    assert.equal(parseArgs([]).coldSamples, 3)
    assert.equal(parseArgs(['--cold-samples', '5']).coldSamples, 5)
    assert.throws(() => parseArgs(['--cold-samples', '0']), /--cold-samples/)
    assert.throws(() => parseArgs(['--barrier-before', 'fixed20-oss-warm']), /supplied together/)
    assert.equal(parseArgs(['--barrier-before', 'fixed20-oss-warm', '--barrier-file', '/tmp/m6-release']).barrierBefore, 'fixed20-oss-warm')
  })

  it('applies the terminal SSE latency budget to each verified concurrent wave', () => {
    const run = mkdtempSync(join(tmpdir(), 'm6-concurrent-chat-'))
    mkdirSync(join(run, 'steps'))
    const harness = join(run, 'concurrent.json'), id = 'concurrent-context-chat'
    const turn = { slot: 1, firstTextMs: 300, doneMs: 690, completionMs: 700,
      httpStatus: 200, sseVerified: true, inputsVerified: true, reopened: true, lockSamples: 1 }
    const wave = { width: 2, phase: 'first', peakRequests: 2, workerConversionCalls: 1,
      turns: [turn, { ...turn, slot: 2, doneMs: 5000, completionMs: 5500 }] }
    writeFileSync(harness, JSON.stringify({ schema: 1, workers: true, poolSize: 4, waves: [wave,
      { ...wave, phase: 'follow-up', turns: [turn, { ...turn, slot: 2, doneMs: 5000.2, completionMs: 5500 }] },
      { ...wave, width: 1, phase: 'follow-up', peakRequests: 1, turns: [{ ...turn, reopened: false }] },
      { ...wave, width: 4, peakRequests: 2 },
    ] }))
    writeFileSync(join(run, 'steps', `${id}.json`), JSON.stringify({ stepId: id, status: 'completed', outputs: { harness } }))
    writeFileSync(join(run, 'run.json'), JSON.stringify({ runId: 'concurrent-fixture', profile: 'explicit', steps: [id], source: {} }))
    const result = spawnSync(process.execPath, [join(M6, 'collect.mjs'), '--run', run], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const lines = JSON.parse(readFileSync(join(run, 'results.json'), 'utf8')).lines.filter(line => line.row === 'A14')
    assert.deepEqual(lines.map(({cell, metric, verdict}) => [cell, metric, verdict]), [
      ['1', 'first', 'unmeasured'], ['1', 'follow-up', 'fail'],
      ['2', 'first', 'pass'], ['2', 'follow-up', 'fail'],
      ['4', 'first', 'fail'], ['4', 'follow-up', 'unmeasured'],
    ])
    assert.equal(lines[2].after, 5000)
    assert.match(lines[2].afterDetail, /SSE done 690–5000 ms.*HTTP close 700–5500 ms.*0\/2 over budget.*2 lock samples.*worker conversion calls 1/)
    assert.equal(lines[3].after, 5001)
    assert.match(lines[3].afterDetail, /1\/2 over budget/)
    assert.match(lines[1].afterDetail, /verified SSE done unavailable.*HTTP close 700 ms.*1\/1 unverified/)
  })

  it('reports indicative overruns for cold, paired warm and one-lookup counts', () => {
    const run = mkdtempSync(join(tmpdir(), 'm6-cold-lookup-'))
    mkdirSync(join(run, 'steps'))
    const sample = (over) => ({ scenario: 'empty-private', permissionModel: 'legacy', sample: 0, verified: true, queries: 323, outputEvents: 20, elapsedMs: 600, queryMs: 500,
      nestedSql: { topLevel: { calls: 323, sharedReads: 0 }, nested: { calls: 31000, sharedReads: 0 } }, turnTimings: { loop_started_at_ms: 200, flush_ms: 50, post_ms: 150, admission_ms: 80 }, ...over })
    const cold = join(run, 'cold.json'), lookup = join(run, 'lookup.json')
    writeFileSync(cold, JSON.stringify({ results: [
      sample({ coldPhase: 'cold', warmup: true, restart: 0, nestedSql: { topLevel: { calls: 323, sharedReads: 900 }, nested: { calls: 31000, sharedReads: 400 } }, turnTimings: { loop_started_at_ms: 900, flush_ms: 90, post_ms: 400, admission_ms: 300 } }),
      sample({ coldPhase: 'warm', sample: 1, restart: 0 }),
    ] }))
    writeFileSync(lookup, JSON.stringify({ tool: 'lookup', results: [
      sample({ queries: 95, workload: 'one-lookup', lookup: { call: { name: 'mcp_call', server: 'introspection', tool: 'listPendingApprovals' }, calls: 1, statements: 3, providerRounds: 2 } }),
      sample({ permissionModel: 'department-v2', queries: 101, workload: 'one-lookup', lookup: { calls: 2, statements: 6, providerRounds: 3 } }),
    ] }))
    const step = (stepId, rows, harness) => writeFileSync(join(run, 'steps', `${stepId}.json`), JSON.stringify({ stepId, rows, status: 'completed', reason: 'exit 0', outputs: { harness } }))
    const chat = join(run, 'context-aware-chat.json')
    writeFileSync(chat, JSON.stringify({ dense: [
      { firstTextMs: 850, completionMs: 5000 }, { firstTextMs: 900, completionMs: 5000.2 },
    ] }))
    step('context-aware-chat', ['A12'], chat)
    step('fixed20-oss-cold', ['A7'], cold)
    step('fixed20-oss-lookup', ['A8'], lookup)
    writeFileSync(join(run, 'run.json'), JSON.stringify({ runId: 't', profile: 'explicit', plumbing: true, steps: ['fixed20-oss-cold', 'fixed20-oss-lookup'], startedAt: 'x', node: process.version, source: {} }))
    const r = spawnSync(process.execPath, [join(M6, 'collect.mjs'), '--run', run], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const { lines, qualification } = JSON.parse(readFileSync(join(run, 'results.json'), 'utf8'))
    const pick = (row, cell, metric, variant) => lines.find(l => l.row === row && l.cell === cell && l.metric === metric && (variant === undefined || l.metricVariant === variant))
    assert.equal(pick('A13', 'dense', 'first turn').verdict, 'unmeasured')
    assert.equal(pick('A12', 'dense', 'first turn').verdict, 'pass')
    assert.equal(pick('A12', 'dense', 'first turn').afterDetail, 'first text at 850 ms')
    assert.equal(pick('A12', 'dense', 'follow-up').verdict, 'fail')
    assert.equal(pick('A12', 'sparse', 'first turn').verdict, 'unmeasured')
    assert.equal(pick('A7', 'empty-private/legacy', 'sharedReads', 'cold, median').after, 1300)
    assert.equal(pick('A7', 'empty-private/legacy', 'sharedReads', 'warm, median').after, 0)
    assert.equal(pick('A7', 'empty-private/legacy', 'preparationMs', 'cold, median / max').after, '900 / 900')
    assert.equal(pick('A7', 'empty-private/legacy', 'preparationMs', 'warm, median / max').after, '200 / 200')
    assert.equal(pick('A7', 'empty-private/legacy', 'foreground', 'cold, max').verdict, 'recorded')
    assert.equal(pick('A7', 'empty-private/legacy', 'foreground', 'cold, max').overTargetBy, 273)
    assert.equal(pick('A7', 'empty-private/legacy', 'foreground', 'warm, max').overTargetBy, 273)
    assert.equal(pick('A7', 'shared-room/legacy', 'foreground', 'cold').verdict, 'unmeasured')
    assert.equal(pick('A8', 'empty-private/legacy', 'foreground').verdict, 'recorded')
    assert.equal(pick('A8', 'empty-private/legacy', 'foreground').overTargetBy, 0)
    assert.equal(pick('A8', 'empty-private/legacy', 'lookupCalls').verdict, 'pass')
    assert.equal(pick('A8', 'empty-private/department-v2', 'foreground').verdict, 'recorded')
    assert.equal(pick('A8', 'empty-private/department-v2', 'foreground').overTargetBy, 1)
    assert.equal(pick('A8', 'empty-private/department-v2', 'lookupCalls').verdict, 'fail')
    assert.equal(pick('A8', 'shared-room/legacy', 'foreground').verdict, 'unmeasured')
    assert.equal(qualification.qualifying, false)
    assert.match(r.stderr, /3 over indicative foreground SQL target/)
    assert.match(readFileSync(join(run, 'results.md'), 'utf8'), /273 over indicative target/)
  })

  it('qualifies complete indicative counts above both targets and still rejects independent failures and missing counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm6-indicative-counts-'))
    mkdirSync(join(dir, 'steps'))
    const stepIds = ['fixed20-oss-counts', 'fixed20-hosted-counts', 'fixed20-oss-warm', 'fixed20-oss-lookup', 'transfer']
    const identity = { git: true, dirty: false, head: 'a'.repeat(40), diffSha256: 'b'.repeat(64), untrackedSha256: 'c'.repeat(64) }
    const run = { runId: 'indicative-counts', profile: 'full', steps: stepIds, source: {
      start: { oss: identity, platform: identity }, end: { oss: identity, platform: identity }, unchangedDuringRun: { oss: true, platform: true },
    } }
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run))
    function step(stepId, data) {
      const harness = join(dir, `${stepId}.json`)
      writeFileSync(harness, JSON.stringify(data))
      writeFileSync(join(dir, 'steps', `${stepId}.json`), JSON.stringify({ stepId, status: 'completed', outputs: { harness } }))
    }
    const sample = { scenario: 'empty-private', permissionModel: 'legacy', verified: true, queries: 71, outputEvents: 20, elapsedMs: 300,
      nestedSql: { nested: { calls: 1000 } }, turnTimings: { loop_started_at_ms: 250, post_ms: 20, flush_ms: 10 } }
    const lookup = { ...sample, workload: 'one-lookup', queries: 124, lookup: { calls: 1, providerRounds: 2 } }
    const transferChat = { textFrames: 20, receivedExact: true, sql: { statements: 82, overflow: { statements: 0, fingerprints: 0, frames: 0 } } }
    const warmSamples = Array.from({ length: 30 }, (_, sampleIndex) => ({ ...sample, sample: sampleIndex + 1 }))
    step('fixed20-oss-counts', { results: [sample] })
    step('fixed20-hosted-counts', { results: [sample] })
    step('fixed20-oss-warm', { results: [{ ...sample, warmup: true }, ...warmSamples] })
    step('fixed20-oss-lookup', { results: Array.from({ length: 20 }, () => lookup) })
    step('transfer', { chat: transferChat })
    function collect() {
      const result = spawnSync(process.execPath, [join(M6, 'collect.mjs'), '--run', dir], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).lines
    }
    let lines = collect()
    const find = (row, metric, variant) => lines.find(l => l.row === row && l.metric === metric &&
      (row === 'A6' ? l.cell === 'transferred' : l.cell === 'empty-private/legacy') && (variant === undefined || l.metricVariant === variant))
    const fg = ['A1', 'A2', 'A3', 'A6', 'A8'].map(row => find(row, 'foreground'))
    assert.deepEqual(fg.map(l => [l.after, l.target, l.overTargetBy, l.verdict]), [
      [71, 50, 21, 'recorded'], [71, 50, 21, 'recorded'], [71, 50, 21, 'recorded'],
      [82, 50, 32, 'recorded'], [124, 100, 24, 'recorded'],
    ])
    // Stub unrelated matrix outcomes so each selected collector result can decide qualification.
    const unrelated = ROWS.map(row => ({ row: row.id, verdict: 'pass' }))
    const qualify = (...results) => qualification(run, [...unrelated, ...results])
    assert.equal(qualify(...fg, find('A6', 'outputFrames'), find('A8', 'lookupCalls')).qualifying, true)

    step('fixed20-oss-counts', { results: [{ ...sample, outputEvents: 19 }] })
    step('fixed20-oss-warm', { results: [{ ...sample, queries: undefined }, ...warmSamples.slice(1)] })
    step('fixed20-oss-lookup', { results: Array.from({ length: 20 }, () => ({ ...lookup, elapsedMs: 600 })) })
    step('transfer', { chat: { ...transferChat, sql: { ...transferChat.sql, overflow: { statements: 1, fingerprints: 0, frames: 0 } } } })
    lines = collect()
    const failures = [
      [find('A1', 'outputFrames'), 'fail'],
      [find('A3', 'foreground'), 'unmeasured'],
      [find('A8', 'wallMs', 'p50 (M6 latency metric)'), 'fail'],
      [find('A6', 'foreground'), 'fail'],
    ]
    for (const [failure, expected] of failures) {
      assert.equal(failure.verdict, expected)
      assert.equal(qualify(...fg, failure).qualifying, false)
    }
    assert.equal(find('A3', 'foreground').after, 71)
    assert.match(find('A3', 'foreground').note, /29 of 30 samples/)
    assert.match(find('A6', 'foreground').note, /SQL accounting overflow/)
  })

  it('finds every transcribed baseline quote in its receipt when the platform tree is present', (t) => {
    const baseline = JSON.parse(readFileSync(join(M6, 'baseline.json'), 'utf8'))
    if (!existsSync(resolve(M6, '../../../../docs/plans'))) { t.skip('standalone OSS clone'); return }
    assert.deepEqual(verifyBaseline(baseline).failures, [])
  })
})
