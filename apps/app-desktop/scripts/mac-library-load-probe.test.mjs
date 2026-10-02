// Portable mocks/source checks ONLY. No Apple tools or generated C are executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLibraryLoadProbe, runPrivateChild, parseRunnerOutput, optIn, allowedSource, disallowedSource, entitlements } from './mac-library-load-probe.mjs';
const line = result => JSON.stringify({ schema: 1, result, loaded: result === 'loaded', functionMatched: result === 'loaded', productionAuthority: false }) + '\n';
function temp(t) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'library-load-test-')));
  t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}
function child(action) {
  const value = new EventEmitter(); value.stdout = new PassThrough(); value.stderr = new PassThrough(); value.pid = 12345; value.unref = () => {};
  queueMicrotask(() => action(value)); return value;
}
function closed(c, code = 0, signal = null) { c.stdout.end(); c.stderr.end(); c.emit('exit', code, signal); c.emit('close', code, signal); }
function mock(t, { failStep = 0, arch = 'arm64', arm = '1', mutate, output } = {}) {
  const root = temp(t), developer = join(root, 'developer'), sdk = join(developer, 'SDKs/MacOSX.sdk'), calls = [];
  mkdirSync(join(developer, 'usr/bin'), { recursive: true }); mkdirSync(sdk, { recursive: true });
  writeFileSync(join(developer, 'usr/bin/clang'), 'FAKE COMPILER', { mode: 0o700 });
  writeFileSync(join(sdk, 'SDKSettings.json'), '{"Version":"26.5"}');
  const host = { platform: 'darwin', arch, node: '25.5.0', tempRoot: () => root, checkSystemTools: () => {}, childDependencies: {
    spawnChild(command, args, options) {
      calls.push({ command, args, options });
      return child(c => {
        if (calls.length === failStep) { c.stdout.write(line('dlopen-null')); c.stderr.write('/Users/SECRET/ERROR/CDHASH'); closed(c, 1); return; }
        let text = '';
        if (command === '/usr/bin/xcode-select') text = developer + '\n';
        else if (command === '/usr/bin/sw_vers') text = args[0] === '-productVersion' ? '26.6.2\n' : '25G83\n';
        else if (command === '/usr/sbin/sysctl') text = arm + '\n';
        else if (args[0] === '--version') text = 'Apple clang version 21.0.0 (clang-2100.1.1.101)\nInstalledDir: /SECRET\n';
        else if (command.endsWith('/clang')) writeFileSync(args.at(-1), Buffer.alloc(128, 0x41), { mode: 0o700 });
        else if (command === '/usr/bin/codesign') { /* NO real signing; driver validation only */ }
        else if (command.startsWith(options.cwd + '/')) {
          assert(['baseline-runner', 'constrained-runner'].includes(command.split('/').at(-1)));
          if (args[0] === 'prepare-policy') {
            writeFileSync(join(options.cwd, 'allowed-policy.plist'), 'SYNTHETIC PRIVATE POLICY; NOT SIGNING EVIDENCE', { mode: 0o400 });
            text = line('policy-created');
          } else text = line(command.endsWith('/constrained-runner') && args[0] === 'load-disallowed' ? 'dlopen-null' : 'loaded');
        } else assert.fail('Unrecognized mock tool');
        if (mutate) mutate({ command, args, options, calls });
        if (output) text = output({ command, args, text });
        c.stdout.write(text); closed(c);
      });
    }, killGroup: () => assert.fail('unexpected mock group kill') } };
  return { host, root, calls };
}

test('retained operator report records only the four-case ad-hoc differential', () => {
  // Checks the stored report's scope/shape, not cryptographic attestation of a run.
  const report = JSON.parse(readFileSync(new URL('./fixtures/mac-library-load.arm64-macos26.v1.json', import.meta.url), 'utf8'));
  assert.equal(report.status, 'passed-diagnostic'); assert.equal(report.phase, 'complete');
  assert.equal(report.executionAttempted, true); assert.equal(report.observedDifferential, true);
  assert.deepEqual(Object.values(report.cases).map(c => c.result), ['loaded', 'loaded', 'loaded', 'dlopen-null']);
  for (const key of ['productionAuthority', 'certificateAuthentication', 'electronAcceptance', 'loadedBootstrapProof', 'kernelSigningEvidence', 'opaquePolicyValidation']) assert.equal(report[key], false);
  assert.equal(report.provenance.macOSBuild, '25G83'); assert.equal(report.provenance.architecture, 'arm64');
  assert.equal(report.provenance.signing, 'ad-hoc');
});
test('explicit exact opt-in/platform/runtime required before ALL side effects', async () => {
  const host = { platform: 'darwin', arch: 'arm64', node: '20.0.0', tempRoot: () => assert.fail('side effect') };
  for (const args of [[], ['--help'], [optIn, optIn], [optIn, '/tmp/x'], [optIn, '--identity', '-'], [optIn, '--pid', '1'], [optIn, '--policy', 'x'], ['--allow-ad-hoc-format-fixture']])
    await assert.rejects(runLibraryLoadProbe(args, host));
  for (const patch of [{ platform: 'linux' }, { arch: 'ia32' }, { node: '19.0.0' }, { node: '25.5.0-secret' }])
    await assert.rejects(runLibraryLoadProbe([optIn], { ...host, ...patch }));
});
test('mocked differential: fixed sources, symmetric runtime/entitlement, actual execution opt-in, private bounded result', async t => {
  const m = mock(t), oldMask = process.umask(), report = await runLibraryLoadProbe([optIn], m.host);
  assert.equal(process.umask(), oldMask); assert.equal(report.status, 'passed-diagnostic'); assert.equal(report.observedDifferential, true);
  assert.equal(report.executionAttempted, true); assert.equal(m.calls.length, 21);
  assert.deepEqual(Object.values(report.cases).map(c => c.result), ['loaded', 'loaded', 'loaded', 'dlopen-null']);
  for (const key of ['productionAuthority', 'certificateAuthentication', 'electronAcceptance', 'loadedBootstrapProof', 'kernelSigningEvidence', 'opaquePolicyValidation']) assert.equal(report[key], false);
  const directory = m.calls[0].options.cwd;
  assert.equal(statSync(directory).mode & 0o7777, 0o700);
  assert.equal(statSync(join(directory, 'baseline-runner')).mode & 0o7777, 0o500);
  assert.equal(statSync(join(directory, 'constrained-runner')).mode & 0o7777, 0o500);
  for (const file of ['allowed.dylib', 'disallowed.dylib', 'allowed-policy.plist']) assert.equal(statSync(join(directory, file)).mode & 0o7777, 0o400);
  assert.equal(readFileSync(join(directory, 'allowed.c'), 'utf8'), allowedSource);
  assert.equal(readFileSync(join(directory, 'disallowed.c'), 'utf8'), disallowedSource);
  assert.equal(readFileSync(join(directory, 'runner-entitlements.plist'), 'utf8'), entitlements);
  assert.equal((entitlements.match(/<key>/g) ?? []).length, 1);
  const signs = m.calls.filter(c => c.command === '/usr/bin/codesign' && c.args.includes('--sign'));
  assert.equal(signs.length, 4);
  for (const c of signs) {
    assert(c.args.includes('--timestamp=none')); assert(c.args.includes('--digest-algorithm=sha256'));
    assert.equal(c.args[c.args.indexOf('--sign') + 1], '-');
    assert(!c.args.includes('--keychain') && !c.args.includes('--deep') && !c.args.includes('--preserve-metadata'));
  }
  const baseline = signs[2].args, constrained = signs[3].args;
  assert.deepEqual(baseline.slice(0, -1), constrained.slice(0, constrained.indexOf('--enforce-constraint-validity')));
  assert(!baseline.includes('--library-constraint')); assert(constrained.includes('--library-constraint'));
  assert.equal(baseline[baseline.indexOf('--options') + 1], 'runtime');
  assert.equal(m.calls.filter(c => c.command.startsWith(directory + '/')).length, 5);
  for (const c of m.calls) {
    assert.equal(c.options.cwd, directory); assert.equal(c.options.shell, false); assert.equal(c.options.detached, true);
    assert.deepEqual(Object.keys(c.options.env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
    assert(!['xcrun', 'xcodebuild', 'open', 'security', 'npm'].includes(c.command.split('/').at(-1)));
  }
  const json = readFileSync(join(directory, 'diagnostic.json'), 'utf8'); assert.deepEqual(JSON.parse(json), report);
  assert(Buffer.byteLength(json) < 8192);
  for (const secret of [m.root, 'PRIVATE POLICY', 'SECRET', 'CDHASH', 'plist', '211', '307']) assert(!json.includes(secret));
  for (const name of readdirSync(directory)) assert.equal(statSync(join(directory, name)).mode & 0o077, 0);
});
test('each child failure stops pipeline immediately; nonzero PLUS dlopen-null JSON is never rejection', async t => {
  for (let failStep = 1; failStep <= 21; ++failStep) {
    const m = mock(t, { failStep }), report = await runLibraryLoadProbe([optIn], m.host);
    assert.equal(report.status, 'failed'); assert.equal(report.observedDifferential, false); assert.equal(report.failure, 'child-failed');
    assert.equal(m.calls.length, failStep); assert(!JSON.stringify(report).includes('SECRET'));
    if (failStep >= 18) assert.equal(report.cases[report.phase].result, 'incomplete');
  }
});
test('only literal protocol accepted, malformed/noisy/fake authority output fails', () => {
  for (const result of ['loaded', 'dlopen-null', 'policy-created']) assert.equal(parseRunnerOutput(line(result)).result, result);
  for (const text of ['', 'null\n', line('invalid'), line('loaded') + line('loaded'), line('loaded').trim(), line('loaded').replace('false', 'true'),
    line('loaded').replace('"schema":1', '"schema":1,"schema":1'), line('loaded').replace('"loaded":true', '"loaded":false'), '/Users/SECRET\n' + line('dlopen-null')])
    assert.throws(() => parseRunnerOutput(text), /output-invalid/);
});
test('unexpected differential outcomes stop, never promote crashes or baseline refusal', async t => {
  for (const mode of ['baseline-refusal', 'constrained-loads', 'noise']) {
    const m = mock(t, { output: ({ command, args, text }) => {
      if (mode === 'baseline-refusal' && command.endsWith('/baseline-runner') && args[0] === 'load-allowed') return line('dlopen-null');
      if (mode === 'constrained-loads' && command.endsWith('/constrained-runner') && args[0] === 'load-disallowed') return line('loaded');
      if (mode === 'noise' && args[0] === 'prepare-policy') return '/SECRET\n' + text;
      return text;
    } });
    const report = await runLibraryLoadProbe([optIn], m.host);
    assert.equal(report.status, 'failed'); assert.equal(report.observedDifferential, false);
  }
});
test('artifact replacement/mutation/symlink after runner result invalidates observation', async t => {
  for (const mode of ['mutate', 'symlink']) {
    const m = mock(t, { mutate: ({ command, args, options }) => {
      if (command.endsWith('/baseline-runner') && args[0] === 'load-allowed') {
        const path = join(options.cwd, 'allowed.dylib');
        if (mode === 'mutate') { chmodSync(path, 0o600); writeFileSync(path, 'CHANGED'); }
        else { rmSync(path); symlinkSync(join(options.cwd, 'disallowed.dylib'), path); }
      }
    } });
    const report = await runLibraryLoadProbe([optIn], m.host);
    assert.equal(report.status, 'failed'); assert.equal(report.failure, 'filesystem'); assert.equal(m.calls.length, 18);
  }
});
test('native architecture and installed prerequisites required without fallback', async t => {
  const intel = mock(t, { arch: 'x64', arm: '0' });
  assert.equal((await runLibraryLoadProbe([optIn], intel.host)).provenance.architecture, 'x86_64');
  const translated = mock(t, { arch: 'x64', arm: '1' });
  assert.equal((await runLibraryLoadProbe([optIn], translated.host)).status, 'failed'); assert.equal(translated.calls.length, 4);
  const missing = mock(t); rmSync(join(missing.root, 'developer/usr/bin/clang'));
  assert.equal((await runLibraryLoadProbe([optIn], missing.host)).status, 'failed'); assert.equal(missing.calls.length, 1);
});
test('child lifecycle: exit is not close; timeout/overflow never signal after known exit', async t => {
  for (const overflow of [false, true]) {
    const result = await runPrivateChild({ command: '/mock', args: [], directory: temp(t), label: 'case', env: {}, deadlineMs: 5 }, {
      spawnChild: () => child(c => { c.emit('exit', 0, null); if (overflow) c.stdout.write(Buffer.alloc(100)); }),
      cap: 16, closeGraceMs: 5, killGroup: () => assert.fail('PID may be reused after exit'),
    });
    assert.equal(result.ok, false); assert.equal(result.closeConfirmed, false); assert.equal(result.killAttempted, false);
  }
});
test('child lifecycle: one live-group signal, bounded logs; signal/nonzero/error/unconfirmed never success', async t => {
  for (const mode of ['signal', 'nonzero', 'error', 'overflow', 'timeout', 'throw']) {
    let kills = 0;
    const result = await runPrivateChild({ command: '/mock', args: [], directory: temp(t), label: 'case', env: {}, deadlineMs: 5 }, {
      spawnChild: () => {
        if (mode === 'throw') throw Error('/SECRET');
        return child(c => {
          if (mode === 'signal') closed(c, null, 'SIGKILL');
          else if (mode === 'nonzero') closed(c, 24);
          else if (mode === 'error') { c.emit('error', Error('/SECRET')); closed(c, 1); }
          else if (mode === 'overflow') { c.stdout.write(Buffer.alloc(100)); closed(c); }
        });
      }, cap: 16, closeGraceMs: 5, killGroup: () => { ++kills; return true; },
    });
    assert.equal(result.ok, false); assert(kills <= 1); assert(Buffer.byteLength(result.stdout) <= 16);
  }
});
test('native source guards: own files and public SHA256 metadata, no kernel fabrication or dangerous modes', () => {
  const source = readFileSync(new URL('../native/computer-control/LibraryConstraintLoadProbe.c', import.meta.url), 'utf8');
  for (const text of ['argc != 2', 'prepare-policy', 'load-allowed', 'load-disallowed', 'proc_pidpath(getpid()', 'proc_pidinfo(getpid()',
    'pbi_svuid == owner', 'O_EXCL', 'O_NOFOLLOW', 'st_nlink != 1', 'directory_ok()', 'unchanged(&allowed)', 'unchanged(&disallowed)',
    'alarm(5)', '_exit(24)', 'RLIMIT_CORE', 'kSecCodeInfoDigestAlgorithms', 'kSecCodeAttributeUniversalFileOffset',
    'kSecCodeInfoDigestAlgorithm), 2', 'CFPropertyListCreateData', 'CFSTR("$in")', 'CFSTR("cdhash")',
    'dlopen(target->path, RTLD_NOW | RTLD_LOCAL)', 'if (!handle) return emit("dlopen-null"', 'SecTaskCreateFromSelf']) assert(source.includes(text), text);
  assert(!/getenv|csops|ProcessIdentity|SecStaticCodeCheckValidity\(|SecTrustEvaluate|SecItemCopy|SecCodeCopyGuest|AppKit|AXUI|CGEvent|socket\(|system\(|execv|posix_spawn/.test(source));
  assert(!source.includes('dlopen(argv[')); assert(!source.includes('dlerror(' + ');'));
  assert(source.includes('productionAuthority\\\":false'));
  const helper = readFileSync(new URL('../native/computer-control/Helper.swift', import.meta.url), 'utf8');
  assert(!helper.includes('LibraryConstraintLoadProbe')); assert(!/Broker\s*\(/.test(helper));
});
