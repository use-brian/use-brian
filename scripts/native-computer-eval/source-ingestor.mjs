import { createHash } from 'node:crypto';
import { NativeTraceEventSchema, sourceContractDigest } from './source-contract.mjs';
import { strictJSON } from './eval.mjs';
import { boundedMetadataCopy } from './metadata-boundary.mjs';

export const sourceLimits = Object.freeze({ runs: 16, events: 8192, eventBytes: 8192, totalBytes: 16 * 1024 * 1024, depth: 8 });
const reasons = new Set(['invalid-metadata', 'overflow', 'missing-sequence', 'duplicate-or-out-of-order', 'correlation-conflict', 'source-clock', 'source-duration', 'lifecycle-conflict', 'source-poison', 'safety-defect', 'cancelled', 'detached', 'late-event', 'observer-failed']);
const hash = value => value === null ? null : createHash('sha256').update(value).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const sameMeta = (a, b) => ['phase', 'scope', 'step', 'commandId', 'actionKind'].every(k => a[k] === b[k]);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const durationMatches = (start, event) => start !== null && event.atMs !== null && event.durationMs !== null && event.atMs >= start &&
  Math.abs(event.durationMs - (event.atMs - start)) <= Number.EPSILON * Math.max(1, start, event.atMs) * 4;

/** Passive, bounded metadata state only. No clock reads, authority handles,
 * driver calls, planner, receipt-based success, or accepted-live conversion. */
export function createSourceIngestor() {
  const runs = new Map(), clocks = new Map(), faults = new Set();
  let events = 0, bytes = 0, closed = false;
  const poison = reason => { faults.add(reasons.has(reason) ? reason : 'invalid-metadata'); return false; };
  const conflict = reason => { poison(reason); throw new Error('Invalid source evidence'); };
  function apply(e) {
    if (e.evidence === 'poisoned' || e.kind === 'evidence-poisoned') return poison('source-poison');
    const key = `${e.runId}/${e.clockId}`;
    if (clocks.has(e.runId) && clocks.get(e.runId) !== e.clockId) conflict('correlation-conflict');
    let r = runs.get(key);
    if (!r) {
      if (runs.size >= sourceLimits.runs) conflict('overflow');
      if (e.sequence !== 1 || e.kind !== 'run-start') conflict('missing-sequence');
      r = { runId: e.runId, clockId: e.clockId, sequence: 0, root: e.spanId, start: e.atMs, last: null, terminal: null, duration: null, spans: new Map(), commands: new Map(), attempts: new Map() };
      runs.set(key, r); clocks.set(e.runId, e.clockId);
    }
    if (e.sequence !== r.sequence + 1) conflict(e.sequence > r.sequence + 1 ? 'missing-sequence' : 'duplicate-or-out-of-order');
    if (e.late !== (r.terminal !== null)) conflict('lifecycle-conflict');
    if (e.atMs !== null) {
      if (r.last !== null && e.atMs < r.last) conflict('source-clock');
      r.last = e.atMs;
    } else if (e.kind !== 'inference-update') conflict('source-clock');
    if (e.kind === 'run-start') {
      if (r.sequence !== 0 || e.spanId !== r.root || e.step !== null) conflict('lifecycle-conflict');
    } else if (e.kind === 'run-terminal') {
      if (r.terminal || e.spanId !== r.root || !durationMatches(r.start, e)) conflict('source-duration');
      r.terminal = e.outcome; r.duration = e.durationMs;
    } else if (e.kind === 'span-start') {
      if (r.terminal || e.spanId === r.root || r.spans.has(e.spanId) || e.step === null) conflict('lifecycle-conflict');
      if (e.commandId && r.commands.has(e.commandId)) conflict('correlation-conflict');
      if (e.commandId) r.commands.set(e.commandId, e.spanId);
      r.spans.set(e.spanId, { meta: e, start: e.atMs, interrupted: null, settled: null });
    } else if (e.kind === 'span-settled' || e.kind === 'span-interrupted') {
      const s = r.spans.get(e.spanId);
      if (!s || !sameMeta(s.meta, e)) conflict('correlation-conflict');
      if (!durationMatches(s.start, e)) conflict('source-duration');
      const field = e.kind === 'span-settled' ? 'settled' : 'interrupted';
      if (s[field] !== null) conflict('duplicate-or-out-of-order');
      // Core can report a logical wait interruption after underlying settlement;
      // these are independent facts, not a second provider/helper completion.
      s[field] = { durationMs: e.durationMs, outcome: e.outcome, late: e.late };
    } else if (e.kind === 'inference-update') {
      const s = r.spans.get(e.spanId), next = e.inference, previous = r.attempts.get(next.attemptId);
      if (!s || s.meta.phase !== e.phase || s.meta.step !== e.step) conflict('correlation-conflict');
      if (!previous) {
        if (r.terminal || next.invocationState !== 'pending') conflict('lifecycle-conflict');
      } else {
        const old = previous.inference;
        if (previous.spanId !== e.spanId || ['requestedModel', 'lane', 'stage', 'operation', 'providerKeySource', 'perceptionPath'].some(k => old[k] !== next[k]) ||
            (old.model !== null && old.model !== next.model) ||
            (old.providerKind !== next.providerKind && !(old.model === null && next.model !== null)) ||
            (old.interrupted && !next.interrupted) ||
            (old.durationMs !== null && (next.durationMs === null || next.durationMs < old.durationMs))) conflict('lifecycle-conflict');
        if (old.invocationState === 'settled') conflict('lifecycle-conflict');
        if (equal(old, next)) conflict('duplicate-or-out-of-order');
      }
      // Stable invocation-ID upsert, including settlement AFTER logical terminal.
      // Adapter duration is source-supplied, not derived from this callback or
      // equated to the containing high-level span / network duration.
      r.attempts.set(next.attemptId, { spanId: e.spanId, inference: freeze(next), late: e.late });
    } else conflict('lifecycle-conflict');
    r.sequence = e.sequence;
    return true;
  }
  function ingest(input) {
    if (closed) return poison('late-event');
    if (faults.size) return false;
    try {
      const parsed = NativeTraceEventSchema.safeParse(boundedMetadataCopy(input));
      if (!parsed.success) return poison('invalid-metadata');
      const size = Buffer.byteLength(JSON.stringify(parsed.data));
      if (size > sourceLimits.eventBytes || events >= sourceLimits.events || bytes + size > sourceLimits.totalBytes) return poison('overflow');
      events++; bytes += size;
      return apply(parsed.data);
    } catch { if (!faults.size) poison('invalid-metadata'); return false; }
  }
  return Object.freeze({
    ingest,
    streamCount: () => runs.size,
    ingestJSON(text) {
      try { if (typeof text !== 'string' || Buffer.byteLength(text) > sourceLimits.eventBytes) return poison('overflow'); return ingest(strictJSON(text)); }
      catch { return poison('invalid-metadata'); }
    },
    invalidate: poison,
    endInput() { closed = true; }, // Transport end, emphatically NOT a source drain.
    assertPublishable() { throw new Error('Live source evidence incomplete; publication refused'); },
    diagnostics() {
      const streams = [...runs.values()].map(r => ({
        runId: r.runId, clockId: r.clockId, lastSequence: r.sequence,
        logicalTerminal: r.terminal, sourceRunDurationMs: r.duration,
        pendingSpans: [...r.spans.values()].filter(s => !s.settled).length,
        pendingInvocations: [...r.attempts.values()].filter(a => a.inference.invocationState === 'pending').length,
        unknownSettledUsage: [...r.attempts.values()].filter(a => a.inference.invocationState === 'settled' && (a.inference.model === null || a.inference.usage === null || a.inference.incurredCostUsd === null)).length,
        unknownSettledDuration: [...r.attempts.values()].filter(a => a.inference.invocationState === 'settled' && a.inference.durationMs === null).length,
        spans: [...r.spans].map(([spanId, s]) => ({ spanId, commandId: s.meta.commandId, phase: s.meta.phase, scope: s.meta.scope, step: s.meta.step, sourceStartMs: s.start, interrupted: s.interrupted, settled: s.settled })),
        invocations: [...r.attempts].map(([attemptId, a]) => {
          const { requestedModel, model, ...metadata } = a.inference;
          return { ...metadata, attemptId, spanId: a.spanId, requestedModelDigest: hash(requestedModel), modelDigest: hash(model), scope: 'adapter-lifecycle', late: a.late };
        }),
      }));
      return freeze(structuredClone({
        type: 'source-diagnostics', version: 1, sourceContractDigest,
        state: faults.size ? 'poisoned' : 'incomplete', poisonReasons: [...faults], inputClosed: closed,
        events, bytes, streams, drain: 'not_observed', fixtureSuccess: null, axSuccess: null, warmAxGateEvidence: 'unavailable',
        incompleteReasons: [
          ...(!streams.length ? ['no-source-run'] : []),
          ...(streams.some(r => r.logicalTerminal === null) ? ['missing-run-terminal'] : []),
          ...(streams.some(r => r.pendingSpans) ? ['pending-source-spans'] : []),
          ...(streams.some(r => r.pendingInvocations) ? ['pending-inference'] : []),
          ...(streams.some(r => r.unknownSettledUsage) ? ['unknown-settled-accounting'] : []),
          ...(streams.some(r => r.unknownSettledDuration) ? ['unknown-settled-duration'] : []),
          'native-oracle-and-drain-evidence-unavailable',
        ],
        publicationAllowed: false, routingProfileApproval: false, releaseStatus: 'pending',
        missingSources: ['local-ax-timing', 'local-os-dispatch', 'local-stop-gate', 'independent-fixture-oracle', 'native-safety-and-capture-counts', 'provider-helper-fixture-drain', 'matched-fixture-matrix'],
      }));
    },
  });
}
