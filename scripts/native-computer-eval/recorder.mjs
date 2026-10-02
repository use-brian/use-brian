import { manifest, validateHeader, validateRun, safetyFields, fallbackReasons } from './eval.mjs';

const exact = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) && Reflect.ownKeys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const integer = (x, max = 1000000) => Number.isSafeInteger(x) && x >= 0 && x <= max;
const stages = ['observation', 'decision', 'dispatch', 'verification'];
const configKeys = ['hardware', 'network', 'models', 'build', 'policy'];
export function validateConsent(header, consent) {
  if (!exact(consent, [...configKeys, 'attended', 'localConsent', 'fixtureOnly', 'signedPackaged']) ||
      ['attended', 'localConsent', 'fixtureOnly', 'signedPackaged'].some(k => consent[k] !== true) ||
      configKeys.some(k => consent[k] !== header[k])) throw new Error('Incomplete attended evidence');
}

/** No raw data is accepted by these hooks. Oracle closures independently read
 * fixture state; neither receipts nor the planner supply selection/task success.
 * A protocol violation permanently poisons this recorder, even if caught.
 */
export function createRecorder({ header, case: task, consent, oracle, signal, clock, onInvalidate }) {
  header = Object.freeze({ ...validateHeader(header) });
  if (header.source !== 'synthetic') throw new Error('Synthetic recorder only');
  validateConsent(header, consent);
  if (!exact(task, ['fixture', 'lane', 'trial']) || !manifest.fixtures.some(f => f.id === task.fixture) || !manifest.lanes.includes(task.lane) || !integer(task.trial, header.trials) || task.trial === 0 ||
      !oracle || typeof oracle.selection !== 'function' || typeof oracle.task !== 'function' || (clock && header.source !== 'synthetic')) throw new Error('Incomplete attended evidence');
  const context = Object.fromEntries(configKeys.map(k => [k, header[k]]));
  const identity = { ...task };
  const ticks = clock ?? (() => process.hrtime.bigint());
  let last = null, origin, poisoned = false, closed = false, busy = false;
  let step = null, stage = null, attempt = null, nextStage = 0, stopOpen = 0, attempts = 0;
  const rows = [], stops = [], slots = new Set();
  const counters = Object.fromEntries([...safetyFields, 'interventions', 'screenshots', 'imageUploads', 'actions'].map(k => [k, 0]));
  const invalidate = () => {
    const first = !poisoned; poisoned = true;
    if (first) { try { onInvalidate?.(); } catch {} }
  };
  const fail = () => { invalidate(); throw new Error('Incomplete attended evidence'); };
  const active = () => { if (poisoned || closed || signal?.aborted) fail(); };
  const now = () => {
    active(); const t = ticks();
    if (typeof t !== 'bigint' || t < 0n || (last !== null && t < last)) fail();
    last = t; return t;
  };
  const elapsed = start => { const n = Number(now() - start) / 1e6; if (!Number.isFinite(n) || n < 0 || n > 3600000) fail(); return n; };
  const guarded = fn => (...args) => { try { active(); return fn(...args); } catch { return fail(); } };
  origin = now();
  const hooks = Object.freeze({
    beginStep: guarded(meta => {
      if (busy || step || rows.length >= 128 || !exact(meta, ['slot', 'perception', 'warmAx']) || !integer(meta.slot, 128) || !meta.slot || slots.has(meta.slot) || !['ax', 'cv', 'none'].includes(meta.perception) || typeof meta.warmAx !== 'boolean' || (meta.warmAx && meta.perception !== 'ax')) fail();
      slots.add(meta.slot); nextStage = 0;
      step = { slot: meta.slot, perception: meta.perception, warmAx: meta.warmAx, dispatched: false, attempts: [] };
    }),
    beginSpan: guarded(name => {
      if (!step || busy || stage || name !== stages[nextStage]) fail();
      stage = { name, start: now() }; let ended = false;
      return guarded(() => {
        if (ended || !stage || stage.name !== name || attempt) fail();
        ended = true; step[`${name}Ms`] = elapsed(stage.start); stage = null; nextStage++;
      });
    }),
    decision: guarded(meta => {
      if (stage?.name !== 'decision' || Object.hasOwn(step, 'acceptedFast') || !exact(meta, ['acceptedFast', 'fallback']) || typeof meta.acceptedFast !== 'boolean' || !fallbackReasons.includes(meta.fallback)) fail();
      step.acceptedFast = meta.acceptedFast; step.fallback = meta.fallback;
    }),
    beginAttempt: guarded(meta => {
      if (stage?.name !== 'decision' || attempt || step.attempts.length >= 128 || !exact(meta, ['kind', 'keySource']) || !['jev', 'llm', 'vision'].includes(meta.kind) || !['workspace', 'platform'].includes(meta.keySource)) fail();
      const a = { kind: meta.kind, keySource: meta.keySource, start: now() }; attempt = a; attempts++; let ended = false;
      return guarded(result => {
        if (ended || attempt !== a || !exact(result, ['outcome', 'usage']) || !['ok', 'failed', 'partial', 'cancelled'].includes(result.outcome)) fail();
        // Unknown usage (including on errors) is NOT zero and is never finalized.
        const u = result.usage;
        if (!exact(u, ['inputTokens', 'outputTokens', 'incurredUsd']) || !integer(u.inputTokens) || !integer(u.outputTokens) || typeof u.incurredUsd !== 'number' || !Number.isFinite(u.incurredUsd) || u.incurredUsd < 0 || u.incurredUsd > 10000) fail();
        const latencyMs = elapsed(a.start);
        step.attempts.push({ kind: a.kind, keySource: a.keySource, outcome: result.outcome, latencyMs, inputTokens: u.inputTokens, outputTokens: u.outputTokens, incurredUsd: u.incurredUsd, usageComplete: true });
        ended = true; attempt = null;
      });
    }),
    delivered: guarded(() => {
      if (stage?.name !== 'dispatch' || step.dispatched) fail();
      step.dispatched = true; counters.actions++;
    }),
    event: guarded(kind => {
      if (![...safetyFields, 'interventions', 'screenshots', 'imageUploads'].includes(kind) || counters[kind] >= 1000000) fail();
      counters[kind]++;
    }),
    beginStop: guarded(() => {
      if (stops.length + stopOpen >= 128) fail();
      const start = now(); stopOpen++; let ended = false;
      return guarded(() => {
        if (ended) fail(); const duration = elapsed(start);
        ended = true; stopOpen--; stops.push(duration);
      });
    }),
    endStep: async () => {
      try {
        active(); if (busy || !step || stage || attempt || nextStage !== 4 || !Object.hasOwn(step, 'acceptedFast')) fail();
        busy = true;
        const result = await oracle.selection(Object.freeze({ slot: step.slot }));
        active();
        if (!exact(result, ['selection']) || !['correct', 'incorrect', 'abstain', 'none'].includes(result.selection) || (step.dispatched && !['correct', 'incorrect'].includes(result.selection))) fail();
        rows.push({ ...step, selection: result.selection }); step = null; busy = false;
      } catch { fail(); }
    },
  });
  return Object.freeze({
    hooks,
    invalidate,
    assertFinalized: () => { if (!closed || poisoned || signal?.aborted) fail(); },
    finalize: async attestation => {
      try {
        active();
        if (busy || step || stage || attempt || stopOpen || !rows.length || !exact(attestation, ['evidenceComplete', 'attempts', 'actions']) || attestation.evidenceComplete !== true || !integer(attestation.attempts) || !integer(attestation.actions) || attestation.attempts !== attempts || attestation.actions !== counters.actions) fail();
        busy = true;
        const result = await oracle.task(); active();
        // Stop/safety hooks remain live while the independent oracle awaits.
        // Recheck pending work/counts after that asynchronous boundary, not just
        // before it. Any safety events received meanwhile enter the snapshot.
        if (!busy || step || stage || attempt || stopOpen || !rows.length || attestation.attempts !== attempts || attestation.actions !== counters.actions) fail();
        if (!exact(result, ['success']) || typeof result.success !== 'boolean') fail();
        const run = { type: 'run', ...identity, ...context, attended: true, signedPackaged: true, evidenceComplete: true, success: result.success, ...counters, durationMs: elapsed(origin), stopMs: [...stops], steps: structuredClone(rows) };
        validateRun(header, run);
        active(); if (step || stage || attempt || stopOpen) fail();
        closed = true; busy = false; return run;
      } catch { fail(); }
    },
  });
}
