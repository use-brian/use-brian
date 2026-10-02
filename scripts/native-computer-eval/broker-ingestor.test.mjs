// Synthetic source metadata only. No broker/helper/OS execution or authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NativeBrokerTraceEventSchema, NativeRunTrace, brokerContractDigest } from './source-contract.mjs';
import { createBrokerIngestor, brokerLimits } from './broker-ingestor.mjs';
import { createPassiveObserverAdapter } from './main-driver.mjs';
const binding = () => ({ sessionId: randomUUID(), epoch: 7 });
const turn = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function producer(b) {
  const sourceId = randomUUID(), clockId = randomUUID(); let sequence = 0, elapsed = 100;
  return (event, outcome, fields = {}) => ({ ...b, source: 'desktop_broker', sourceId, clockId, sequence: ++sequence, elapsedMs: elapsed += 10, incomplete: false, event, outcome, ...fields });
}
function core(commandId, actionKind = 'invoke') {
  let now = 500000;
  const trace = new NativeRunTrace(undefined, { clock: () => now });
  const s = trace.startSpan(actionKind === 'observe' ? 'observation-rpc' : 'effect-rpc', 0, { commandId, actionKind });
  now += 2; s.settle('fulfilled'); now++; trace.terminal('completed', 1);
  return trace.snapshot().events;
}
function helper(b, commandId, phase = 'request') {
  const requestId = randomUUID();
  return { requestId, method: 'execute', correlation: { ...b, commandId }, droppedBefore: 0, state: 'complete', timing: {
    version: 1, requestId, method: 'execute', instanceId: randomUUID(), clockId: randomUUID(),
    // Harmless probe/refusal handling may return this exact shape. No API span.
    spans: [{ phase, startUs: 90000000000, endUs: 90000000007, durationUs: 7, status: 'returned' }],
  } };
}

test('canonical broker schema and all six cross-source arrival orders yield identity-only joins', () => {
  for (const order of ['cbh', 'chb', 'bch', 'bhc', 'hcb', 'hbc']) {
    const b = binding(), s = createBrokerIngestor({ binding: b }), commandId = randomUUID(), emit = producer(b), channel = randomUUID();
    const record = emit('command_admission', 'admitted', { command: { commandId, actionKind: 'invoke' } });
    assert.equal(NativeBrokerTraceEventSchema.safeParse(record).success, true);
    const routes = { c: () => core(commandId).every(e => s.ingestCore(e)), b: () => s.ingest(record), h: () => s.ingestHelper(channel, helper(b, commandId)) };
    for (const lane of order) assert.equal(routes[lane](), true);
    const d = s.diagnostics(), joined = d.commands[0];
    assert.equal(d.brokerContractDigest, brokerContractDigest); assert.equal(d.unmatchedCommands, 0);
    assert.equal(joined.join, 'matched-identities'); assert.equal(joined.sessionId, b.sessionId); assert.equal(joined.epoch, b.epoch);
    assert.equal(joined.commandId, commandId); assert.notEqual(joined.core.clockId, joined.broker.clockId); assert.notEqual(joined.helpers[0].clockId, joined.broker.clockId);
    assert.equal(joined.osDelivery, null); assert.equal(joined.nonDispatch, null); assert.equal(joined.targetMutation, null);
    assert.equal(d.state, 'incomplete'); assert.equal(d.publicationAllowed, false);
  }
});

test('broker local Stop duration is entry-to-gate only; pending lifetime is not fixture drain', async () => {
  const b = binding(), s = createBrokerIngestor({ binding: b }), emit = producer(b);
  const start = emit('stop_requested', 'started'); const gate = emit('local_gate_revoked', 'revoked', { durationMs: 2 });
  await new Promise(r => setTimeout(r, 20)); // arrival delay cannot change timing
  const saved = Date.now; Date.now = () => { throw new Error('Arrival clock forbidden'); };
  try { assert.equal(s.ingest(start), true); assert.equal(s.ingest(gate), true); } finally { Date.now = saved; }
  assert.equal(s.ingest(emit('helper_lifetime_barrier', 'started', { operation: 'kill' })), true);
  let d = s.diagnostics(); assert.equal(d.localGate.methodEntryToLocalGateMs, 2);
  assert.equal(d.localGate.physicalActivationToGateMs, null); assert.equal(d.localGate.nativeOsStopMs, null);
  assert.equal(d.helperLifetimeBarrier.outcome, 'pending'); assert.ok(d.incompleteReasons.includes('helper-lifetime-unresolved'));
  assert.equal(s.ingest(emit('helper_lifetime_barrier', 'resolved', { operation: 'kill', durationMs: 11 })), true);
  d = s.diagnostics(); assert.equal(d.helperLifetimeBarrier.outcome, 'resolved');
  assert.equal(d.fixtureDrain, 'not_observed'); assert.equal(d.leaseReleaseObserved, null); assert.equal(d.drain, 'not_observed');
  assert.throws(() => s.assertPublishable());
});

test('logical helper wait cancellation does not settle RPC; late old-scope settlement remains old', () => {
  const b = binding(), a = createPassiveObserverAdapter({ binding: b, stopLocalExecutionGate() {} });
  const emit = producer(b), cb = a.brokerObserverFactory(b), command = { commandId: randomUUID(), actionKind: 'invoke' };
  cb(emit('helper_rpc_wait', 'started', { operation: 'execute', command }));
  cb(emit('helper_rpc_wait', 'cancelled', { operation: 'execute', command, durationMs: 5 }));
  cb(emit('stop_requested', 'started')); cb(emit('local_gate_revoked', 'revoked', { durationMs: 1 }));
  cb(emit('helper_lifetime_barrier', 'started', { operation: 'kill' }));
  const laterBinding = { ...b, epoch: b.epoch + 1 }, ignored = a.brokerObserverFactory(laterBinding);
  ignored(producer(laterBinding)('stop_requested', 'started'));
  assert.equal(a.diagnostics().broker.pendingHelperRpcSettlements, 1);
  cb(emit('helper_rpc_settlement', 'late_resolved', { operation: 'execute', command, durationMs: 40 }));
  const d = a.diagnostics().broker; assert.equal(d.pendingHelperRpcSettlements, 0); assert.equal(d.helperLifetimeBarrier.outcome, 'pending');
  assert.equal(d.rows.at(-1).epoch, b.epoch); assert.equal(d.commands[0].epoch, b.epoch); assert.equal(d.state, 'incomplete');
  // A genuinely mis-scoped event on the captured callback is NOT retagged.
  cb({ ...emit('authority_check', 'resolved', { operation: 'local', command, durationMs: 1 }), epoch: laterBinding.epoch });
  assert.equal(a.diagnostics().broker.state, 'poisoned');
});

test('late trace_incomplete or incomplete flag poisons even with contiguous sequences and no drop count', () => {
  for (const marker of [true, false]) {
    const b = binding(), a = createPassiveObserverAdapter({ binding: b, stopLocalExecutionGate() {} }), emit = producer(b), cmd = randomUUID();
    const api = a.observerFactory(b); for (const e of core(cmd)) api(e);
    const cb = a.brokerObserverFactory(b); cb(emit('command_admission', 'admitted', { command: { commandId: cmd, actionKind: 'invoke' } }));
    cb(marker ? emit('trace_incomplete', 'incomplete', { incomplete: true }) : emit('authority_check', 'resolved', { operation: 'local', durationMs: 1, incomplete: true }));
    const d = a.diagnostics(); assert.equal(d.streams[0].logicalTerminal, 'completed'); assert.equal(d.state, 'poisoned');
    assert.equal(d.broker.brokerLossObserved, true); assert.equal(d.broker.droppedEvents, null); assert.equal(d.broker.events, 2);
  }
});

test('sequence, source clock, scope, lifecycle, action correlation and raw content conflicts reject', () => {
  for (const mutate of [
    e => { e.sequence++; }, e => { e.sequence--; }, e => { e.clockId = randomUUID(); }, e => { e.sourceId = randomUUID(); },
    e => { e.elapsedMs = 0; }, e => { e.durationMs = 999999; }, e => { e.epoch++; }, e => { e.sessionId = randomUUID(); },
    e => { e.raw = 'PRIVATE-SENTINEL'; }, e => { e.command.title = 'PRIVATE-SENTINEL'; },
  ]) {
    const b = binding(), s = createBrokerIngestor({ binding: b }), emit = producer(b), command = { commandId: randomUUID(), actionKind: 'observe' };
    s.ingest(emit('command_admission', 'admitted', { command }));
    const e = emit('authority_check', 'resolved', { command: { ...command }, operation: 'local', durationMs: 1 }); mutate(e);
    assert.equal(s.ingest(e), false); assert.equal(s.diagnostics().state, 'poisoned'); assert.ok(!JSON.stringify(s.diagnostics()).includes('PRIVATE-SENTINEL'));
  }
  const b = binding(), s = createBrokerIngestor({ binding: b }), emit = producer(b), cmd = randomUUID();
  for (const e of core(cmd, 'observe')) s.ingestCore(e);
  assert.equal(s.ingest(emit('command_admission', 'admitted', { command: { commandId: cmd, actionKind: 'invoke' } })), false);
  const other = createBrokerIngestor({ binding: b });
  assert.equal(other.ingest(producer(b)('helper_lifetime_barrier', 'resolved', { operation: 'kill', durationMs: 1 })), false);
});

test('bounded unmatched joins and source events never evict a missing counterpart or claim non-dispatch', () => {
  const b = binding(), s = createBrokerIngestor({ binding: b }), emit = producer(b);
  for (let i = 0; i <= brokerLimits.unmatched; i++) {
    assert.equal(s.ingest(emit('command_admission', 'admitted', { command: { commandId: randomUUID(), actionKind: 'observe' } })), i < brokerLimits.unmatched);
  }
  const d = s.diagnostics(); assert.equal(d.unmatchedCommands, brokerLimits.unmatched); assert.ok(d.poisonReasons.includes('overflow'));
  for (const c of d.commands) assert.equal(c.nonDispatch, null);
  const bounded = createBrokerIngestor({ binding: b }), more = producer(b);
  for (let i = 0; i <= brokerLimits.events; i++) bounded.ingest(more('authority_check', 'resolved', { operation: 'local', durationMs: 1 }));
  assert.equal(bounded.diagnostics().events, brokerLimits.events); assert.equal(bounded.diagnostics().state, 'poisoned');
});

test('fulfilled RPC + returned macOS-like probe timing + resolved lifetime CANNOT imply AX success', () => {
  for (const actionKind of ['observe', 'invoke']) {
    const b = binding(), a = createPassiveObserverAdapter({ binding: b, stopLocalExecutionGate() {} }), cmd = randomUUID(), emit = producer(b);
    const api = a.observerFactory(b), broker = a.brokerObserverFactory(b);
    for (const e of core(cmd, actionKind)) api(e); // fulfilled RPC, logical completed
    a.helperTimingObserver(helper(b, cmd, actionKind === 'observe' ? 'observe_request' : 'request'));
    const command = { commandId: cmd, actionKind };
    broker(emit('command_admission', 'admitted', { command }));
    broker(emit('helper_rpc_wait', 'started', { operation: 'execute', command }));
    broker(emit('helper_rpc_settlement', 'resolved', { operation: 'execute', command, durationMs: 5 }));
    broker(emit('helper_rpc_wait', 'resolved', { operation: 'execute', command, durationMs: 7 }));
    broker(emit('stop_requested', 'started')); broker(emit('local_gate_revoked', 'revoked', { durationMs: 1 }));
    broker(emit('helper_lifetime_barrier', 'started', { operation: 'kill' }));
    broker(emit('helper_lifetime_barrier', 'resolved', { operation: 'kill', durationMs: 2 }));
    const d = a.diagnostics(); assert.equal(d.broker.commands[0].join, 'matched-identities');
    assert.equal(d.axSuccess, null); assert.equal(d.helperTiming.axSuccess, null); assert.equal(d.broker.axSuccess, null);
    assert.equal(d.warmAxGateEvidence, 'unavailable'); assert.equal(d.fixtureSuccess, null); assert.equal(d.drain, 'not_observed');
    assert.equal(d.helperTiming.rows[0].apiSpanObserved, false); assert.equal(d.helperTiming.rows[0].nonDispatch, null);
    assert.equal(d.publicationAllowed, false); assert.throws(() => a.assertPublishable());
  }
});

test('three actual trusted port attachments register callbacks only; no second execution path', async () => {
  const b = binding(), a = createPassiveObserverAdapter({ binding: b, stopLocalExecutionGate() {} });
  let registrations = 0, detached = 0, executions = 0;
  const disposable = () => ({ detach() { detached++; } });
  await a.attach({ async attachObserver(bound, factory) { assert.deepEqual(bound, b); assert.equal(typeof factory(bound), 'function'); registrations++; return disposable(); }, execute() { executions++; } });
  await a.attachBroker({ async attachBrokerObserver(bound, factory) { assert.deepEqual(bound, b); assert.equal(typeof factory(bound), 'function'); registrations++; return disposable(); }, run() { executions++; } });
  await a.attachHelper({ async attachHelperTimingObserver(bound, callback) { assert.deepEqual(bound, b); assert.equal(typeof callback, 'function'); registrations++; return disposable(); }, spawn() { executions++; } });
  assert.equal(registrations, 3); assert.equal(executions, 0);
  for (const k of ['execute', 'start', 'run', 'dispatch', 'approve']) assert.equal(a[k], undefined);
  a.detach(); a.detach(); await turn(); assert.equal(detached, 3);
});

test('direct desktop helper callback routes original scope, never current epoch or ambiguous startup', () => {
  const b = binding(), a = createPassiveObserverAdapter({ binding: b, stopLocalExecutionGate() {} });
  const unscoped = helper(b, randomUUID()); delete unscoped.correlation;
  a.helperTimingObserver(unscoped); assert.equal(a.diagnostics().unscopedHelperEvents, 1); assert.equal(a.diagnostics().helperTiming.events, 0);
  a.helperTimingObserver(helper({ ...b, epoch: b.epoch + 1 }, randomUUID())); assert.equal(a.diagnostics().helperTiming.events, 0);
  const old = helper(b, randomUUID()); a.helperTimingObserver(old);
  assert.equal(a.diagnostics().helperTiming.rows[0].correlation.epoch, b.epoch);
  assert.equal(a.diagnostics().state, 'incomplete');
});

test('cancelled broker attachment Stops immediately; late registration detaches once without raw errors', async () => {
  const pending = deferred(), entered = deferred(), signal = new AbortController(); let stops = 0, detached = 0;
  const a = createPassiveObserverAdapter({ binding: binding(), stopLocalExecutionGate() { stops++; } });
  const work = a.attachBroker({ attachBrokerObserver() { entered.resolve(); return pending.promise; } }, signal.signal);
  await entered.promise; signal.abort(); await assert.rejects(work, /^Error: Passive source observation incomplete$/);
  pending.resolve({ detach() { detached++; throw new Error('PRIVATE-ERROR'); } });
  await turn(); await turn(); assert.equal(stops, 1); assert.equal(detached, 1);
  assert.ok(!JSON.stringify(a.diagnostics()).includes('PRIVATE-ERROR')); assert.equal(a.diagnostics().publicationAllowed, false);
});

test('broker metadata boundary never invokes payload accessors; snapshots are immutable and close is not drain', () => {
  const b = binding(), emit = producer(b), s = createBrokerIngestor({ binding: b }); let invoked = 0;
  const record = emit('authority_check', 'resolved', { operation: 'local', durationMs: 1 });
  Object.defineProperty(record, 'privatePayload', { enumerable: true, get() { invoked++; return 'PRIVATE-PAYLOAD'; } });
  assert.equal(s.ingest(record), false); assert.equal(invoked, 0);
  assert.ok(!JSON.stringify(s.diagnostics()).includes('PRIVATE-PAYLOAD'));
  const clean = createBrokerIngestor({ binding: b });
  clean.ingest(producer(b)('stop_requested', 'started'));
  const snapshot = clean.diagnostics(); assert.throws(() => { snapshot.rows[0].epoch++; });
  clean.endInput(); assert.equal(clean.diagnostics().drain, 'not_observed');
  assert.equal(clean.ingest(producer(b)('stop_requested', 'started')), false);
  assert.ok(clean.diagnostics().poisonReasons.includes('late-event')); assert.equal(snapshot.state, 'incomplete');
});

test('helper absence/lost response remains incomplete identity evidence; late drop/invalid markers poison', () => {
  for (const reason of ['absent', 'lost_response', 'invalid', 'dropped']) {
    const b = binding(), cmd = randomUUID(), s = createBrokerIngestor({ binding: b }), emit = producer(b);
    for (const e of core(cmd)) s.ingestCore(e);
    s.ingest(emit('command_admission', 'admitted', { command: { commandId: cmd, actionKind: 'invoke' } }));
    const event = { requestId: randomUUID(), method: 'execute', correlation: { ...b, commandId: cmd }, state: 'incomplete', reason: reason === 'dropped' ? 'absent' : reason, droppedBefore: reason === 'dropped' ? 65535 : 0 };
    const poisoned = ['invalid', 'dropped'].includes(reason);
    assert.equal(s.ingestHelper(randomUUID(), event), !poisoned);
    const d = s.diagnostics(); assert.equal(d.state, poisoned ? 'poisoned' : 'incomplete');
    assert.equal(d.commands[0].join, 'matched-identities'); assert.equal(d.commands[0].helpers[0].state, 'incomplete');
    assert.equal(d.commands[0].nonDispatch, null); assert.equal(d.axSuccess, null); assert.equal(d.publicationAllowed, false);
  }
});

test('unscoped direct helper loss is retained without invented binding and poisoned conservatively', () => {
  const a = createPassiveObserverAdapter({ binding: binding(), stopLocalExecutionGate() { assert.fail('Metadata cannot Stop production'); } });
  a.helperTimingObserver({ requestId: randomUUID(), method: 'capabilities', state: 'incomplete', reason: 'absent', droppedBefore: 65535 });
  const d = a.diagnostics(); assert.equal(d.unscopedHelperEvents, 1); assert.equal(d.unscopedHelperDroppedBefore, 65535);
  assert.equal(d.unscopedHelperDropsSaturated, true); assert.equal(d.helperTiming.rows.length, 0); assert.equal(d.broker.commands.length, 0);
  assert.equal(d.state, 'poisoned'); assert.equal(d.fixtureSuccess, null);
});

test('broker factory ignores unrelated scopes but repeated matching factory permanently poisons', () => {
  const b = binding(), a = createPassiveObserverAdapter({ binding: b, stopLocalExecutionGate() {} });
  const unrelated = binding(); a.brokerObserverFactory(unrelated)(producer(unrelated)('stop_requested', 'started'));
  assert.equal(a.diagnostics().broker.events, 0); assert.equal(a.diagnostics().state, 'incomplete');
  const callback = a.brokerObserverFactory(b); callback(producer(b)('stop_requested', 'started'));
  assert.equal(a.diagnostics().broker.events, 1); a.brokerObserverFactory(b);
  assert.equal(a.diagnostics().state, 'poisoned'); assert.throws(() => a.assertPublishable());
});
