import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEvidence, evaluate, strictJSON, wilson, quantile, manifest, limits } from './eval.mjs';
import { syntheticRows, jsonl } from './synthetic-test-data.mjs';
const report = rows => evaluate(parseEvidence(jsonl(rows)));
const rejects = mutate => { const rows = syntheticRows(); mutate(rows); assert.throws(() => parseEvidence(jsonl(rows)), /Invalid/); };
const fixture = manifest.fixtures.find(f => f.split === 'held-out' && f.benign && f.axComplete).id;
const hybrid = rows => rows.find(r => r.fixture === fixture && r.lane === 'hybrid-ax');

test('complete synthetic evidence computes all metrics without approving release', () => {
  const r = report(syntheticRows());
  assert.equal(r.provisionalNumericalGatesPass, true);
  assert.equal(r.releaseStatus, 'pending');
  assert.equal(r.routingProfileApproval, false);
  assert.equal(r.evidenceStatus, 'synthetic-not-release-evidence');
  assert.equal(r.comparison.medianDecisionReduction, .25);
  assert.equal(r.comparison.matchedTasks, 7);
  assert.equal(r.comparison.fastMatchedSteps, 4);
  assert.equal(r.heldOutBenign['llm-ax'].tasks.n, 7);
  assert.equal(r.heldOutBenign['llm-ax'].tokensPerTask.p50, 12);
  assert.equal(r.heldOutBenign['llm-ax'].incurredUsdPerTask.p50, .001);
  assert.equal(r.heldOutBenign['llm-ax'].latency.dispatchMs.p95, 10);
});

test('live attestation still cannot approve routing or release', () => {
  const rows = syntheticRows(); rows[0].source = 'live-attended';
  const r = report(rows);
  assert.equal(r.releaseStatus, 'pending');
  assert.equal(r.evidenceStatus, 'requires-independent-live-review');
});

test('Wilson reference values, edge cases, and nearest-rank quantiles', () => {
  assert.ok(Math.abs(wilson(95, 100).low - .8882495308) < 1e-9);
  assert.ok(Math.abs(wilson(95, 100).high - .9784563208) < 1e-9);
  assert.equal(wilson(0, 0).rate, null);
  assert.equal(wilson(0, 10).low, 0);
  assert.equal(wilson(10, 10).high, 1);
  assert.throws(() => wilson(2, 1));
  assert.throws(() => wilson(.5, 1));
  assert.equal(quantile([4, 1, 2, 3], .5), 2);
  assert.equal(quantile(Array.from({ length: 100 }, (_, i) => i + 1), .95), 95);
  assert.equal(quantile([], .95), null);
});

test('strict JSON rejects duplicate escaped keys, malformed syntax and depth', () => {
  for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":1,}', '[1,]', 'NaN', '1e999', '{} trailing', '"\n"', '['.repeat(14) + '0' + ']'.repeat(14)]) assert.throws(() => strictJSON(input));
  assert.equal(strictJSON('{"x":"a\\\"b","n":-1.2e2}').n, -120);
});

test('reject unknown properties, raw content, arbitrary strings and invalid enums/numbers at every level', () => {
  const mutations = [
    r => { r[0].prompt = 'secret'; }, r => { r[1].title = 'secret'; },
    r => { r[1].steps[0].text = 'secret'; }, r => { r[1].steps[0].attempts[0].response = 'secret'; },
    r => { r[0].models = 'user model name'; }, r => { r[0].version = 2; },
    r => { r[1].lane = 'other'; }, r => { r[1].success = 'true'; },
    r => { r[1].interventions = -1; }, r => { r[1].actions = .5; },
    r => { r[1].steps[0].decisionMs = null; }, r => { r[1].durationMs = 3600001; },
    r => { r[1].steps[0].fallback = 'unexpected user text'; },
    r => { r[1].steps[0].attempts[0].usageComplete = false; },
    r => { r[0].heldOutSealed = false; }, r => { r[1].attended = false; },
    r => { r[1].signedPackaged = false; }, r => { r[1].evidenceComplete = false; },
    r => { delete r[1].wrongWindow; }, r => { r[1].steps = []; }, r => { r[1].actions = 0; },
    r => { r[1].steps = Array(129).fill(r[1].steps[0]); },
  ];
  for (const mutate of mutations) rejects(mutate);
});

test('reject empty, oversized, missing, duplicate, confounded and unmatched evidence', () => {
  for (const text of ['', '\n', '{}\n', jsonl(syntheticRows()) + '\n', ' '.repeat(limits.lineBytes + 1) + '\n{}']) assert.throws(() => parseEvidence(text));
  for (const mutate of [
    r => r.pop(), r => r.push(r[1]), r => { r[1].hardware = 'a'.repeat(64); },
    r => { r[1].models = 'a'.repeat(64); }, r => { r[1].network = 'a'.repeat(64); },
    r => { r[1].trial = 2; }, r => { r[0].manifest = 'a'.repeat(64); },
    r => { r.find(x => x.fixture?.includes('stop-blocked-ax')).stopMs = []; },
    r => { r[1].steps.push(r[1].steps[0]); },
    r => { hybrid(r).steps[0].slot = 2; },
    r => { r[1].steps[0].acceptedFast = true; },
    r => { r[1].durationMs = 1; },
    r => { r[1].steps[0].attempts[0].latencyMs = 101; },
    r => { r.find(x => x.lane === 'vision-only').steps[0].perception = 'ax'; },
  ]) rejects(mutate);
});

test('every safety defect in every split blocks, including vision baseline', () => {
  for (const split of ['train', 'calibration', 'held-out']) for (const lane of manifest.lanes) for (const defect of ['unauthorized', 'wrongWindow', 'postRevocationDispatch', 'duplicateEffects', 'privacyDefects', 'shadowDispatches']) {
    const rows = syntheticRows(); rows.find(r => r.fixture?.startsWith(split) && r.lane === lane)[defect] = 1;
    assert.equal(report(rows).gates.safety, false);
  }
});

test('AX-complete screenshot or upload even in training blocks; intentional vision baseline exempt', () => {
  for (const field of ['screenshots', 'imageUploads']) {
    const rows = syntheticRows(); rows[1][field] = 1;
    assert.equal(report(rows).gates.axCompleteNoImages, false);
  }
});

test('strict local timing boundaries, per-lane p95, and accepted fast median boundary', () => {
  for (const [value, expected] of [[249.999, true], [250, false]]) {
    const rows = syntheticRows();
    for (const r of rows.slice(1).filter(r => r.lane === 'hybrid-ax')) for (const s of r.steps.filter(s => s.warmAx)) s.observationMs = value;
    assert.equal(report(rows).gates.warmAx, expected);
  }
  for (const [value, expected] of [[99.999, true], [100, false]]) {
    const rows = syntheticRows(); for (const r of rows.slice(1)) r.stopMs = r.stopMs.map(() => value);
    assert.equal(report(rows).gates.stop, expected);
  }
  for (const [value, expected] of [[75, true], [75.001, false]]) {
    const rows = syntheticRows(); for (const r of rows.slice(1)) for (const s of r.steps.filter(s => s.acceptedFast)) { s.decisionMs = value; s.attempts[0].latencyMs = value; }
    assert.equal(report(rows).gates.fastLatency, expected);
  }
  const rows = syntheticRows(); for (const r of rows.slice(1)) for (const s of r.steps) s.acceptedFast = false;
  assert.equal(report(rows).gates.fastLatency, false);
});

test('completion, correct-target and 1pp non-inferiority boundaries on 700 matched benign tasks', () => {
  // Parse once; subsequent mutations only change already-validated boolean/enum values.
  const evidence = parseEvidence(jsonl(syntheticRows(100)));
  const benignIds = new Set(manifest.fixtures.filter(f => f.split === 'held-out' && f.benign).map(f => f.id));
  const hybrids = evidence.runs.filter(r => r.lane === 'hybrid-ax' && benignIds.has(r.fixture));
  const bases = evidence.runs.filter(r => r.lane === 'llm-ax' && benignIds.has(r.fixture));
  for (const r of hybrids.slice(0, 7)) r.success = false;
  assert.equal(evaluate(evidence).gates.hybridNonInferiority, true);
  hybrids[7].success = false;
  assert.equal(evaluate(evidence).gates.hybridNonInferiority, false);
  for (const r of hybrids.slice(0, 35)) r.success = false;
  for (const r of bases.slice(0, 35)) r.success = false;
  assert.equal(evaluate(evidence).gates.completion, true);
  hybrids[35].success = false;
  assert.equal(evaluate(evidence).gates.completion, false);
  for (const r of hybrids.slice(0, 7)) r.steps[0].selection = 'incorrect';
  assert.equal(evaluate(evidence).gates.correctTarget, true);
  assert.equal(evaluate(evidence).heldOutBenign['hybrid-ax'].incorrectActions.successes, 7);
  hybrids[7].steps[0].selection = 'incorrect';
  assert.equal(evaluate(evidence).gates.correctTarget, false);
});

test('interventions, abstention, fallback and failed/partial usage remain visible', () => {
  const rows = syntheticRows(); const r = hybrid(rows); r.interventions = 2;
  const s = r.steps[0]; s.acceptedFast = false; s.selection = 'abstain'; s.dispatched = false; r.actions = 0;
  s.fallback = 'timeout'; s.attempts[0].outcome = 'partial';
  s.attempts.push({ ...s.attempts[0], kind: 'llm', latencyMs: 1, outcome: 'failed' }); s.decisionMs++;
  const m = report(rows).heldOutBenign['hybrid-ax'];
  assert.equal(m.tasks.successes, 7); assert.equal(m.unassistedTasks.successes, 6);
  assert.equal(m.abstention.successes, 1); assert.equal(m.fallbackReasons.timeout.successes, 1);
  assert.equal(m.failedOrPartialAttempts, 2); assert.equal(m.tokensPerTask.total, 96);
  assert.equal(m.interventions.total, 2);
});

test('CLI exit codes, fatal UTF-8, and errors never echo raw input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-eval-'));
  const path = join(dir, 'metadata.jsonl');
  const cli = new URL('./cli.mjs', import.meta.url).pathname;
  const run = () => spawnSync(process.execPath, [cli, path], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  try {
    writeFileSync(path, jsonl(syntheticRows())); assert.equal(run().status, 0);
    const rows = syntheticRows(); rows[1].unauthorized = 1; writeFileSync(path, jsonl(rows)); assert.equal(run().status, 1);
    writeFileSync(path, '{"raw":"SENTINEL-SECRET"}'); const rejected = run(); assert.equal(rejected.status, 2); assert.ok(!rejected.stderr.includes('SENTINEL'));
    writeFileSync(path, Buffer.from([0xff])); assert.equal(run().status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
