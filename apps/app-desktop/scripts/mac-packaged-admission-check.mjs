// Explicit opt-in callable for the packaging signer, AFTER sealNativeBootstrap.
// One loaded-framework enforcement differential, NOT R1/R4 operational acceptance.
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import plist from 'plist';
import { getCurrentFuseWire, FuseState, FuseV1Options } from '@electron/fuses';
import { verifyMacFuseBytes, verifyMacBootstrap } from './electron-fuses.mjs';
import { requireElectronVersion } from './mac-asar-integrity.mjs';
import { encodeBootstrapApprovalRecord, verifyBootstrapApprovalCoverage } from './mac-bootstrap-anchor.mjs';
import { extractPackagedParentLibraryConstraints } from './mac-library-constraints.mjs';
import { compareObservedLibraryConstraintPolicy } from './mac-library-constraint-policy.mjs';
import { nativeHelperRelativePath } from './mac-native-signing-policy.mjs';
import { runPrivateChild } from './mac-library-constraint-fixture.mjs';

const require = createRequire(import.meta.url);
const framework = 'Contents/Frameworks/Electron Framework.framework';
const binary = 'Contents/MacOS/Use Brian';
export const admissionMarker = 'BRIAN_PACKAGED_ADMISSION_STOCK_NODE_43_2_0\n';
export const admissionCanary = `process.stdout.write(${JSON.stringify(admissionMarker)})`;
const fail = message => { throw new Error(`Packaged admission: ${message}`); };
const read = path => {
  const s = fs.statSync(path);
  if (!s.isFile() || s.size > 1024 ** 3) fail('invalid artifact size');
  return fs.readFileSync(path);
};
const digest = b => createHash('sha256').update(b).digest('hex');

// Builder may render only message/stack, not custom Error properties.
export function appendLocalCleanupWarning(error, warning) {
  error.localCleanupWarning = warning;
  error.message += `\n${warning}`;
  if (typeof error.stack === 'string' && !error.stack.includes(warning)) error.stack += `\n${warning}`;
}

export function requireAdmissionDifferential(baseline, constrained) {
  for (const result of [baseline, constrained]) {
    if (!result?.closeConfirmed || result.failure || result.killAttempted) fail('attempt incomplete or locally terminated');
  }
  if (baseline.code !== 0 || baseline.signal !== null || baseline.stdout !== admissionMarker) fail('baseline did not load stock Node canary');
  if (constrained.stdout.includes(admissionMarker.trim()) || constrained.stderr.includes(admissionMarker.trim()) ||
      !(Number.isInteger(constrained.code) && constrained.code !== 0 || ['SIGKILL', 'SIGABRT', 'SIGTRAP'].includes(constrained.signal))) fail('constrained copy did not refuse before canary');
}

// Test seam is composition only. Production entry below does not accept injected
// tools, stock paths, commands, environment, deadlines, or executable canaries.
export async function runAdmissionComposition({ constrained, baseline, stock, rootArgs, env }, step) {
  await step('/usr/bin/codesign', ['--remove-signature', baseline]);
  await step('/usr/bin/codesign', [...rootArgs, baseline]);
  const identity = rootArgs[rootArgs.indexOf('--sign') + 1];
  await step('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '-R',
    `=certificate leaf = H"${identity}" and identifier "ai.usebrian.desktop"`, baseline]);
  for (const app of [baseline, constrained]) {
    fs.rmSync(join(app, framework), { recursive: true });
    await step('/usr/bin/ditto', [join(stock, framework), join(app, framework)]);
  }
  const results = [];
  for (const app of [baseline, constrained]) {
    const result = await step(join(app, binary), ['-e', admissionCanary], { ...env, ELECTRON_RUN_AS_NODE: '1' }, true);
    if (app === baseline && (!result.closeConfirmed || result.failure || result.killAttempted || result.code !== 0 || result.signal !== null || result.stdout !== admissionMarker)) fail('baseline did not load stock Node canary');
    results.push(result);
  }
  requireAdmissionDifferential(...results);
  return { baseline: results[0], constrained: results[1] };
}

export async function checkPackagedAdmission(options, approval) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) fail('native macOS required');
  encodeBootstrapApprovalRecord(approval); // exact anchor schema, pinned version
  const { app, identity, keychain } = options;
  if (!/^[a-f0-9]{40}$/i.test(identity ?? '') || fs.realpathSync(app) !== app || !app.endsWith('/Use Brian.app')) fail('resolved signing context required');
  const root = options.optionsForFile?.(app);
  if (!root || typeof root.entitlements !== 'string' || root.hardenedRuntime !== true || root.additionalArguments?.length || root.signatureFlags?.length) fail('unsupported root signing options');
  const stock = join(dirname(require.resolve('electron/package.json')), 'dist/Electron.app');
  requireElectronVersion(JSON.parse(read(require.resolve('electron/package.json'))).version);
  requireElectronVersion(plist.parse(read(join(stock, framework, 'Versions/A/Resources/Info.plist')).toString()).CFBundleVersion);
  const stockBytes = read(join(stock, framework, 'Versions/A/Electron Framework'));
  verifyMacFuseBytes(stockBytes, false); // includes identical wires in EVERY slice
  if ((await getCurrentFuseWire(stock))[FuseV1Options.RunAsNode] !== FuseState.ENABLE) fail('stock RunAsNode disabled');
  const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'brian-packaged-admission-'));
  fs.chmodSync(directory, 0o700);
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C' };
  let sequence = 0, uncertain = false, failure;
  const evidence = [];
  const step = async (command, args, childEnv = env, attempt = false) => {
    const label = String(++sequence).padStart(2, '0');
    const result = await runPrivateChild({ command, args, directory, label, env: childEnv, deadlineMs: attempt ? 15000 : 120000 });
    uncertain ||= !result.closeConfirmed;
    evidence.push({ label, ...result });
    fs.writeFileSync(join(directory, `${label}.json`), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
    if (!result.closeConfirmed || result.failure || (!attempt && !result.ok)) fail(`child ${label} failed`);
    return result;
  };
  try {
    const requirement = `=certificate leaf = H"${identity}" and identifier "ai.usebrian.desktop"`;
    await step('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '-R', requirement, app]);
    const display = await step('/usr/bin/codesign', ['--display', '--verbose=4', app]);
    const team = `${display.stdout}\n${display.stderr}`.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
    if (!team) fail('missing team');
    // The caller has already completed sealNativeBootstrap's CMS inventory
    // checks. Do not launch its native inventory helper again in this experiment.
    await verifyMacBootstrap(app);
    verifyBootstrapApprovalCoverage(read(join(app, nativeHelperRelativePath)), approval);
    const parent = read(join(app, binary));
    for (const slice of extractPackagedParentLibraryConstraints(parent)) compareObservedLibraryConstraintPolicy(slice.rawBlob, { teamIdentifier: team, cdHashes: approval.libraryCDHashes });
    const constrained = join(directory, 'constrained/Use Brian.app'), baseline = join(directory, 'baseline/Use Brian.app');
    for (const copy of [constrained, baseline]) {
      await step('/usr/bin/ditto', [app, copy]);
      await step('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '-R', requirement, copy]);
      if (!read(join(copy, binary)).equals(parent)) fail('copy changed parent');
    }
    const rootArgs = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', '--entitlements', root.entitlements];
    if (keychain) rootArgs.push('--keychain', keychain);
    if (root.requirements) rootArgs.push('--requirements', root.requirements);
    if (root.timestamp) rootArgs.push(`--timestamp=${root.timestamp}`);
    const results = await runAdmissionComposition({ constrained, baseline, stock, rootArgs, directory, env }, async (command, args, childEnv, attempt) => {
      // Check both restored trees before either launch: root signatures are NOT
      // repaired after substitution. The baseline must exercise that same gap.
      if (attempt) {
        for (const copy of [baseline, constrained]) if (digest(read(join(copy, framework, 'Versions/A/Electron Framework'))) !== digest(stockBytes)) fail('stock copy mismatch');
        if (!read(join(constrained, binary)).equals(parent)) fail('constrained root changed');
      }
      return step(command, args, childEnv, attempt);
    });
    return { passed: true, scope: 'packaged-loaded-framework-differential-only', ...results };
  } catch (error) {
    failure = error;
    error.admissionEvidence = evidence;
    if (uncertain) {
      appendLocalCleanupWarning(error, `Child termination unconfirmed; retained private evidence and copies at ${directory}. Inspect locally before cleanup; no later PID/group signaling is safe.`);
    }
    throw error;
  } finally {
    if (!uncertain) {
      try { fs.rmSync(directory, { recursive: true, force: true }); }
      catch (error) {
        const warning = `Local cleanup failed at ${directory}: ${error.code}; inspect retained private artifacts locally.`;
        if (failure) appendLocalCleanupWarning(failure, warning);
        else {
          const refused = new Error('Packaged admission: local cleanup failed');
          appendLocalCleanupWarning(refused, warning); refused.admissionEvidence = evidence;
          throw refused;
        }
      }
    }
  }
}
