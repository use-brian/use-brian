// SYNTHETIC producer runs through the ACTUAL core trace/schema; no OS/model work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NativeRunTrace, NativeTraceEventSchema, sourceContractDigest } from './source-contract.mjs';
import { createSourceIngestor, sourceLimits } from './source-ingestor.mjs';
import { createPassiveObserverAdapter } from './main-driver.mjs';
import { createSyntheticSequentialDriver } from './synthetic-sequential-driver.mjs';
import { createEvidenceWriter, collect } from './collection.mjs';
import { syntheticRows } from './synthetic-test-data.mjs';
import { schedule, scheduleDigest } from './schedule.mjs';
import { manifest } from './eval.mjs';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const invocation = () => ({ attemptId: randomUUID(), invocationState: 'pending', interrupted: false, requestedModel: 'private-model-alias', model: null, providerKind: 'other', lane: 'text', outcome: 'pending', operation: 'plan', stage: 'direct', perceptionPath: 'ax', fallbackReason: 'none', disposition: null, durationMs: 0, usage: null, incurredCostUsd: null, estimatedBilledCostUsd: null, providerKeySource: 'platform' });
function producer({ offset = 0, pending = false, rpc = false } = {}) {
  let now = offset; const trace = new NativeRunTrace(undefined, { clock: () => now });
  const span = rpc ? trace.startSpan('effect-rpc', 0, { commandId: randomUUID(), actionKind: 'invoke' }) : trace.startSpan('generation', 0);
  const initial = invocation(); if (!rpc) trace.recordInference(span.correlation, initial);
  now += 12; span.settle('fulfilled'); now += 3; trace.terminal('completed', 1);
  if (!rpc && !pending) trace.recordInference(span.correlation, { ...initial, invocationState: 'settled', outcome: 'ok', model: 'actual-private-model', providerKind: 'openai', durationMs: 57, usage: { inputTokens: 3, outputTokens: 2 }, incurredCostUsd: .002, estimatedBilledCostUsd: .001 });
  return { trace, span, initial, events: trace.snapshot().events };
}
const feed = (s, events) => { for (const e of events) assert.equal(s.ingest(e), true, e.kind); };

test('actual core strict schema is used; source digest identifies exact repository source', () => {
  const { events } = producer();
  assert.match(sourceContractDigest, /^[a-f0-9]{64}$/);
  for (const e of events) assert.equal(NativeTraceEventSchema.safeParse(e).success, true);
  const sink = createSourceIngestor(); feed(sink, events);
  assert.equal(sink.diagnostics().sourceContractDigest, sourceContractDigest);
  assert.equal(sink.diagnostics().state, 'incomplete');
  assert.throws(() => sink.assertPublishable(), /publication refused/);
});

test('different source clocks and very delayed callbacks never become arrival timing or local dispatch', async () => {
  const a = producer({ offset: 900000, rpc: true }), b = producer({ offset: 1 });
  await new Promise(resolve => setTimeout(resolve, 40));
  const sink = createSourceIngestor(), original = Date.now;
  Date.now = () => { throw new Error('Arrival clock forbidden'); };
  try { feed(sink, a.events); feed(sink, b.events); } finally { Date.now = original; }
  const d = sink.diagnostics(); assert.equal(d.streams.length, 2);
  for (const r of d.streams) { assert.equal(r.sourceRunDurationMs, 15); assert.equal(r.spans[0].settled.durationMs, 12); }
  assert.equal(d.streams[0].spans[0].scope, 'rpc'); assert.equal(d.streams[0].spans[0].phase, 'effect-rpc');
  assert.equal(d.streams[1].invocations[0].durationMs, 57);
  assert.equal(d.streams[1].invocations[0].scope, 'adapter-lifecycle');
  assert.equal(d.fixtureSuccess, null); assert.equal(d.drain, 'not_observed');
  assert.equal(d.publicationAllowed, false);
});

test('pending inference survives logical completed and late settlement upserts, not double-counts', () => {
  const p = producer({ pending: true }), sink = createSourceIngestor(); feed(sink, p.events);
  assert.equal(sink.diagnostics().streams[0].logicalTerminal, 'completed');
  assert.equal(sink.diagnostics().streams[0].pendingInvocations, 1);
  p.trace.recordInference(p.span.correlation, { ...p.initial, invocationState: 'settled', outcome: 'failed', interrupted: true, durationMs: 500, usage: { inputTokens: 8, outputTokens: 0 }, estimatedBilledCostUsd: 0 });
  assert.equal(sink.ingest(p.trace.snapshot().events.at(-1)), true);
  const r = sink.diagnostics().streams[0];
  assert.equal(r.pendingInvocations, 0); assert.equal(r.invocations.length, 1); assert.equal(r.invocations[0].late, true);
  assert.equal(r.invocations[0].usage.inputTokens, 8); assert.equal(r.invocations[0].incurredCostUsd, null);
  assert.equal(r.unknownSettledUsage, 1); assert.equal(sink.diagnostics().state, 'incomplete');
});

test('conflicting settled model/usage and duplicate settled updates permanently poison', () => {
  for (const mutate of [e => { e.inference.model = 'conflicting-model'; }, e => { e.inference.usage.inputTokens = 999; }, () => {}]) {
    const p = producer(), sink = createSourceIngestor(); feed(sink, p.events);
    const last = structuredClone(p.events.at(-1)); last.sequence++; mutate(last);
    assert.equal(NativeTraceEventSchema.safeParse(last).success, true);
    assert.equal(sink.ingest(last), false); assert.equal(sink.diagnostics().state, 'poisoned');
    assert.equal(sink.diagnostics().streams[0].invocations[0].usage.inputTokens, 3);
  }
});

test('missing, duplicate, out-of-order, command/span/clock identity and source-duration errors reject', () => {
  const p = producer({ rpc: true });
  for (const mutate of [
    a => a.splice(1, 1), a => a.splice(1, 0, a[0]), a => { [a[1], a[2]] = [a[2], a[1]]; },
    a => { a[2].clockId = randomUUID(); }, a => { a[2].spanId = randomUUID(); },
    a => { a[2].commandId = randomUUID(); }, a => { a[2].durationMs++; },
    a => { a[2].atMs = 0; }, a => { a[3].durationMs++; },
  ]) {
    const rows = structuredClone(p.events); mutate(rows); const sink = createSourceIngestor();
    for (const row of rows) sink.ingest(row);
    assert.equal(sink.diagnostics().state, 'poisoned');
  }
  const p2 = producer(), sink = createSourceIngestor();
  const firstSettled = p2.events.at(-1); // Cannot admit a settled attempt without its pending record.
  const rows = p2.events.filter(e => e.kind !== 'inference-update');
  rows.forEach((e, i) => sink.ingest({ ...e, sequence: i + 1 }));
  assert.equal(sink.ingest({ ...firstSettled, sequence: rows.length + 1 }), false);
});

test('actual core poison and late external safety invalidate after logical terminal', () => {
  const p = producer(), sink = createSourceIngestor(); feed(sink, p.events);
  p.trace.invalidate('invalid_metadata'); assert.equal(sink.ingest(p.trace.snapshot().events.at(-1)), false);
  assert.ok(sink.diagnostics().poisonReasons.includes('source-poison'));
  sink.invalidate('safety-defect'); assert.ok(sink.diagnostics().poisonReasons.includes('safety-defect'));
  const s = createSourceIngestor(); feed(s, producer().events); s.endInput();
  assert.equal(s.ingest(producer().events[0]), false); assert.ok(s.diagnostics().poisonReasons.includes('late-event'));
});

test('no raw data/errors/model strings emitted; immutable snapshots; bounded memory', () => {
  for (const mutate of [e => { e.raw = 'SENTINEL-SECRET'; }, e => { e.phase = 'SENTINEL-SECRET'; }, e => { e.inference.requestedModel = 'https://SENTINEL-SECRET'; }]) {
    const e = structuredClone(producer().events.find(e => e.kind === 'inference-update')); mutate(e);
    const sink = createSourceIngestor(); assert.equal(sink.ingest(e), false);
    assert.ok(!JSON.stringify(sink.diagnostics()).includes('SENTINEL'));
  }
  const s = createSourceIngestor(); feed(s, producer().events);
  const d = s.diagnostics(); assert.ok(!JSON.stringify(d).includes('private-model'));
  assert.throws(() => { d.streams[0].invocations[0].usage.inputTokens = 99; });
  const overflow = createSourceIngestor();
  for (let i = 0; i <= sourceLimits.runs; i++) for (const e of producer().events) overflow.ingest(e);
  assert.equal(overflow.diagnostics().streams.length, sourceLimits.runs); assert.ok(overflow.diagnostics().poisonReasons.includes('overflow'));
  const huge = createSourceIngestor(); assert.equal(huge.ingestJSON('x'.repeat(sourceLimits.eventBytes + 1)), false);
  const duplicate = createSourceIngestor(); assert.equal(duplicate.ingestJSON('{"version":1,"version":1}'), false);
  let read = false; const accessor = { get version() { read = true; return 1; } };
  const rejected = createSourceIngestor(); assert.equal(rejected.ingest(accessor), false); assert.equal(read, false);
});

test('passive API observer binding calls no execution loop and never interprets completed as drain', async () => {
  const binding = { sessionId: randomUUID(), epoch: 3 }; let attached = 0, stopped = 0, detached = 0, executed = 0;
  const adapter = createPassiveObserverAdapter({ binding, stopLocalExecutionGate() { stopped++; } });
  await adapter.attach({
    async attachObserver(b, factory) {
      assert.deepEqual(b, binding); attached++;
      const observer = factory(b); for (const event of producer().events) observer(event);
      return { detach() { detached++; } };
    },
    nextStep() { executed++; }, observe() { executed++; }, decide() { executed++; }, dispatch() { executed++; }, verify() { executed++; },
  });
  assert.equal(attached, 1); assert.equal(executed, 0); assert.equal(stopped, 0);
  for (const name of ['open', 'run', 'nextStep', 'observe', 'decide', 'dispatch', 'verify']) assert.equal(adapter[name], undefined);
  assert.equal(adapter.diagnostics().fixtureSuccess, null); assert.throws(() => adapter.assertPublishable());
  adapter.invalidate('safety-defect'); assert.equal(adapter.diagnostics().state, 'poisoned');
  adapter.detach(); await nextTurn(); assert.equal(detached, 1); assert.equal(stopped, 0);
});

test('unrelated global bindings are ignored; a second API-owned run still poisons', () => {
  const binding = { sessionId: randomUUID(), epoch: 3 };
  for (const change of [b => ({ ...b, epoch: 4 }), b => ({ ...b, sessionId: randomUUID() })]) {
    const a = createPassiveObserverAdapter({ binding, stopLocalExecutionGate() { throw new Error('Must not auto-stop on metadata'); } });
    assert.equal(a.observerFactory(change(binding)), undefined); assert.equal(a.diagnostics().state, 'incomplete');
    assert.equal(typeof a.observerFactory(binding), 'function');
  }
  const a = createPassiveObserverAdapter({ binding, stopLocalExecutionGate() {} });
  const observe = a.observerFactory(binding); for (const e of producer().events) observe(e); for (const e of producer().events) observe(e);
  assert.equal(a.diagnostics().state, 'poisoned');
});

test('cancel during passive attach stops independently and detaches late subscription once; no second run', async () => {
  const pending = deferred(), entered = deferred(), controller = new AbortController(); let stops = 0, detaches = 0;
  const adapter = createPassiveObserverAdapter({ binding: { sessionId: randomUUID(), epoch: 1 }, stopLocalExecutionGate() { stops++; } });
  const attaching = adapter.attach({ attachObserver() { entered.resolve(); return pending.promise; } }, controller.signal);
  await entered.promise; controller.abort(); await assert.rejects(attaching, /^Error: Passive source observation incomplete$/);
  pending.resolve({ detach() { detaches++; throw new Error('SENTINEL-ERROR'); } });
  await nextTurn(); await nextTurn(); assert.equal(stops, 1); assert.equal(detaches, 1);
  assert.equal(adapter.diagnostics().state, 'poisoned'); assert.ok(!JSON.stringify(adapter.diagnostics()).includes('SENTINEL'));
});

test('live publication and quarantined second-planner adapter refuse before execution/file creation', async () => {
  const h = { ...syntheticRows()[0], version: 2, source: 'live-attended', seed: 42 }; h.schedule = scheduleDigest(schedule(manifest, h.trials, h.seed));
  let calls = 0; const output = '/not-created-source-evidence.jsonl';
  assert.throws(() => createEvidenceWriter(output, h));
  await assert.rejects(collect({ output, header: h, attended: true, driver: { source: 'live-attended', open() { calls++; }, stop() {} } }));
  const old = createSyntheticSequentialDriver({ requireLocalFixtureSession() { calls++; } });
  await assert.rejects(old.open({}, h)); assert.equal(calls, 0);
});

test('source diagnostics CLI emits metadata only and never exit 0 or accepted release evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-source-')), path = join(dir, 'events.jsonl');
  try {
    writeFileSync(path, producer().events.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    const cli = new URL('./source-diagnostics.mjs', import.meta.url).pathname;
    const r = spawnSync(process.execPath, [cli, path], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr); assert.equal(JSON.parse(r.stdout).publicationAllowed, false);
    writeFileSync(path, '{"raw":"SENTINEL-SECRET"}');
    const bad = spawnSync(process.execPath, [cli, path], { encoding: 'utf8' });
    assert.equal(bad.status, 2); assert.ok(!(bad.stdout + bad.stderr).includes('SENTINEL'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('historical live metadata may be inspected but cannot receive successful publication exit/status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-live-refusal-')), path = join(dir, 'legacy.jsonl');
  try {
    const rows = syntheticRows(); rows[0].source = 'live-attended';
    writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    const cli = new URL('./cli.mjs', import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.livePublicationSupported, false); assert.equal(report.publicationAllowed, false);
    assert.equal(report.routingProfileApproval, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ['api', 'broker', 'helper']) {
  for (const reason of ['capacity', 'timeout', 'source_loss', 'expired', 'detached', 'invalid_metadata', 'factory_failed', 'callback_failed']) {
    test(`${kind} attachment ${reason} poisons a previously valid prefix`, async () => {
      const binding = { sessionId: randomUUID(), epoch: 1 };
      const adapter = createPassiveObserverAdapter({ binding, stopLocalExecutionGate() {} });
      const sink = adapter.observerFactory(binding);
      for (const event of producer().events) sink(event);
      let failure = null;
      const attachment = { detach() {}, health: () => ({ state: 'incomplete', reason: failure, drain: 'not_observed' }) };
      if (kind === 'api') await adapter.attach({ attachObserver: async () => attachment });
      if (kind === 'broker') await adapter.attachBroker({ attachBrokerObserver: async () => attachment });
      if (kind === 'helper') await adapter.attachHelper({ attachHelperTimingObserver: async () => attachment });
      assert.equal(adapter.diagnostics().state, 'incomplete');
      failure = reason;
      const d = adapter.diagnostics();
      assert.equal(d.state, 'poisoned');
      assert.ok(d.poisonReasons.includes(`attachment:${kind}:${reason}`));
      assert.equal(d.publicationAllowed, false);
      assert.equal(d.drain, 'not_observed');
      assert.throws(() => adapter.assertPublishable());
      failure = null;
      assert.equal(adapter.diagnostics().state, 'poisoned');
    });
  }
}
test('health is diagnostics-only, rejects getters/extras/async/throws without raw content; legacy stays unknown', async () => {
  let reads = 0;
  const canonical = { state: 'incomplete', reason: null, drain: 'not_observed' };
  for (const port of [undefined, () => ({ ...canonical, private: 'secret' }), () => Promise.resolve(canonical), () => Promise.reject(Error('secret')), () => { throw Error('secret'); }, () => Object.defineProperty({ ...canonical }, 'reason', { get() { reads++; return 'secret'; } }), 'accessor']) {
    const adapter = createPassiveObserverAdapter({ binding: { sessionId: randomUUID(), epoch: 1 }, stopLocalExecutionGate() {} });
    const attachment = { detach() {} };
    if (port === 'accessor') Object.defineProperty(attachment, 'health', { get() { reads++; return () => canonical; } });
    else if (port) attachment.health = port;
    await adapter.attach({ attachObserver: async () => attachment });
    const d = adapter.diagnostics();
    assert.equal(d.state, port ? 'poisoned' : 'incomplete');
    assert.equal(d.attachmentHealth[0].status, 'unknown');
    assert.equal(JSON.stringify(d).includes('secret'), false);
    adapter.stop();
  }
  assert.equal(reads, 0);
  const adapter = createPassiveObserverAdapter({ binding: { sessionId: randomUUID(), epoch: 1 }, stopLocalExecutionGate() {} });
  await adapter.attach({ attachObserver: async () => ({ detach() {}, health() { reads++; return canonical; } }) });
  adapter.stop(); assert.equal(reads, 0);
});
