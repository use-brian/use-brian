// Portable composition/lifecycle tests. These do NOT claim native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { admissionMarker, admissionCanary, appendLocalCleanupWarning, requireAdmissionDifferential,
  runAdmissionComposition, checkPackagedAdmission } from './mac-packaged-admission-check.mjs';
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
