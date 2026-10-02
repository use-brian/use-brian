// SYNTHETIC TEST DRIVER ONLY. No OS/helper/provider is exercised here.
// Invented usage and oracle answers MUST NOT be relabeled live-attended.
import { manifest } from './eval.mjs';
export function createSyntheticDriver({ unknownUsage = false, success = true, defect = false, failedAttempt = false } = {}) {
  return {
    source: 'synthetic',
    stop() {},
    async open(task, header) {
      const fixture = manifest.fixtures.find(f => f.id === task.fixture);
      const cv = task.lane === 'vision-only' || !fixture.axComplete;
      const kind = cv ? 'vision' : task.lane === 'hybrid-ax' ? 'jev' : 'llm';
      return {
        consent: { ...Object.fromEntries(['hardware', 'network', 'models', 'build', 'policy'].map(k => [k, header[k]])), attended: true, localConsent: true, fixtureOnly: true, signedPackaged: true },
        oracle: { async selection() { return { selection: 'correct' }; }, async task() { return { success }; } },
        async run(h) {
          h.beginStep({ slot: 1, perception: cv ? 'cv' : 'ax', warmAx: !cv });
          let end = h.beginSpan('observation');
          if (cv) h.event('screenshots'); end();
          end = h.beginSpan('decision');
          const finish = h.beginAttempt({ kind, keySource: 'workspace' });
          if (cv) h.event('imageUploads');
          finish({ outcome: failedAttempt ? 'failed' : 'ok', usage: unknownUsage ? null : { inputTokens: 10, outputTokens: 2, incurredUsd: .001 } });
          h.decision({ acceptedFast: kind === 'jev' && !failedAttempt, fallback: failedAttempt ? 'provider-failure' : 'none' }); end();
          end = h.beginSpan('dispatch'); h.delivered(); end();
          end = h.beginSpan('verification'); end();
          if (defect) { h.event('wrongWindow'); h.event('interventions'); }
          if (fixture.stopRequired) h.beginStop()();
          await h.endStep();
        },
        async attest() { return { evidenceComplete: true, attempts: 1, actions: 1 }; },
        async close() {},
      };
    },
  };
}
export const driver = createSyntheticDriver();
