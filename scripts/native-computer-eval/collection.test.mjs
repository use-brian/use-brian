import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { manifest, parseEvidence, evaluate, validateHeader } from './eval.mjs';
import { syntheticRows } from './synthetic-test-data.mjs';
import { schedule, scheduleDigest } from './schedule.mjs';
import { createRecorder } from './recorder.mjs';
import { collect, createEvidenceWriter } from './collection.mjs';
import { createSyntheticDriver } from './synthetic-driver.mjs';
import { createSyntheticSequentialDriver as createMainDriver } from './synthetic-sequential-driver.mjs';
const header = () => { const h = { ...syntheticRows()[0], version: 2, seed: 42 }; h.schedule = scheduleDigest(schedule(manifest, h.trials, h.seed)); return h; };
const task = () => ({ fixture: 'held-out-form-selection', lane: 'llm-ax', trial: 1 });
const clock = () => { let n = 0n; return () => n += 1000000n; };
const temp = fn => async () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-collection-'))); try { await fn(dir, join(dir, 'evidence.jsonl')); } finally { rmSync(dir, { recursive: true, force: true }); } };
async function setup(options = {}) {
  const h = header(), t = task(), session = await createSyntheticDriver(options).open(t, h);
  const recorder = createRecorder({ header: h, case: t, consent: session.consent, oracle: session.oracle, clock: clock() });
  return { h, t, session, recorder, hooks: recorder.hooks };
}

test('synthetic recorder measures sequential monotonic spans, known failed usage and independent oracle failure', async () => {
  const { session, recorder } = await setup({ success: false, failedAttempt: true, defect: true });
  await session.run(recorder.hooks);
  const run = await recorder.finalize(await session.attest());
  assert.equal(run.success, false); // Delivered receipt cannot make this true.
  assert.equal(run.steps[0].observationMs, 1);
  assert.equal(run.steps[0].decisionMs, 3);
  assert.equal(run.steps[0].attempts[0].latencyMs, 1);
  assert.equal(run.steps[0].attempts[0].outcome, 'failed');
  assert.equal(run.steps[0].attempts[0].incurredUsd, .001);
  assert.equal(run.wrongWindow, 1); assert.equal(run.interventions, 1);
  recorder.assertFinalized();
  assert.throws(() => recorder.hooks.event('screenshots'));
  assert.throws(() => recorder.assertFinalized());
});

test('overlap, reordering, duplicate attempt close, raw fields and count contradictions permanently poison recorder', async () => {
  for (const violate of [
    h => { h.beginSpan('decision'); },
    h => { h.beginSpan('observation'); h.beginSpan('observation'); },
    h => { h.beginAttempt({ kind: 'llm', keySource: 'workspace' }); },
    h => { h.beginSpan('observation')(); h.beginSpan('decision'); h.beginAttempt({ kind: 'llm', keySource: 'workspace' }); h.beginAttempt({ kind: 'llm', keySource: 'workspace' }); },
    h => { h.beginSpan('observation')(); h.beginSpan('decision'); const end = h.beginAttempt({ kind: 'llm', keySource: 'workspace' }); const u = { outcome: 'ok', usage: { inputTokens: 0, outputTokens: 0, incurredUsd: 0 } }; end(u); end(u); },
    h => { h.event('user-secret'); },
    h => { h.beginStep({ slot: 2, perception: 'ax', warmAx: true, raw: 'SECRET' }); },
  ]) {
    const { recorder, hooks } = await setup(); hooks.beginStep({ slot: 1, perception: 'ax', warmAx: true });
    assert.throws(() => violate(hooks));
    await assert.rejects(recorder.finalize({ evidenceComplete: true, attempts: 0, actions: 0 }));
  }
  for (const attestation of [{ evidenceComplete: true, attempts: 0, actions: 1 }, { evidenceComplete: true, attempts: 1, actions: 0 }, { evidenceComplete: false, attempts: 1, actions: 1 }, {}]) {
    const { recorder, session } = await setup(); await session.run(recorder.hooks);
    await assert.rejects(recorder.finalize(attestation));
  }
});

test('open spans/stops, clock reversal, unknown usage and absent consent cannot finalize', async () => {
  for (const open of [h => h.beginStop(), h => { h.beginStep({ slot: 2, perception: 'none', warmAx: false }); h.beginSpan('observation'); }]) {
    const { recorder, session } = await setup(); await session.run(recorder.hooks); open(recorder.hooks);
    await assert.rejects(recorder.finalize(await session.attest()));
  }
  const { recorder, session } = await setup({ unknownUsage: true, failedAttempt: true });
  await assert.rejects(session.run(recorder.hooks)); await assert.rejects(recorder.finalize(await session.attest()));
  const { h, t, session: s } = await setup();
  let n = 100n;
  const backwards = createRecorder({ header: h, case: t, consent: s.consent, oracle: s.oracle, clock: () => n-- });
  backwards.hooks.beginStep({ slot: 1, perception: 'ax', warmAx: true }); assert.throws(() => backwards.hooks.beginSpan('observation'));
  assert.throws(() => createRecorder({ header: h, case: t, consent: { ...s.consent, localConsent: false }, oracle: s.oracle }));
  assert.throws(() => createRecorder({ header: { ...h, source: 'live-attended' }, case: t, consent: s.consent, oracle: s.oracle, clock: clock() }));
});

test('seeded schedule covers all cases, preserves splits and counterbalances each six blocks', () => {
  const a = schedule(manifest, 3, 123), b = schedule(manifest, 3, 124);
  assert.deepEqual(a, schedule(manifest, 3, 123)); assert.notDeepEqual(a, b);
  assert.equal(new Set(a.map(r => JSON.stringify(r))).size, 405);
  const firstSix = a.slice(0, 18);
  for (let position = 0; position < 3; position++) for (const lane of manifest.lanes) assert.equal(firstSix.filter((r, i) => i % 3 === position && r.lane === lane).length, 2);
  assert.ok(a.slice(0, 135).every(r => r.fixture.startsWith('train-')));
  assert.throws(() => validateHeader({ ...header(), schedule: 'a'.repeat(64) }));
});

test('synthetic attended collection privately publishes exactly all runs; consumer accepts and retains safety defects', temp(async (dir, output) => {
  const result = await collect({ output, header: header(), driver: createSyntheticDriver({ defect: true }), attended: true, clock: clock() });
  assert.equal(result.runs, 135); assert.equal(result.routingProfileApproval, false);
  const evidence = parseEvidence(readFileSync(output, 'utf8'));
  assert.equal(evidence.runs.length, 135); assert.equal(evidence.header.version, 2);
  assert.equal(evaluate(evidence).gates.safety, false);
  assert.equal(evaluate(evidence).routingProfileApproval, false);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['evidence.jsonl']);
  const text = readFileSync(output, 'utf8');
  assert.throws(() => parseEvidence(text.trimEnd().split('\n').slice(0, -1).join('\n') + '\n'));
  assert.throws(() => parseEvidence(text.replace('"wrongWindow":1', '"wrongWindow":0')));
}));

test('crash before commit with ALL runs still leaves invalid public file AND invalid private journal', temp(async (dir, output) => {
  const h = header(), writer = createEvidenceWriter(output, h);
  const runs = syntheticRows().slice(1);
  for (const t of schedule(manifest, 1, h.seed)) writer.append(runs.find(r => r.fixture === t.fixture && r.lane === t.lane && r.trial === t.trial));
  writer.abandon();
  for (const f of readdirSync(dir)) {
    assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
    assert.throws(() => parseEvidence(readFileSync(join(dir, f), 'utf8')));
  }
  assert.throws(() => createEvidenceWriter(output, h));
}));

test('output refuses existing files, symlinks, missing rows, duplicate rows and concurrent reservations', temp(async (dir, output) => {
  const target = join(dir, 'target'); writeFileSync(target, 'preserve', { mode: 0o600 }); symlinkSync(target, output);
  assert.throws(() => createEvidenceWriter(output, header())); assert.equal(readFileSync(target, 'utf8'), 'preserve');
  rmSync(output); const writer = createEvidenceWriter(output, header());
  assert.throws(() => createEvidenceWriter(output, header()));
  assert.throws(() => writer.finalize()); writer.abandon();
  assert.throws(() => parseEvidence(readFileSync(output, 'utf8')));
  const writer2 = createEvidenceWriter(join(dir, 'other'), header());
  const first = schedule(manifest, 1, header().seed)[0];
  const row = syntheticRows().find(r => r.fixture === first.fixture && r.lane === first.lane);
  writer2.append(row); assert.throws(() => writer2.append(row)); assert.throws(() => writer2.finalize()); writer2.abandon();
}));

test('unknown usage, thrown driver and caller cancellation never publish invented rows; Stop is independent', temp(async (dir, output) => {
  await assert.rejects(collect({ output, header: header(), driver: createSyntheticDriver({ unknownUsage: true }), attended: true }));
  assert.throws(() => parseEvidence(readFileSync(output, 'utf8')));
  for (const mode of ['crash', 'cancel']) {
    const controller = new AbortController(), driver = createSyntheticDriver(); let stopped = false;
    driver.stop = () => { stopped = true; };
    const original = driver.open;
    driver.open = async (...args) => {
      const s = await original(...args);
      s.run = async () => { if (mode === 'crash') throw new Error('SENSITIVE'); queueMicrotask(() => controller.abort()); return new Promise(() => {}); };
      return s;
    };
    const path = join(dir, mode);
    await assert.rejects(collect({ output: path, header: header(), driver, attended: true, signal: controller.signal }), /Incomplete/);
    assert.equal(stopped, true); assert.throws(() => parseEvidence(readFileSync(path, 'utf8')));
  }
}));

test('collection CLI requires attended absolute trusted module and synthetic label; no raw errors', temp(async (dir, output) => {
  const cli = new URL('./collect.mjs', import.meta.url).pathname, driver = new URL('./synthetic-driver.mjs', import.meta.url).pathname;
  const config = join(dir, 'config.json'); writeFileSync(config, JSON.stringify(header()), { mode: 0o600 });
  const args = [cli, '--driver', driver, '--config', config, '--output', output];
  const run = extra => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run([]).status, 2); assert.equal(run(['--attended']).status, 2);
  const result = run(['--attended', '--synthetic']); assert.equal(result.status, 0, result.stderr);
  assert.equal(parseEvidence(readFileSync(output, 'utf8')).runs.length, 135);
  const rejected = run(['--attended', '--synthetic']); assert.equal(rejected.status, 2); assert.ok(!rejected.stderr.includes(dir));
}));

test('quarantined synthetic adapter refuses a live header', async () => {
  const driver = createMainDriver({ async requireLocalFixtureSession() { return { consent: {} }; }, stopLocalExecutionGate() {} });
  await assert.rejects(driver.open(task(), { ...header(), source: 'live-attended' }));
});


test('synthetic oracle raw properties, unknown counters and excessive Stop samples cannot become evidence', async () => {
  const { h, t, session } = await setup();
  for (const oracle of [
    { ...session.oracle, async selection() { return { selection: 'correct', title: 'RAW' }; } },
    { ...session.oracle, async task() { return { success: true, receipt: 'RAW' }; } },
  ]) {
    const r = createRecorder({ header: h, case: t, consent: session.consent, oracle, clock: clock() });
    await assert.rejects(async () => { await session.run(r.hooks); await r.finalize(await session.attest()); });
  }
  const { recorder } = await setup();
  for (let i = 0; i < 128; i++) recorder.hooks.beginStop()();
  assert.throws(() => recorder.hooks.beginStop());
});

test('pre-aborted or immediately cancelled collection never opens driver authority', temp(async (dir, output) => {
  for (const preAborted of [true, false]) {
    const controller = new AbortController(), driver = createSyntheticDriver(); let opened = false;
    driver.open = async () => { opened = true; throw new Error(); };
    if (preAborted) controller.abort();
    const operation = collect({ output: output + String(preAborted), header: header(), driver, attended: true, signal: controller.signal });
    if (!preAborted) controller.abort();
    await assert.rejects(operation);
    assert.equal(opened, false);
  }
}));
