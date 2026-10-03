import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runnableCases, classify } from './report.mjs';

const local = name => fileURLToPath(new URL(name, import.meta.url));
const binary = local('.build/NativeMechanismExperiment.app/Contents/MacOS/NativeMechanismExperiment');
export const sourceFiles = Object.freeze(['main.swift', 'Model.swift', 'Adapter.swift', 'Experiment.c', 'Experiment.h',
  'Bootstrap.c', 'BootstrapPolicy.h', 'build.sh', 'run.mjs', 'report.mjs', '../../ClickGuardianNative.swift', '../../ProcessEpochFence.swift', '../../ProcessEpochFence.c']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function identity() {
  const sources = {};
  for (const file of sourceFiles) sources[file] = sha(await readFile(local(file)));
  return { sources, binarySHA256: sha(await readFile(binary)) };
}
export function command(args, platform) {
  if (platform !== 'darwin') throw new Error('mac-required');
  if (args.length === 1 && args[0] === '--record-build') return { mode: 'identity' };
  if (args.length === 2 && args[0] === '--run' && runnableCases.includes(args[1])) return { mode: 'run', scenario: args[1] };
  throw new Error('closed-case-required');
}
export function decode(bytes, scenario) {
  if (bytes.length > 262144) return { verdict: 'inconclusive', reason: 'output-overflow', productionAcceptance: false };
  let report;
  try { report = JSON.parse(bytes.toString('utf8')); } catch { return { verdict: 'inconclusive', reason: 'invalid-output', productionAcceptance: false }; }
  if (report?.case !== scenario) return { verdict: 'inconclusive', reason: 'case-mismatch', productionAcceptance: false };
  const result = classify(report);
  // Do not re-export unvalidated objects/content on malformed reports.
  return { ...result, ...(result.reason === 'invalid-report' || result.reason === 'incomplete-record-stream' ? {} : { observation: report }) };
}
function tool(args) {
  const value = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 8192 });
  if (value.status !== 0) throw new Error('tool-metadata-unavailable');
  return value.stdout.trim();
}
async function main(args) {
  const selected = command(args, process.platform);
  const current = await identity();
  if (selected.mode === 'identity') {
    const sdk = tool(['--sdk', 'macosx', '--show-sdk-version']);
    const swift = tool(['swiftc', '--version']).split('\n')[0];
    if (!/^[0-9]+(?:\.[0-9]+){0,3}$/.test(sdk) || !/^[A-Za-z0-9 .()+_:\/-]{1,256}$/.test(swift)) throw new Error('invalid-tool-metadata');
    await writeFile(local('.build/identity.json'), JSON.stringify({ ...current, sdk, swift }) + '\n', { mode: 0o600 });
    return;
  }
  const build = JSON.parse(await readFile(local('.build/identity.json'), 'utf8'));
  if (Object.keys(build).sort().join(',') !== 'binarySHA256,sdk,sources,swift' ||
      JSON.stringify(build.sources) !== JSON.stringify(current.sources) || build.binarySHA256 !== current.binarySHA256 ||
      typeof build.sdk !== 'string' || !/^[0-9]+(?:\.[0-9]+){0,3}$/.test(build.sdk) ||
      typeof build.swift !== 'string' || !/^[A-Za-z0-9 .()+_:\/-]{1,256}$/.test(build.swift)) throw new Error('stale-build-identity');
  const child = spawn(binary, ['--case', selected.scenario], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
  let size = 0, overflow = false, chunks = [], settled = false;
  const finish = result => {
    if (settled) return;
    settled = true; clearTimeout(deadline); clearTimeout(abandon);
    process.stdout.write(JSON.stringify({ schema: 'native-mechanism-result.v1', case: selected.scenario, build, ...result, productionAcceptance: false }) + '\n');
    process.exitCode = { 'observed-as-specified': 0, blocked: 2, inconclusive: 3, counterexample: 4 }[result.verdict] ?? 3;
  };
  // GUI consent also has its own deadline. Request graceful cancellation first.
  // Never escalate into an unobserved kill of a possibly suspended process tree.
  let abandon;
  const deadline = setTimeout(() => {
    child.kill('SIGTERM');
    abandon = setTimeout(() => {
      finish({ verdict: 'inconclusive', reason: 'supervisor-unresponsive-process-state-unknown' });
      child.stdout.destroy(); child.unref();
    }, 20000);
  }, 90000);
  child.stdout.on('data', bytes => {
    size += bytes.length;
    if (size > 262144) { overflow = true; chunks = []; }
    else if (!overflow) chunks.push(bytes);
  });
  child.on('error', () => finish({ verdict: 'blocked', reason: 'launch-unavailable' }));
  child.on('close', (code, signal) => {
    if (code !== 0 || signal) return finish({ verdict: 'inconclusive', reason: 'abnormal-supervisor-exit-process-state-unknown' });
    finish(overflow ? { verdict: 'inconclusive', reason: 'output-overflow' } : decode(Buffer.concat(chunks), selected.scenario));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    // No paths, raw compiler stderr, environment or foreign exception text.
    console.error('Experiment refused: requires Darwin, an exact case and a current local build identity. See README.');
    process.exitCode = 2;
  });
}
