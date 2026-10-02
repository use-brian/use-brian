// Unit-test support ONLY. These invented numbers are not performance evidence.
import { manifest, manifestDigest } from './eval.mjs';
export function syntheticRows(trials = 1) {
  const context = Object.fromEntries(['hardware', 'network', 'models', 'build', 'policy'].map((k, i) => [k, String(i + 1).repeat(64)]));
  const rows = [{ type: 'header', version: 1, manifest: manifestDigest, source: 'synthetic', os: 'macos', trials, ...context, calibrationFrozen: true, heldOutSealed: true, randomizedOrder: true }];
  for (const f of manifest.fixtures) for (let trial = 1; trial <= trials; trial++) for (const lane of manifest.lanes) {
    const cv = lane === 'vision-only' || !f.axComplete;
    const kind = cv ? 'vision' : lane === 'hybrid-ax' ? 'jev' : 'llm';
    const decisionMs = kind === 'jev' ? 75 : 100;
    rows.push({
      type: 'run', fixture: f.id, lane, trial, ...context,
      attended: true, evidenceComplete: true, signedPackaged: true,
      success: true, interventions: 0, actions: 1,
      unauthorized: 0, wrongWindow: 0, postRevocationDispatch: 0, duplicateEffects: 0, privacyDefects: 0, shadowDispatches: 0,
      screenshots: Number(cv), imageUploads: Number(cv), durationMs: 500,
      stopMs: f.stopRequired ? [50] : [],
      steps: [{ slot: 1, selection: 'correct', dispatched: true, perception: cv ? 'cv' : 'ax', acceptedFast: kind === 'jev', fallback: 'none', observationMs: 100, decisionMs, dispatchMs: 10, verificationMs: 20, warmAx: !cv,
        attempts: [{ kind, outcome: 'ok', latencyMs: decisionMs, inputTokens: 10, outputTokens: 2, incurredUsd: .001, keySource: 'workspace', usageComplete: true }],
      }],
    });
  }
  return rows;
}
export const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
