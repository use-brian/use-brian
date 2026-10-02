// Synthetic metadata through the canonical shared helper DTO/core producer.
// No native helper, OS action, grant, model or second execution path is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HelperTimingSchema, HelperTimingEventSchema, NativeRunTrace, helperContractDigest } from './source-contract.mjs';
import { createHelperTimingIngestor, helperLimits, parseHelperCallback } from './helper-ingestor.mjs';
import { createPassiveObserverAdapter } from './main-driver.mjs';
const binding = () => ({ sessionId: randomUUID(), epoch: 7 });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function metadata(b, commandId = randomUUID(), changes = {}) {
  const requestId = randomUUID();
  return {
    requestId, method: 'execute', correlation: { ...b, commandId }, droppedBefore: 0, state: 'complete',
    timing: { version: 1, instanceId: randomUUID(), clockId: randomUUID(), requestId, method: 'execute', spans: [
      { phase: 'request', startUs: 1000000010, endUs: 1000000060, durationUs: 50, status: 'returned' },
      { phase: 'api_invoke', startUs: 1000000020, endUs: 1000000040, durationUs: 20, status: 'returned' },
    ] },
    ...changes,
  };
}
function core(commandId, { kind = 'invoke', start = 8, duration = 3 } = {}) {
  let now = start;
  const trace = new NativeRunTrace(undefined, { clock: () => now });
  trace.startSpan(kind === 'observe' ? 'observation-rpc' : kind === 'capture' ? 'capture-rpc' : 'effect-rpc', 1, { commandId, actionKind: kind }).settle('fulfilled');
  // Both source domains deliberately have very different origins and units.
  now += duration; trace.terminal('completed', 1);
  return trace.snapshot().events;
}
function setup() {
  const b = binding(), channel = randomUUID(), s = createHelperTimingIngestor({ binding: b });
  assert.equal(s.openChannel(channel), true);
  return { b, channel, s };
}

test('canonical DTO validates nested microsecond intervals; helper-first delayed join preserves original IDs', async () => {
  const { b, channel, s } = setup(), commandId = randomUUID(), event = metadata(b, commandId);
  assert.equal(HelperTimingSchema.safeParse(event.timing).success, true);
  assert.equal(s.ingest(channel, event), true);
  assert.equal(s.diagnostics().unmatchedHelperRequests, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  for (const e of core(commandId)) assert.equal(s.ingestCore(e), true);
  const d = s.diagnostics(), row = d.rows[0];
  assert.equal(d.unmatchedHelperRequests, 0); assert.equal(d.unmatchedApiCommands, 0);
  assert.deepEqual(row.correlation, { ...b, commandId });
  assert.equal(row.core.commandId, commandId); assert.equal(row.core.sessionId, b.sessionId); assert.equal(row.core.epoch, 7);
  assert.equal(row.source.unit, 'microseconds'); assert.equal(row.source.spans[0].durationUs, 50);
  assert.equal(row.source.spans[1].durationUs, 20); assert.notEqual(row.core.clockId, row.source.clockId);
  assert.equal(d.helperContractDigest, helperContractDigest);
  assert.equal(row.nonDispatch, null); assert.equal(row.osDelivery, null); assert.equal(row.targetMutation, null);
  assert.equal(d.drain, 'not_observed'); assert.equal(d.fixtureSuccess, null); assert.equal(d.publicationAllowed, false);
  assert.throws(() => s.assertPublishable(), /refused/);
});

test('API-first helper response arriving after terminal remains source timing, never callback duration', async () => {
  const { b, channel, s } = setup(), command = randomUUID();
  for (const e of core(command, { start: 99000000 })) s.ingestCore(e);
  assert.equal(s.diagnostics().apiLogicalTerminals, 1); assert.equal(s.diagnostics().unmatchedApiCommands, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  const original = Date.now; Date.now = () => { throw new Error('Arrival clock forbidden'); };
  try { assert.equal(s.ingest(channel, metadata(b, command)), true); } finally { Date.now = original; }
  assert.equal(s.diagnostics().rows[0].source.spans[0].durationUs, 50);
  assert.equal(s.diagnostics().state, 'incomplete');
});

test('missing nested API span proves neither non-dispatch nor failed mutation', () => {
  const { b, channel, s } = setup(), event = metadata(b); event.timing.spans.pop();
  for (const e of core(event.correlation.commandId)) s.ingestCore(e);
  assert.equal(s.ingest(channel, event), true);
  const d = s.diagnostics(); assert.equal(d.missingApiSpans, 1); assert.equal(d.rows[0].apiSpanObserved, false);
  for (const field of ['nonDispatch', 'osDelivery', 'targetMutation']) assert.equal(d.rows[0][field], null);
  assert.equal(d.state, 'incomplete'); assert.equal(d.publicationAllowed, false);
});

test('absent and lost_response remain missing evidence even after logical completed, never zero timings', () => {
  for (const reason of ['absent', 'lost_response']) {
    const { b, channel, s } = setup(), command = randomUUID();
    for (const e of core(command)) s.ingestCore(e);
    const e = { requestId: randomUUID(), method: 'execute', correlation: { ...b, commandId: command }, droppedBefore: 0, state: 'incomplete', reason };
    assert.equal(s.ingest(channel, e), true);
    const d = s.diagnostics(); assert.equal(d.incomplete[reason], 1); assert.equal(d.rows[0].source, null);
    assert.equal(d.rows[0].osDelivery, null); assert.equal(d.rows[0].nonDispatch, null);
    assert.equal(d.apiLogicalTerminals, 1); assert.equal(d.state, 'incomplete');
  }
});

test('late droppedBefore and invalid metadata reports poison while retaining loss counters', () => {
  for (const [reason, droppedBefore] of [['absent', 5], ['invalid', 0]]) {
    const { b, channel, s } = setup(), command = randomUUID(); for (const e of core(command)) s.ingestCore(e);
    assert.equal(s.ingest(channel, { requestId: randomUUID(), method: 'execute', correlation: { ...b, commandId: command }, droppedBefore, state: 'incomplete', reason }), false);
    const d = s.diagnostics(); assert.equal(d.state, 'poisoned'); assert.equal(d.droppedBeforeTotal, droppedBefore); assert.equal(d.incomplete[reason], 1);
    assert.equal(d.rows[0].source, null); assert.equal(d.publicationAllowed, false);
  }
});

test('independent helper channels use independent clock domains; changing or reversing one channel rejects', () => {
  for (const change of ['clock', 'instance', 'backwards']) {
    const { b, channel, s } = setup(), first = metadata(b); assert.equal(s.ingest(channel, first), true);
    const next = metadata(b); next.timing.instanceId = first.timing.instanceId; next.timing.clockId = first.timing.clockId;
    for (const span of next.timing.spans) { span.startUs += 100; span.endUs += 100; }
    if (change === 'clock') next.timing.clockId = randomUUID();
    if (change === 'instance') next.timing.instanceId = randomUUID();
    if (change === 'backwards') for (const span of next.timing.spans) { span.startUs -= 100; span.endUs -= 100; }
    assert.equal(s.ingest(channel, next), false); assert.ok(s.diagnostics().poisonReasons.includes('source-clock'));
  }
  const { b, channel, s } = setup(), a = metadata(b), other = randomUUID();
  assert.equal(s.ingest(channel, a), true); assert.equal(s.openChannel(other), true);
  const small = metadata(b); for (const span of small.timing.spans) { span.startUs -= 1000000000; span.endUs -= 1000000000; }
  assert.equal(s.ingest(other, small), true); assert.equal(s.diagnostics().state, 'incomplete');
});

test('correlation, phases, duplicate requests, nested durations and raw envelope content reject privately', () => {
  for (const mutate of [
    e => { e.correlation.sessionId = randomUUID(); }, e => { e.correlation.epoch++; },
    e => { e.correlation.commandId = 'RAW-SECRET'; }, e => { e.method = 'observe'; },
    e => { e.timing.requestId = randomUUID(); }, e => { e.timing.method = 'start'; },
    e => { e.timing.spans[0].durationUs++; }, e => { e.timing.spans[1].endUs += 999; e.timing.spans[1].durationUs += 999; },
    e => { e.timing.raw = 'RAW-SECRET'; }, e => { e.raw = 'RAW-SECRET'; },
    e => { e.droppedBefore = 65536; }, e => { e.correlation.target = 'RAW-SECRET'; },
  ]) {
    const { b, channel, s } = setup(), e = metadata(b); mutate(e);
    assert.equal(s.ingest(channel, e), false); assert.equal(s.diagnostics().state, 'poisoned');
    assert.ok(!JSON.stringify(s.diagnostics()).includes('RAW-SECRET'));
  }
  const { b, channel, s } = setup(), e = metadata(b); assert.equal(s.ingest(channel, e), true);
  assert.equal(s.ingest(channel, e), false); assert.ok(s.diagnostics().poisonReasons.includes('duplicate-request'));
  const f = setup(), mismatched = metadata(f.b); f.s.ingest(f.channel, mismatched);
  for (const e of core(mismatched.correlation.commandId, { kind: 'select' })) f.s.ingestCore(e);
  assert.ok(f.s.diagnostics().poisonReasons.includes('source-phase'));
});

test('uncorrelated startup timings remain unjoined; callback undefined correlation is supported', () => {
  const { b, channel, s } = setup(), e = metadata(b, undefined, { method: 'capabilities', correlation: undefined });
  e.timing.method = 'capabilities'; e.timing.spans.pop();
  assert.equal(s.ingest(channel, e), true);
  const row = s.diagnostics().rows[0]; assert.equal(row.correlation, null); assert.equal(row.core, null);
  assert.equal(s.diagnostics().uncorrelatedRequests, 1);
});

test('unmatched helper/core joins are bounded without eviction or treating silence as non-dispatch', () => {
  const { b, channel, s } = setup(), first = metadata(b);
  for (let i = 0; i <= helperLimits.unmatched; i++) {
    const e = metadata(b); e.timing.instanceId = first.timing.instanceId; e.timing.clockId = first.timing.clockId;
    for (const span of e.timing.spans) { span.startUs += i * 100; span.endUs += i * 100; }
    assert.equal(s.ingest(channel, e), i < helperLimits.unmatched);
  }
  assert.equal(s.diagnostics().unmatchedHelperRequests, helperLimits.unmatched); assert.ok(s.diagnostics().poisonReasons.includes('overflow'));
  const f = setup();
  for (let i = 0; i <= helperLimits.unmatched; i++) f.s.ingestCore(core(randomUUID())[1]);
  assert.equal(f.s.diagnostics().unmatchedApiCommands, helperLimits.unmatched); assert.ok(f.s.diagnostics().poisonReasons.includes('overflow'));
});

test('global API factory ignores unrelated bindings without creating traces or consuming the match', () => {
  const b = binding(), a = createPassiveObserverAdapter({ binding: b, stopLocalExecutionGate() { throw new Error('No automatic Stop'); } });
  for (let i = 0; i < 4; i++) {
    assert.equal(a.observerFactory({ sessionId: randomUUID(), epoch: i }), undefined);
    assert.equal(a.observerFactory({ ...b, epoch: b.epoch + i + 1 }), undefined);
  }
  assert.equal(a.diagnostics().state, 'incomplete'); assert.equal(a.diagnostics().events, 0);
  const observe = a.observerFactory(b); assert.equal(typeof observe, 'function');
  for (const e of core(randomUUID())) observe(e);
  assert.equal(a.observerFactory(binding()), undefined); assert.equal(a.diagnostics().state, 'incomplete');
  assert.equal(a.observerFactory(b), undefined); assert.equal(a.diagnostics().state, 'poisoned');
});

test('helper-first passive attachment joins API source without a second execution path; both detach once', async () => {
  const b = binding(), command = randomUUID(), channel = randomUUID(); let stop = 0, detach = 0, execute = 0;
  const a = createPassiveObserverAdapter({ binding: b, stopLocalExecutionGate() { stop++; } });
  await a.attachHelper({
    async attachHelperObserver(bound, factory) {
      assert.deepEqual(bound, b); const options = factory(channel);
      assert.equal(options.enabled, true); options.onMetadata(metadata(b, command));
      return { detach() { detach++; } };
    },
    execute() { execute++; }, spawn() { execute++; }, run() { execute++; },
  });
  assert.equal(a.diagnostics().helperTiming.unmatchedHelperRequests, 1);
  await a.attach({ async attachObserver(bound, factory) { const observe = factory(bound); for (const e of core(command)) observe(e); return { detach() { detach++; } }; } });
  assert.equal(a.diagnostics().helperTiming.unmatchedHelperRequests, 0); assert.equal(execute, 0); assert.equal(stop, 0);
  assert.equal(a.diagnostics().publicationAllowed, false); assert.equal(a.diagnostics().fixtureSuccess, null);
  assert.equal(a.ingestBroker, undefined); assert.equal(a.execute, undefined); assert.equal(a.run, undefined);
  a.detach(); a.detach(); await turn(); assert.equal(detach, 2); assert.equal(stop, 0);
});

test('post-terminal helper loss and unexpected core events poison passive diagnostics without execution', () => {
  const b = binding(), a = createPassiveObserverAdapter({ binding: b, stopLocalExecutionGate() {} }), command = randomUUID();
  const observe = a.observerFactory(b); for (const e of core(command)) observe(e);
  const timing = a.helperObserverFactory(randomUUID());
  timing.onMetadata({ requestId: randomUUID(), method: 'execute', correlation: { ...b, commandId: command }, droppedBefore: 2, state: 'incomplete', reason: 'lost_response' });
  const d = a.diagnostics(); assert.equal(d.streams[0].logicalTerminal, 'completed'); assert.equal(d.state, 'poisoned');
  assert.equal(d.helperTiming.incomplete.lost_response, 1); assert.equal(d.helperTiming.droppedBeforeTotal, 2);
  assert.ok(d.poisonReasons.includes('helper:helper-events-dropped'));
  const other = createPassiveObserverAdapter({ binding: b, stopLocalExecutionGate() {} }), cb = other.observerFactory(b);
  for (const e of core(randomUUID())) cb(e); for (const e of core(randomUUID())) cb(e);
  assert.equal(other.diagnostics().state, 'poisoned');
});

test('cancellation during helper attachment Stops independently and detaches late subscription once', async () => {
  const pending = deferred(), entered = deferred(), controller = new AbortController(); let stops = 0, detaches = 0;
  const a = createPassiveObserverAdapter({ binding: binding(), stopLocalExecutionGate() { stops++; } });
  const attaching = a.attachHelper({ attachHelperObserver() { entered.resolve(); return pending.promise; } }, controller.signal);
  await entered.promise; controller.abort(); await assert.rejects(attaching, /^Error: Passive source observation incomplete$/);
  pending.resolve({ detach() { detaches++; throw new Error('RAW-ERROR'); } });
  await turn(); await turn(); assert.equal(stops, 1); assert.equal(detaches, 1);
  assert.ok(!JSON.stringify(a.diagnostics()).includes('RAW-ERROR')); assert.equal(a.diagnostics().publicationAllowed, false);
});


test('diagnostics hash broad request IDs, freeze spans, and never read accessor payloads', () => {
  const { b, channel, s } = setup(), e = metadata(b);
  e.requestId = e.timing.requestId = 'PRIVATE_REQUEST_SENTINEL';
  assert.equal(s.ingest(channel, e), true);
  const d = s.diagnostics(); assert.ok(!JSON.stringify(d).includes('PRIVATE_REQUEST_SENTINEL'));
  assert.throws(() => { d.rows[0].source.spans[0].durationUs = 0; });
  const other = setup(); let accessed = false;
  assert.equal(other.s.ingest(other.channel, { get timing() { accessed = true; throw new Error('PRIVATE'); } }), false);
  assert.equal(accessed, false); assert.ok(!JSON.stringify(other.s.diagnostics()).includes('PRIVATE'));
});

test('saturated drop counter remains a lower bound and missing data after end poisons', () => {
  const { b, channel, s } = setup(), e = metadata(b); e.droppedBefore = 65535;
  assert.equal(s.ingest(channel, e), false);
  assert.equal(s.diagnostics().droppedBeforeTotal, 65535); assert.equal(s.diagnostics().droppedBeforeSaturated, true);
  const other = setup(); other.s.endInput();
  assert.equal(other.s.ingest(other.channel, { requestId: randomUUID(), method: 'execute', droppedBefore: 0, state: 'incomplete', reason: 'lost_response' }), false);
  assert.ok(other.s.diagnostics().poisonReasons.includes('late-event'));
});

test('full callback schema is canonical after descriptor-safe copying', () => {
  const valid = metadata(binding());
  const incomplete = { requestId: valid.requestId, method: 'execute', state: 'incomplete', reason: 'absent', droppedBefore: 0 };
  for (const event of [valid, incomplete]) {
    assert.deepEqual(parseHelperCallback(event), HelperTimingEventSchema.parse(event));
    for (const key of Object.keys(event).filter(k => k !== 'correlation')) {
      const bad = { ...event }; delete bad[key];
      assert.equal(HelperTimingEventSchema.safeParse(bad).success, false);
      assert.throws(() => parseHelperCallback(bad));
    }
  }
  for (const patch of [{ reason: 'absent' }, { method: 'start' }, { requestId: 'different' }, { droppedBefore: true }, { droppedBefore: -1 }, { droppedBefore: 0.5 }, { droppedBefore: 65536 }, { correlation: { ...valid.correlation, epoch: Number.MAX_SAFE_INTEGER + 1 } }, { correlation: { ...valid.correlation, extra: 1 } }]) {
    const bad = { ...valid, ...patch };
    assert.equal(HelperTimingEventSchema.safeParse(bad).success, false);
    assert.throws(() => parseHelperCallback(bad));
  }
  const copy = parseHelperCallback(valid);
  valid.correlation.epoch++; valid.timing.spans[0].durationUs++;
  assert.equal(copy.correlation.epoch, 7); assert.equal(copy.timing.spans[0].durationUs, 50);
});

test('nested getters, symbols, oversized and prototype metadata never cross the boundary', () => {
  let reads = 0;
  for (const mutate of [
    e => Object.defineProperty(e.correlation, 'epoch', { get() { reads++; return 7; } }),
    e => Object.defineProperty(e.timing.spans, '0', { get() { reads++; return {}; } }),
    e => { e[Symbol('extra')] = 1; },
    e => { e.requestId = 'x'.repeat(8193); },
    e => { Object.setPrototypeOf(e.correlation, { extra: 1 }); },
  ]) {
    const { b, channel, s } = setup(), e = metadata(b); mutate(e);
    assert.equal(s.ingest(channel, e), false);
    assert.deepEqual(s.diagnostics().poisonReasons, ['invalid-metadata']);
    assert.throws(() => s.assertPublishable(), /refused/);
  }
  assert.equal(reads, 0);
});
