// Observation-only checker: no process, input or production acceptance APIs.
export const historicalCases = Object.freeze(['null', 'normal', 'paused-before-final-check', 'last-check-to-post',
  'after-down-stall', 'after-down-owner-death', 'worker-death-before-check', 'parent-death-before-check',
  'worker-death-after-check', 'parent-death-after-check', 'physical-overlap', 'physical-before-check']);
// Stable historical names/indices are report vocabulary, not execution authority.
export const cases = historicalCases; // compatibility for offline consumers
export const runnableCases = Object.freeze(['null']);
const allowed = new Map([
  [0, [1, 2, 3, 4, 5, 84, 85, 94, 101]], [1, [40, 41, 42, 43, 44, 45, 46, 47]],
  [2, [60, 61, 62, 63, 64]], [3, [3, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 80, 86, 92, 93, 95, 96, 97, 98, 99, 100]],
  [4, [6, 7, 8, 9, 81, 82, 83]], [5, [83, 90]],
]);
export const preflightFailures = Object.freeze(['cancelled-before-start', 'input-not-neutral', 'fixture-not-frontmost',
  'listen-permission-unavailable', 'post-permission-unavailable', 'observer-unavailable',
  'fixture-window-unavailable', 'consent-bootstrap-unavailable']);
const sameKeys = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',');
export function classify(report) {
  const result = (verdict, reason) => ({ verdict, reason, productionAcceptance: false });
  const unknown = reason => result('inconclusive', reason);
  const hasPreflight = Object.hasOwn(report ?? {}, 'preflightFailure');
  if (!sameKeys(report, ['schema', 'case', 'productionAcceptance', 'consented', 'started', 'lost', 'records', 'localCounts', 'os', 'architecture', ...(hasPreflight ? ['preflightFailure'] : [])]) ||
      report.schema !== 'native-mechanism-experiment.v1' || !cases.includes(report.case) || report.productionAcceptance !== false ||
      !['consented', 'started', 'lost'].every(k => typeof report[k] === 'boolean') ||
      typeof report.os !== 'string' || report.os.length > 128 || !['arm64', 'x86_64'].includes(report.architecture) ||
      !Array.isArray(report.records) || report.records.length > 2048) return unknown('invalid-report');
  if (hasPreflight && report.preflightFailure !== null &&
      (!preflightFailures.includes(report.preflightFailure) || !report.consented || report.started || report.records.length))
    return unknown('invalid-report');
  const seq = new Map(), times = new Map();
  for (const r of report.records) {
    if (!sameKeys(r, ['source', 'code', 'sequence', 'ticks']) || !allowed.get(r.source)?.includes(r.code) ||
        !Number.isInteger(r.sequence) || r.sequence !== (seq.get(r.source) ?? 0) + 1 ||
        typeof r.ticks !== 'string' || !/^[1-9][0-9]{0,19}$/.test(r.ticks) || BigInt(r.ticks) > 18446744073709551615n ||
        BigInt(r.ticks) < (times.get(r.source) ?? 0n)) return unknown('incomplete-record-stream');
    seq.set(r.source, r.sequence); times.set(r.source, BigInt(r.ticks));
  }
  if (!sameKeys(report.localCounts, ['0', '1', '2', '4']) ||
      ![0, 1, 2, 4].every(s => Number.isInteger(report.localCounts[s]) && report.localCounts[s] === (seq.get(s) ?? 0)))
    return unknown('incomplete-record-stream');
  const rows = (s, c) => report.records.filter(r => r.source === s && r.code === c);
  const has = (s, c) => rows(s, c).length > 0;
  const one = (s, c) => rows(s, c).length === 1;
  const tick = (s, c) => BigInt(rows(s, c)[0]?.ticks ?? '0');
  const before = (s, a, b) => one(s, a) && one(s, b) && tick(s, a) <= tick(s, b);
  if (!report.consented) return report.started || report.records.length ? unknown('consent-violation') : result('blocked', 'consent-declined');
  if (!report.started) return report.records.length ? unknown('invalid-preflight') : result('blocked', report.preflightFailure ?? 'preflight-unavailable');
  if (report.lost || has(0, 5) || has(1, 47) || has(0, 85)) return unknown('loss-or-scope-change');
  if (!before(0, 1, 2) || !one(0, 84) || !one(0, 4) || !one(0, 94) ||
      tick(0, 94) - tick(0, 2) < 7900000000n) return unknown('incomplete-observation-window');
  if (has(3, 3) || has(0, 3)) return result('blocked', 'native-preflight-unavailable');
  if (!before(3, 10, 11) || !one(1, 40)) return unknown('null-not-confirmed');
  // The original null may not reach a downstream tap; absence is inconclusive.
  if (tick(3, 10) < tick(0, 1)) return unknown('consent-order-invalid');
  if (report.case !== 'after-down-owner-death' && one(3, 19) && report.records.filter(r => r.source === 3).at(-1)?.code !== 19) return unknown('records-after-terminal');
  if (report.case === 'null') {
    if (has(3, 16) || has(1, 42) || has(1, 43)) return result('counterexample', 'unexpected-input-in-null-case');
    return one(3, 19) ? result('observed-as-specified', 'null-confirmed-only') : unknown('missing-terminal');
  }
  if (!before(3, 12, 13) || !before(3, 13, 14)) return unknown('click-phase-not-reached');
  if (rows(3, 16).length > 1 || rows(3, 17).length > 1 || rows(1, 42).length > 1 || rows(1, 43).length > 1)
    return result('counterexample', 'duplicate-sequence');
  if (has(1, 43) && (!has(1, 42) || tick(1, 43) < tick(1, 42))) return result('counterexample', 'up-before-observed-down');
  if (report.case !== 'normal') {
    if (!one(3, 20) || !one(5, 90) || tick(3, 20) < tick(3, 14) || tick(5, 90) < tick(3, 20)) return unknown('suspension-not-established');
    if (report.case.includes('worker-death') && !(before(4, 7, 81) && (tick(4, 81) < tick(3, 86) || one(3, 95)))) return unknown('worker-death-not-observed');
    if (report.case.includes('parent-death') && !(before(4, 8, 82) && (tick(4, 82) < tick(3, 86) || one(3, 95)))) return unknown('parent-death-not-observed');
    if (report.case === 'after-down-owner-death') {
      if (!one(3, 16) || tick(3, 16) >= tick(3, 20) || !one(4, 9) || !has(4, 83)) return unknown('owner-death-phase-not-reached');
      if (has(3, 17)) return result('counterexample', 'return-after-death-injection');
      return unknown('owner-death-in-flight-input-unknown');
    }
    if (!one(3, 86) || tick(3, 86) <= tick(5, 90) || !(one(4, 6) || (report.case.includes('parent-death') && one(3, 95)))) return unknown('resume-not-observed');
    if (report.case.startsWith('physical-')) {
      // Attended physical exercise + untagged records, NOT authenticated provenance.
      const during = r => BigInt(r.ticks) > tick(3, 20) && BigInt(r.ticks) < tick(3, 86);
      if (!rows(1, 45).some(during) || !rows(2, 63).some(during) ||
          (report.case === 'physical-overlap' && (!rows(1, 46).some(during) || !rows(2, 64).some(during)))) return unknown('physical-phase-not-observed');
    }
    if (report.case === 'physical-before-check') {
      if (!before(3, 86, 97) || !before(3, 97, 100) || !before(3, 100, 18) || has(3, 98) || has(3, 99))
        return unknown('held-left-final-sample-not-established');
      const early = r => BigInt(r.ticks) >= tick(3, 20) && BigInt(r.ticks) <= tick(3, 100);
      if (rows(1, 46).some(early) || rows(2, 64).some(early)) return unknown('physical-released-before-final-sample');
      if (!one(0, 101) || tick(0, 101) < tick(3, 100) || tick(0, 101) >= tick(0, 94))
        return unknown('held-release-cue-not-established');
    }
    const precheck = ['paused-before-final-check', 'worker-death-before-check', 'parent-death-before-check', 'physical-before-check'].includes(report.case);
    if (precheck) {
      if (has(3, 16) || has(1, 42) || has(1, 43)) return result('counterexample', 'input-after-precheck-fault');
      return !has(3, 15) && one(3, 18) && one(3, 19) ? result('observed-as-specified', 'precheck-refused-in-window') : unknown('missing-refusal');
    }
    if (!before(3, 14, 15) || tick(3, 15) >= tick(3, 20)) return unknown('final-check-not-reached');
    if ((has(1, 42) || has(1, 43)) && !one(3, 16)) return unknown('emission-phase-incomplete');
    if (report.case !== 'after-down-stall' && has(3, 16) && tick(3, 16) <= tick(3, 86)) return unknown('emission-phase-order-invalid');
    if (report.case === 'after-down-stall' && !(one(3, 16) && tick(3, 16) < tick(3, 20))) return unknown('after-down-phase-not-reached');
    if (report.case.endsWith('death-after-check')) {
      if ((has(1, 42) && tick(1, 42) > tick(3, 86)) || (has(1, 43) && tick(1, 43) > tick(3, 86)))
        return result('counterexample', 'input-observed-after-liveness-loss');
      return unknown('post-death-delivery-unknown');
    }
    // Deadline expiry is independently observed even when the tap remains
    // enabled. Only classify a NEW down inserted after that sample, not an up
    // returning from a pair whose down was already in flight before suspension.
    if (before(3, 86, 96) && before(3, 96, 16) &&
        rows(1, 42).some(r => BigInt(r.ticks) > tick(3, 96)))
      return result('counterexample', 'new-down-observed-after-deadline');
    // Sleeping alone does not establish timeout; query actual enabled state.
    if (!one(3, 93)) return unknown('tap-disable-not-observed-at-resume');
    if ((has(1, 42) && tick(1, 42) > tick(3, 86)) || (has(1, 43) && tick(1, 43) > tick(3, 86)))
      return result('counterexample', 'late-input-observed-after-disabled-boundary');
    return unknown('stale-proxy-delivery-unknown');
  }
  if (has(1, 44) || has(1, 45) || has(1, 46) || has(3, 21) || has(3, 22)) return unknown('ordinary-traffic-or-tap-loss');
  if (!before(3, 14, 15) || !before(3, 15, 16) || !before(3, 16, 17) || !one(3, 19) ||
      !before(1, 42, 43) || !before(2, 60, 61) || !one(2, 62)) return unknown('pair-or-fixture-receipt-incomplete');
  return result('observed-as-specified', 'one-pair-observed-not-release-proof');
}
