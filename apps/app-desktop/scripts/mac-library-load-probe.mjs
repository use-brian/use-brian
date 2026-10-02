// Explicit opt-in EXECUTION diagnostic. No production authority or import-time work.
import { spawn } from 'node:child_process';
import { constants, accessSync, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const MAX_LOG = 64 * 1024;
// Deliberately local copy of the reviewed child-lifecycle primitive: bundling this
// diagnostic must not pull in the unrelated DER collector/extractor. Keep the
// known-exit/no-group-signal rule; tests exercise it independently here.
/**
 * Bounded single attempt. Only close (not exit, kill()'s return, or error) confirms
 * reaping/pipe closure. On limit/error/timeout kill the owned detached process
 * group once, wait at most two seconds for close, otherwise report UNCONFIRMED.
 * No retry or later pipeline steps after any failure. Arguments/output remain
 * private. Dependencies/limits are unit-test seams, not command-line options.
 */
export function runPrivateChild({ command, args, directory, label, env, deadlineMs = 15000 },
  { spawnChild = spawn, killGroup = pid => process.kill(-pid, 'SIGKILL'), closeGraceMs = 2000, cap = MAX_LOG } = {}) {
  const outFd = openSync(join(directory, `${label}.stdout.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let errFd;
  try { errFd = openSync(join(directory, `${label}.stderr.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (e) { closeSync(outFd); throw e; }
  return new Promise(resolveResult => {
    let child, timer, grace, finished = false, leaderExited = false, failure = null, killAttempted = false, killSent = false;
    const outputs = [[], []], sizes = [0, 0], fds = [outFd, errFd];
    const finish = (code, signal, closeConfirmed) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(grace);
      for (const fd of fds) {
        try { closeSync(fd); } catch { failure ??= 'log-close-error'; }
      }
      if (!closeConfirmed) {
        child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
      }
      resolveResult({ ok: closeConfirmed && !failure && code === 0 && signal === null,
        code, signal, failure, closeConfirmed, killAttempted, killSent,
        stdout: Buffer.concat(outputs[0]).toString('utf8'), stderr: Buffer.concat(outputs[1]).toString('utf8') });
    };
    const stop = why => {
      failure ??= why;
      if (finished || grace) return;
      // After exit, the former group leader's PID may be reused. Stuck pipes
      // do not justify signaling that numeric group ID after known leader death.
      if (!leaderExited && Number.isSafeInteger(child?.pid) && child.pid > 0) {
        killAttempted = true;
        try { killSent = killGroup(child.pid) !== false; } catch { /* NOT confirmation */ }
      }
      grace = setTimeout(() => finish(null, null, false), closeGraceMs);
    };
    try {
      child = spawnChild(command, args, { cwd: directory, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const [i, stream] of [child.stdout, child.stderr].entries()) {
        stream.on('error', () => stop('pipe-error'));
        stream.on('data', chunk => {
          if (finished) return;
          const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), keep = b.subarray(0, Math.max(0, cap - sizes[i]));
          try {
            if (keep.length) { writeFileSync(fds[i], keep); outputs[i].push(Buffer.from(keep)); sizes[i] += keep.length; }
          } catch { stop('log-error'); }
          if (keep.length < b.length) stop('output-limit');
        });
      }
      child.on('error', () => stop('spawn-error'));
      child.on('close', (code, signal) => finish(code, signal, true));
      // exit stops future signaling but cannot resolve the attempt.
      child.on('exit', () => { leaderExited = true; });
      timer = setTimeout(() => stop('timeout'), deadlineMs);
    } catch { failure = 'spawn-error'; finish(null, null, false); }
  });
}

export const optIn = '--allow-ad-hoc-library-load-tests';
export const allowedSource = 'int brian_library_load_value(void) { return 211; }\n';
export const disallowedSource = 'int brian_library_load_value(void) { return 307; }\n';
export const entitlements = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>\n';
const sourcePath = fileURLToPath(new URL('../native/computer-control/LibraryConstraintLoadProbe.c', import.meta.url));
const fail = reason => { throw new Error(reason); };
const reasons = new Set(['filesystem', 'unsupported', 'child-failed', 'child-unconfirmed', 'output-invalid', 'unexpected-result']);
function equalStat(a, b) {
  return ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
}
function readBounded(path, maximum, owned = false) {
  if (realpathSync(path) !== path) fail('filesystem');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum ||
        (owned && (before.uid !== process.getuid() || (before.mode & 0o7077)))) fail('filesystem');
    const bytes = Buffer.alloc(before.size + 1);
    let at = 0, count;
    while (at < bytes.length && (count = readSync(fd, bytes, at, bytes.length - at, null)) > 0) at += count;
    if (at !== before.size || !equalStat(before, fstatSync(fd)) || !equalStat(before, lstatSync(path))) fail('filesystem');
    return { bytes: bytes.subarray(0, at), stat: before };
  } finally { closeSync(fd); }
}
function exclusive(path, contents) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, contents); } finally { closeSync(fd); }
}
function executable(path) {
  const actual = realpathSync(path), st = statSync(actual);
  if (!st.isFile() || (st.mode & 0o022)) fail('unsupported');
  accessSync(actual, constants.X_OK); return actual;
}
function exists(path) {
  try { return statSync(path).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function version(text) {
  if (typeof text !== 'string' || !/^\d{1,3}(\.\d{1,3}){1,2}$/.test(text)) fail('unsupported');
  return text;
}
export function parseRunnerOutput(stdout) {
  // Exact one-line protocol, no duplicate keys, arbitrary text or error strings.
  for (const [result, loaded, functionMatched] of [['loaded', true, true], ['dlopen-null', false, false], ['policy-created', false, false]]) {
    const value = { schema: 1, result, loaded, functionMatched, productionAuthority: false };
    if (stdout === JSON.stringify(value) + '\n') return { result, loaded, functionMatched };
  }
  fail('output-invalid');
}
const notRun = () => ({ result: 'not-run', loaded: false, functionMatched: false });
function reportTemplate() {
  return { schema: 1, kind: 'ad-hoc-library-load-diagnostic', status: 'failed', phase: 'setup', failure: 'none',
    executionAttempted: false, observedDifferential: false,
    productionAuthority: false, certificateAuthentication: false, electronAcceptance: false,
    loadedBootstrapProof: false, kernelSigningEvidence: false, opaquePolicyValidation: false,
    cases: { baselineAllowed: notRun(), baselineDisallowed: notRun(), constrainedAllowed: notRun(), constrainedDisallowed: notRun() },
    provenance: { macOS: null, macOSBuild: null, architecture: null, sdk: null, node: null, appleClang: null, appleClangBuild: null,
      signing: 'ad-hoc', deploymentTarget: '14.0', codesign: 'macOS system tool; version identified by macOS build' } };
}
const nativeHost = { platform: process.platform, arch: process.arch, node: process.versions.node, tempRoot: tmpdir,
  childDependencies: undefined, checkSystemTools: () => {
    for (const tool of ['/usr/bin/xcode-select', '/usr/bin/sw_vers', '/usr/sbin/sysctl', '/usr/bin/codesign']) executable(tool);
  } };
// Host/child seams are for portable mocks only; no CLI/env switches expose them.
export async function runLibraryLoadProbe(args, host = nativeHost) {
  if (args.length !== 1 || args[0] !== optIn) fail('explicit-opt-in-required');
  if (host.platform !== 'darwin' || !['arm64', 'x64'].includes(host.arch) || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host.node) ||
      Number(host.node.split('.')[0]) < 20 || process.getuid() === 0 || process.getuid() !== process.geteuid() ||
      process.getgid() === 0 || process.getgid() !== process.getegid()) fail('unsupported');
  // All authorization/platform checks precede filesystem/process side effects.
  const report = reportTemplate(); report.provenance.node = host.node;
  const previousMask = process.umask(0o077);
  let directory, dirfd, dirStat;
  try {
    const root = realpathSync(host.tempRoot());
    directory = mkdtempSync(join(root, 'brian-library-load-')); chmodSync(directory, 0o700);
    dirfd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    dirStat = fstatSync(dirfd);
    const guard = () => {
      const st = lstatSync(directory), held = fstatSync(dirfd);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o700 ||
          st.dev !== dirStat.dev || st.ino !== dirStat.ino || held.dev !== st.dev || held.ino !== st.ino ||
          realpathSync(directory) !== directory || realpathSync(dirname(directory)) !== root ||
          process.getuid() === 0 || process.getuid() !== process.geteuid() || process.getgid() !== process.getegid()) fail('filesystem');
    };
    guard(); host.checkSystemTools();
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C' };
    let sequence = 0;
    const step = async (command, args, deadlineMs = 15000) => {
      guard();
      const label = String(++sequence).padStart(2, '0');
      const result = await runPrivateChild({ command, args, directory, label, env, deadlineMs }, host.childDependencies);
      guard();
      exclusive(join(directory, `${label}.status.json`), JSON.stringify({ code: result.code, signal: result.signal, failure: result.failure,
        closeConfirmed: result.closeConfirmed, killAttempted: result.killAttempted, killSent: result.killSent }) + '\n');
      if (!result.ok) fail(result.closeConfirmed ? 'child-failed' : 'child-unconfirmed');
      return result.stdout;
    };
    report.phase = 'sdk-discovery';
    // Only query selection, never xcrun/clang installer shims, xcodebuild or --install.
    const selection = (await step('/usr/bin/xcode-select', ['-p'])).trim();
    if (!selection.startsWith('/') || selection.includes('\n') || selection.includes('\0')) fail('unsupported');
    const developer = realpathSync(selection), xcode = join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang');
    const isXcode = exists(xcode);
    const compiler = executable(isXcode ? xcode : join(developer, 'usr/bin/clang'));
    const sdk = realpathSync(join(developer, isXcode ? 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk' : 'SDKs/MacOSX.sdk'));
    if (compiler === '/usr/bin/clang' || !statSync(sdk).isDirectory()) fail('unsupported');
    const sdkInfo = JSON.parse(readBounded(join(sdk, 'SDKSettings.json'), 256 * 1024).bytes.toString('utf8'));
    report.provenance.sdk = version(sdkInfo.Version);
    if (Number(report.provenance.sdk.split('.')[0]) < 14) fail('unsupported');
    report.provenance.macOS = version((await step('/usr/bin/sw_vers', ['-productVersion'])).trim());
    if (Number(report.provenance.macOS.split('.')[0]) < 14) fail('unsupported');
    const osBuild = (await step('/usr/bin/sw_vers', ['-buildVersion'])).trim();
    if (!/^[0-9]{2}[A-Z][0-9]{1,6}[a-z]?$/.test(osBuild)) fail('unsupported');
    report.provenance.macOSBuild = osBuild;
    const arm = (await step('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])).trim();
    if (!['0', '1'].includes(arm) || host.arch !== (arm === '1' ? 'arm64' : 'x64')) fail('unsupported');
    const architecture = arm === '1' ? 'arm64' : 'x86_64'; report.provenance.architecture = architecture;
    const clang = /^Apple clang version ([0-9]+\.[0-9]+\.[0-9]+) \(clang-([0-9.]+)\)$/m.exec(await step(compiler, ['--version']));
    if (!clang || clang[1].length > 32 || clang[2].length > 48) fail('unsupported');
    report.provenance.appleClang = clang[1]; report.provenance.appleClangBuild = clang[2];
    guard();
    const runnerSource = readBounded(sourcePath, 64 * 1024).bytes;
    if (runnerSource.includes(0)) fail('filesystem');
    for (const [name, contents] of [['runner.c', runnerSource], ['allowed.c', allowedSource], ['disallowed.c', disallowedSource], ['runner-entitlements.plist', entitlements]]) {
      exclusive(join(directory, name), contents); chmodSync(join(directory, name), 0o400);
    }
    mkdirSync(join(directory, 'module-cache'), { mode: 0o700 });
    const common = ['-arch', architecture, '-isysroot', sdk, '-mmacosx-version-min=14.0', '-std=c11', '-D_DARWIN_C_SOURCE',
      '-Wall', '-Wextra', '-Werror', '-O0', '-fno-modules', '-fmodules-cache-path=' + join(directory, 'module-cache')];
    report.phase = 'compile';
    for (const base of ['allowed', 'disallowed']) await step(compiler, [...common, '-dynamiclib', join(directory, `${base}.c`), '-o', join(directory, `${base}.dylib`)], 60000);
    await step(compiler, [...common, join(directory, 'runner.c'), '-framework', 'CoreFoundation', '-framework', 'Security', '-o', join(directory, 'baseline-runner')], 60000);
    exclusive(join(directory, 'constrained-runner'), readBounded(join(directory, 'baseline-runner'), 8 * 1024 * 1024, true).bytes);
    const pins = new Map();
    const pin = name => {
      const item = readBounded(join(directory, name), 8 * 1024 * 1024, true);
      pins.set(name, { stat: item.stat, digest: createHash('sha256').update(item.bytes).digest('hex') });
    };
    const pinned = () => {
      guard();
      for (const [name, before] of pins) {
        const item = readBounded(join(directory, name), 8 * 1024 * 1024, true);
        if (!equalStat(before.stat, item.stat) || before.digest !== createHash('sha256').update(item.bytes).digest('hex')) fail('filesystem');
      }
    };
    const sign = async (name, runner, constraint = false) => {
      // Replace ONLY disposable linker signatures. No identity lookup, certificates,
      // keychain, timestamps, preserved metadata or real app signing.
      pinned();
      readBounded(join(directory, name), 8 * 1024 * 1024, true);
      const args = ['--force', '--sign', '-', '--timestamp=none', '--digest-algorithm=sha256', '--identifier',
        runner ? 'invalid.brian.library-load.runner' : `invalid.brian.library-load.${name}`];
      if (runner) args.push('--options', 'runtime', '--entitlements', join(directory, 'runner-entitlements.plist'));
      if (constraint) args.push('--enforce-constraint-validity', '--library-constraint', join(directory, 'allowed-policy.plist'));
      await step('/usr/bin/codesign', [...args, join(directory, name)], 30000);
      await step('/usr/bin/codesign', ['--verify', '--strict', join(directory, name)], 15000);
      chmodSync(join(directory, name), runner ? 0o500 : 0o400); pin(name);
    };
    for (const name of ['runner.c', 'allowed.c', 'disallowed.c', 'runner-entitlements.plist', 'constrained-runner']) pin(name);
    report.phase = 'sign-baseline';
    await sign('allowed.dylib', false); await sign('disallowed.dylib', false); await sign('baseline-runner', true);
    pinned(); report.phase = 'policy-metadata'; report.executionAttempted = true;
    const policyResult = parseRunnerOutput(await step(join(directory, 'baseline-runner'), ['prepare-policy'], 8000));
    if (policyResult.result !== 'policy-created') fail('unexpected-result');
    const policy = readBounded(join(directory, 'allowed-policy.plist'), 4096, true);
    if ((policy.stat.mode & 0o7777) !== 0o400) fail('filesystem');
    pin('allowed-policy.plist'); pinned();
    report.phase = 'sign-constrained'; await sign('constrained-runner', true, true); pinned();
    for (const [key, runner, mode, expected] of [
      ['baselineAllowed', 'baseline-runner', 'load-allowed', 'loaded'],
      ['baselineDisallowed', 'baseline-runner', 'load-disallowed', 'loaded'],
      ['constrainedAllowed', 'constrained-runner', 'load-allowed', 'loaded'],
      ['constrainedDisallowed', 'constrained-runner', 'load-disallowed', 'dlopen-null'],
    ]) {
      report.phase = key; pinned();
      report.cases[key] = { result: 'incomplete', loaded: false, functionMatched: false };
      report.cases[key] = parseRunnerOutput(await step(join(directory, runner), [mode], 8000));
      pinned();
      if (report.cases[key].result !== expected) fail('unexpected-result');
    }
    report.observedDifferential = true; report.status = 'passed-diagnostic'; report.phase = 'complete';
  } catch (error) {
    report.status = 'failed'; report.failure = reasons.has(error?.message) ? error.message : 'filesystem';
  } finally {
    if (directory && dirfd !== undefined) {
      try {
        const now = lstatSync(directory), held = fstatSync(dirfd);
        if (now.isDirectory() && !now.isSymbolicLink() && now.uid === process.getuid() && (now.mode & 0o7777) === 0o700 &&
            now.dev === dirStat.dev && now.ino === dirStat.ino && held.ino === now.ino && realpathSync(directory) === directory) {
          const text = JSON.stringify(report, null, 2) + '\n';
          if (Buffer.byteLength(text) > 8192) fail('filesystem');
          exclusive(join(directory, 'diagnostic.json'), text);
        } else { report.status = 'failed'; report.observedDifferential = false; report.failure = 'filesystem'; }
      } catch { report.status = 'failed'; report.observedDifferential = false; report.failure = 'filesystem'; }
      try { closeSync(dirfd); } catch { report.status = 'failed'; report.observedDifferential = false; report.failure = 'filesystem'; }
    }
    process.umask(previousMask);
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLibraryLoadProbe(process.argv.slice(2)).then(report => {
    console.log(JSON.stringify(report)); if (report.status !== 'passed-diagnostic') process.exitCode = 1;
  }).catch(() => {
    const report = reportTemplate(); report.status = 'refused'; report.phase = 'opt-in-or-platform'; report.failure = 'unsupported';
    console.log(JSON.stringify(report)); process.exitCode = 1;
  });
}
