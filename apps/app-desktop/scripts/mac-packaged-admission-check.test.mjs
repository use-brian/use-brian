// Portable composition/lifecycle tests. These do NOT claim native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { admissionMarker, admissionCanary, appendLocalCleanupWarning, requireAdmissionDifferential,
  runAdmissionComposition, checkPackagedAdmission, admissionRootSigningArguments, cleanupAdmissionArtifacts, admissionChildEnvironment } from './mac-packaged-admission-check.mjs';
import { runPrivateChild } from './mac-library-constraint-fixture.mjs';

const result = overrides => ({ ok: true, code: 0, signal: null, failure: null, closeConfirmed: true,
  killAttempted: false, killSent: false, stdout: admissionMarker, stderr: '', ...overrides });

test('local cleanup warning survives message-only and already-rendered stack logging', () => {
  const error = new Error('package check refused');
  const original = error.stack; // materialize before annotating
  const warning = 'Child termination unconfirmed; inspect retained private copies locally.';
  appendLocalCleanupWarning(error, warning);
  assert.equal(error.localCleanupWarning, warning);
  assert.ok(error.message.includes(warning));
  assert.ok(error.stack.includes(original));
  assert.ok(error.stack.includes(warning));
});

test('baseline signing files resolve in caller cwd before the private child changes cwd', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'admission-signing-paths-')));
  try {
    const values = { entitlements: '<plist><dict/></plist>', keychain: 'fixture only', requirements: 'designated => true' };
    for (const [name, value] of Object.entries(values)) fs.writeFileSync(join(directory, name), value);
    const identity = 'a'.repeat(40);
    const options = { identity, keychain: relative(process.cwd(), join(directory, 'keychain')) };
    const root = { entitlements: relative(process.cwd(), join(directory, 'entitlements')),
      requirements: relative(process.cwd(), join(directory, 'requirements')) };
    const args = admissionRootSigningArguments(options, root);
    assert.deepEqual(args, ['--force', '--sign', identity, '--timestamp', '--options', 'runtime',
      '--entitlements', join(directory, 'entitlements'), '--keychain', join(directory, 'keychain'),
      '--requirements', join(directory, 'requirements')]);
    assert.ok(!args.includes('--deep')); assert.ok(!args.includes('--library-constraint'));
    const childDirectory = join(directory, 'private-child'); fs.mkdirSync(childDirectory);
    const checked = await runPrivateChild({ command: process.execPath,
      args: ['-e', `const fs = require('node:fs'), a = process.argv.slice(1);
        console.log(JSON.stringify(Object.fromEntries(['entitlements','keychain','requirements'].map(name =>
          [name, fs.readFileSync(a[a.indexOf('--' + name) + 1], 'utf8')]))));`, '--', ...args],
      directory: childDirectory, label: 'paths', env: { PATH: '/usr/bin:/bin' } });
    assert.equal(checked.ok, true); assert.equal(checked.closeConfirmed, true);
    assert.deepEqual(JSON.parse(checked.stdout), values);
    const inline = admissionRootSigningArguments({ identity }, { ...root, requirements: '=designated => true' });
    assert.equal(inline[inline.indexOf('--requirements') + 1], '=designated => true');
    assert.ok(!inline.includes('--keychain'));
    assert.throws(() => admissionRootSigningArguments(options, { entitlements: join(directory, 'absent') }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('only fixed codesign receives builder keychain context; real canary child stays isolated', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'admission-environment-test-'));
  try {
    const signingEnv = { HOME: '/original/home', PATH: '/original/bin', CSC_KEY_PASSWORD: 'fixture-secret',
      APPLE_APP_SPECIFIC_PASSWORD: 'fixture-notary-secret', DYLD_INSERT_LIBRARIES: '/developer/override' };
    const privateEnv = { HOME: directory, TMPDIR: directory, PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' };
    const signer = admissionChildEnvironment('/usr/bin/codesign', false, privateEnv, signingEnv);
    assert.deepEqual(signer, signingEnv);
    signer.HOME = '/changed'; assert.equal(signingEnv.HOME, '/original/home');
    for (const [command, attempt] of [['/usr/bin/ditto', false], ['/tmp/codesign', false],
      ['/usr/bin/codesign', true], [process.execPath, true]]) {
      const chosen = admissionChildEnvironment(command, attempt, privateEnv, signingEnv);
      assert.deepEqual(chosen, privateEnv);
      assert.equal(chosen.CSC_KEY_PASSWORD, undefined);
      assert.equal(chosen.APPLE_APP_SPECIFIC_PASSWORD, undefined);
      assert.equal(chosen.DYLD_INSERT_LIBRARIES, undefined);
    }
    const result = await runPrivateChild({ command: process.execPath,
      args: ['-e', `process.stdout.write(JSON.stringify({ home: process.env.HOME, node: process.env.ELECTRON_RUN_AS_NODE,
        leaked: ['CSC_KEY_PASSWORD','APPLE_APP_SPECIFIC_PASSWORD','DYLD_INSERT_LIBRARIES'].some(key => key in process.env) }));`],
      directory, label: 'canary-environment', env: admissionChildEnvironment(process.execPath, true, privateEnv, signingEnv) });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.stdout), { home: directory, node: '1', leaked: false });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('confirmed failure retains private logs, removes app copies, and preserves uncertainty rules', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'admission-cleanup-test-'));
  try {
    for (const name of ['baseline', 'constrained']) fs.mkdirSync(join(directory, name));
    fs.writeFileSync(join(directory, '08.stderr.log'), 'PRIVATE_TOOL_DIAGNOSTIC', { mode: 0o600 });
    const failure = new Error('child 08 failed');
    cleanupAdmissionArtifacts(directory, failure, true);
    assert.ok(fs.existsSync(join(directory, 'baseline')));
    cleanupAdmissionArtifacts(directory, failure, false);
    for (const name of ['baseline', 'constrained']) assert.ok(!fs.existsSync(join(directory, name)));
    assert.equal(fs.readFileSync(join(directory, '08.stderr.log'), 'utf8'), 'PRIVATE_TOOL_DIAGNOSTIC');
    assert.equal(fs.statSync(join(directory, '08.stderr.log')).mode & 0o777, 0o600);
    assert.ok(failure.stack.includes(directory));
    assert.ok(!failure.stack.includes('PRIVATE_TOOL_DIAGNOSTIC'));
    cleanupAdmissionArtifacts(directory, undefined, false);
    assert.ok(!fs.existsSync(directory));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('only exact successful baseline and closed, non-local refusal compose', () => {
  const refusal = result({ ok: false, code: null, signal: 'SIGKILL', stdout: '' });
  requireAdmissionDifferential(result(), refusal);
  for (const bad of [result({ code: 1 }), result({ stdout: '' }), result({ stdout: admissionMarker + 'extra' }), result({ closeConfirmed: false }), result({ signal: 'SIGTERM' })]) {
    assert.throws(() => requireAdmissionDifferential(bad, refusal));
  }
  for (const bad of [result(), result({ stdout: '', code: 0 }), { ...refusal, failure: 'timeout' }, { ...refusal, killAttempted: true }, { ...refusal, closeConfirmed: false }, { ...refusal, stderr: admissionMarker }]) {
    assert.throws(() => requireAdmissionDifferential(result(), bad));
  }
});

test('copy-only root removal/re-sign precedes identical substitutions and fixed direct canaries', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'admission-composition-test-'));
  try {
    const baseline = join(directory, 'baseline.app'), constrained = join(directory, 'constrained.app'), stock = join(directory, 'stock.app');
    for (const app of [baseline, constrained]) {
      fs.mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
      fs.mkdirSync(join(app, 'Contents/Frameworks/Electron Framework.framework'), { recursive: true });
      fs.writeFileSync(join(app, 'Contents/MacOS/Use Brian'), Buffer.from('dummy executable'));
    }
    const calls = [], env = { HOME: directory, PATH: '/usr/bin:/bin' };
    const rootArgs = ['--force', '--sign', 'a'.repeat(40), '--keychain', '/selected/keychain', '--entitlements', '/selected/entitlements', '--options', 'runtime'];
    await runAdmissionComposition({ baseline, constrained, stock, rootArgs, directory, env }, async (...args) => {
      calls.push(args);
      return args[0] === join(constrained, 'Contents/MacOS/Use Brian') ? result({ code: 1, stdout: '' }) : result();
    });
    assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/codesign', ['--remove-signature', baseline]]);
    assert.deepEqual(calls[1].slice(0, 2), ['/usr/bin/codesign', [...rootArgs, baseline]]);
    assert.equal(calls.length, 7);
    assert.deepEqual(calls.slice(3, 5).map(c => c[1]), [baseline, constrained].map(app => [join(stock, 'Contents/Frameworks/Electron Framework.framework'), join(app, 'Contents/Frameworks/Electron Framework.framework')]));
    for (const c of calls.slice(5)) {
      assert.deepEqual(c[1], ['-e', admissionCanary]);
      assert.deepEqual(c[2], { ...env, ELECTRON_RUN_AS_NODE: '1' }); assert.equal(c[3], true);
    }
    assert.ok(!calls.slice(0, 3).some(c => c[1].includes(constrained)));
    assert.ok(calls[2][1].includes(`=certificate leaf = H"${'a'.repeat(40)}" and identifier "ai.usebrian.desktop"`));
    calls.length = 0;
    for (const app of [baseline, constrained]) fs.mkdirSync(join(app, 'Contents/Frameworks/Electron Framework.framework'), { recursive: true });
    await assert.rejects(runAdmissionComposition({ baseline, constrained, stock, rootArgs, directory, env }, async (...args) => {
      calls.push(args); return result({ code: 1, stdout: '' });
    }), /baseline did not load/);
    assert.equal(calls.length, 6); // no constrained launch following early baseline failure
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const exitFirst of [false, true]) test(`bounded runner retains close uncertainty; exitFirst=${exitFirst}`, async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'admission-lifecycle-test-'));
  try {
    const child = new EventEmitter(); child.pid = 12345;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    const kills = [];
    const promise = runPrivateChild({ command: '/fixed', args: [], directory, label: 'child', env: {}, deadlineMs: 10 }, {
      spawnChild: () => child, killGroup: pid => { kills.push(pid); return true; }, closeGraceMs: 10,
    });
    if (exitFirst) child.emit('exit', 1, null);
    const evidence = await promise;
    assert.equal(evidence.closeConfirmed, false); assert.equal(evidence.failure, 'timeout');
    assert.deepEqual(kills, exitFirst ? [] : [12345]);
    child.emit('close', 1, null); // late close cannot retroactively claim success
    assert.equal(evidence.closeConfirmed, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('close evidence and bounded output are required, not kill success', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'admission-output-test-'));
  try {
    const child = new EventEmitter(); child.pid = 12345;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    const promise = runPrivateChild({ command: '/fixed', args: [], directory, label: 'child', env: {}, deadlineMs: 100 }, {
      spawnChild: () => child, killGroup: () => true, closeGraceMs: 10, cap: 4,
    });
    child.stdout.write('too much output'); child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
    const evidence = await promise;
    assert.equal(evidence.closeConfirmed, true); assert.equal(evidence.failure, 'output-limit');
    assert.equal(evidence.stdout, 'too '); assert.equal(evidence.ok, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('production entry fails closed off macOS before touching package', { skip: process.platform === 'darwin' }, async () => {
  await assert.rejects(checkPackagedAdmission({}, {}), /native macOS required/);
});
