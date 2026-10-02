import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFormatFixture, runPrivateChild, policyPlist, inertSource } from './mac-library-constraint-fixture.mjs';
import { extractStaticLibraryConstraintFormat, verifyLibraryConstraintPolicy } from './mac-library-constraints.mjs';
import { fixture, rebind, fatFixture } from './mac-library-constraints.test-fixtures.mjs';
const flag = '--allow-ad-hoc-format-fixture';
function temp(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'library-format-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fakeChild(action) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345;
  child.unref = () => {};
  queueMicrotask(() => action(child));
  return child;
}
function close(child, code = 0, signal = null) {
  child.stdout.end(); child.stderr.end(); child.emit('exit', code, signal); child.emit('close', code, signal);
}
function staticFixture(options = {}) {
  const f = fixture({ version: 0x20500, ...options });
  f.bytes.writeUInt32BE(0x10002, f.cdOffset + 12); rebind(f);
  return f;
}
function mockHost(t, { failStep = 0, arm = '1', clang = 'Apple clang version 21.0.0 (clang-2100.0.1)\nTarget: arm64-apple-darwin\nInstalledDir: /private/not-shareable\n' } = {}) {
  const root = temp(t), developer = join(root, 'tools'), sdk = join(developer, 'SDKs/MacOSX.sdk');
  mkdirSync(join(developer, 'usr/bin'), { recursive: true }); mkdirSync(sdk, { recursive: true });
  writeFileSync(join(developer, 'usr/bin/clang'), 'NOT A REAL COMPILER', { mode: 0o700 });
  writeFileSync(join(sdk, 'SDKSettings.json'), JSON.stringify({ Version: '26.5', PrivatePath: '/not-shareable' }));
  const notices = [], calls = [];
  const host = { platform: 'darwin', arch: 'arm64', node: '25.5.0', tempRoot: () => root, notice: text => notices.push(text),
    checkSystemTools: () => {}, // System prerequisites mocked; no Apple tools run.
    childDependencies: { spawnChild: (command, args, options) => {
      calls.push({ command, args, options });
      return fakeChild(child => {
        if (calls.length === failStep) { child.stderr.write('/Users/SECRET/child-error'); close(child, 1); return; }
        if (command === '/usr/bin/xcode-select') child.stdout.write(developer + '\n');
        else if (command === '/usr/bin/sw_vers') child.stdout.write(args[0] === '-productVersion' ? '26.6.2\n' : '25G123\n');
        else if (command === '/usr/sbin/sysctl') child.stdout.write(arm + '\n');
        else if (args[0] === '--version') child.stdout.write(clang);
        else if (command.endsWith('/clang')) {
          const cpu = args[1] === 'x86_64' ? { cpuType: 0x01000007, cpuSubtype: 3 } : {};
          writeFileSync(args.at(-1), staticFixture(cpu).bytes, { mode: 0o700 });
        }
        else if (command === '/usr/bin/codesign') { /* synthetic bytes already have a fake signature */ }
        else assert.fail('unrecognized child invocation');
        close(child);
      });
    }, killGroup: () => assert.fail('unexpected mock kill') } };
  return { host, root, notices, calls };
}

test('missing opt-in, extra args, wrong platform/version/arch have ZERO side effects', async () => {
  const host = { platform: 'darwin', arch: 'arm64', node: '20.0.0', tempRoot: () => assert.fail('side effect') };
  for (const args of [[], ['--help'], [flag, flag], [flag, '--identity', '-'], [flag, '/tmp/arbitrary'], [flag, '--pid', '1']]) await assert.rejects(collectFormatFixture(args, host));
  for (const patch of [{ platform: 'linux' }, { node: '18.0.0' }, { arch: 'ia32' }, { node: '20.1.2-secret' }]) await assert.rejects(collectFormatFixture([flag], { ...host, ...patch }));
});
test('fixed documented plist uses NSData membership and hypothetical Developer ID/team, not DER', () => {
  assert.match(policyPlist, /<key>validation-category<\/key><integer>6<\/integer>/);
  assert.match(policyPlist, /<key>team-identifier<\/key><string>ZZZZZZZZZZ<\/string>/);
  assert.match(policyPlist, /<key>\$in<\/key><array>/);
  const data = [...policyPlist.matchAll(/<data>(.*?)<\/data>/g)].map(m => Buffer.from(m[1], 'base64'));
  assert.deepEqual(data, [Buffer.alloc(20, 0x11), Buffer.alloc(20, 0x22)]);
  assert.equal(inertSource, 'int main(void) { return 0; }\n');
});
test('mocked full collection: no generated code execution, no identity, no secret sharing', async t => {
  const m = mockHost(t), mask = process.umask();
  const result = await collectFormatFixture([flag], m.host);
  assert.equal(process.umask(), mask);
  assert.equal(m.calls.length, 7);
  assert.deepEqual(m.calls.map(c => c.command.split('/').at(-1)), ['xcode-select', 'sw_vers', 'sw_vers', 'sysctl', 'clang', 'clang', 'codesign']);
  assert.equal(result.kind, 'static-format-fixture');
  assert.equal(result.productionAuthority, false); assert.equal(result.executed, false);
  assert.equal(result.kernelEvidence, false); assert.equal(result.cmsAuthentication, false);
  assert.equal(result.derPolicyValidation, 'unsupported'); assert.equal(result.policyPlist, policyPlist);
  assert.deepEqual(Buffer.from(result.rawLibraryConstraintBase64, 'base64'), staticFixture().raw);
  const directory = m.notices[0].slice('Private format-fixture results directory: '.length);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const name of readdirSync(directory)) assert.equal(statSync(join(directory, name)).mode & 0o077, 0);
  assert.equal(statSync(join(directory, 'inert')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(directory, 'library.coderequirement'), 'utf8'), policyPlist);
  const json = readFileSync(join(directory, 'format-fixture.json'), 'utf8');
  assert.deepEqual(JSON.parse(json), result);
  assert.ok(Buffer.byteLength(json) < 32 * 1024);
  for (const forbidden of [m.root, '/Users/', '/private/', 'InstalledDir', 'PrivatePath', 'keychain', 'cdHash', 'codeDirectory', staticFixture().expected.cdHash.toString('hex')]) assert.ok(!json.includes(forbidden));
  for (const call of m.calls) {
    assert.equal(call.options.shell, false); assert.equal(call.options.detached, true);
    assert.deepEqual(Object.keys(call.options.env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
    assert.equal(call.options.cwd, directory);
    assert.ok(!call.command.startsWith(directory));
    assert.ok(!['xcrun', 'xcodebuild', 'open', 'security', 'npm'].includes(call.command.split('/').at(-1)));
  }
  const compile = m.calls.at(-2), sign = m.calls.at(-1);
  assert.ok(compile.args.includes('-mmacosx-version-min=14.0'));
  assert.equal(sign.command, '/usr/bin/codesign');
  assert.deepEqual(sign.args, ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime', '--identifier',
    'invalid.brian.library-constraint-format-fixture', '--enforce-constraint-validity', '--library-constraint',
    join(directory, 'library.coderequirement'), join(directory, 'inert')]);
});
test('each failed child halts once, never retries or exposes private error', async t => {
  for (let failStep = 1; failStep <= 7; failStep++) {
    const m = mockHost(t, { failStep });
    await assert.rejects(collectFormatFixture([flag], m.host), { message: 'format fixture failed; inspect private results locally' });
    assert.equal(m.calls.length, failStep);
    assert.equal(m.notices.length, 1);
    assert.ok(!existsSync(join(m.calls[0].options.cwd, 'format-fixture.json')));
    const failure = JSON.parse(readFileSync(join(m.calls[0].options.cwd, 'collection-failure.json'), 'utf8'));
    assert.deepEqual(failure, { phase: `tool-${String(failStep).padStart(2, '0')}`, reason: 'operation-failed', productionAuthority: false });
  }
});
test('rejects unknown/translated architecture and non-Apple tool before compile/sign', async t => {
  for (const settings of [{ arm: '0' }, { arm: 'unknown' }, { clang: 'clang version 21.0.0' }]) {
    const m = mockHost(t, settings);
    await assert.rejects(collectFormatFixture([flag], m.host));
    assert.ok(m.calls.every(c => c.command !== '/usr/bin/codesign' && !c.args.includes('-o')));
  }
});
test('separate static extraction is synthetic self-consistency, never kernel evidence', () => {
  const f = staticFixture(), result = extractStaticLibraryConstraintFormat(f.bytes);
  assert.deepEqual(Object.keys(result).sort(), ['codeDirectoryVersion', 'kind', 'policyStatus', 'rawBlob']);
  assert.deepEqual(result.rawBlob, f.raw); result.rawBlob.fill(0);
  assert.deepEqual(extractStaticLibraryConstraintFormat(f.bytes).rawBlob, f.raw);
  assert.throws(() => verifyLibraryConstraintPolicy(result), { code: 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_UNSUPPORTED' });
  for (const b of [Buffer.alloc(10), new Uint8Array(f.bytes), fatFixture().bytes, fixture().bytes, Buffer.from(new SharedArrayBuffer(100))]) assert.throws(() => extractStaticLibraryConstraintFormat(b));
  for (const at of [500, f.cdOffset + f.hashStart, f.rawOffset + 8]) {
    const copy = Buffer.from(f.bytes); copy[at] ^= 1; assert.throws(() => extractStaticLibraryConstraintFormat(copy));
  }
});

test('private child success waits for close, not exit', async t => {
  const directory = temp(t); let child, settled = false;
  const promise = runPrivateChild({ command: '/mock', args: [], directory, label: 'success', env: {}, deadlineMs: 1000 }, {
    spawnChild: () => (child = fakeChild(c => { c.stdout.write('safe version\n'); c.emit('exit', 0, null); })),
    killGroup: () => assert.fail('must not kill'),
  }).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  close(child); const result = await promise;
  assert.equal(result.ok, true); assert.equal(result.closeConfirmed, true);
  assert.equal(result.stdout, 'safe version\n');
});
test('output cap kills group once, caps both private logs, and cannot report success', async t => {
  const directory = temp(t); let child, kills = 0;
  const result = await runPrivateChild({ command: '/mock', args: [], directory, label: 'cap', env: {} }, {
    cap: 16, spawnChild: () => (child = fakeChild(c => { c.stdout.write(Buffer.alloc(100)); c.stderr.write(Buffer.alloc(100)); })),
    killGroup: pid => { assert.equal(pid, 12345); kills++; queueMicrotask(() => close(child, null, 'SIGKILL')); },
  });
  assert.equal(kills, 1); assert.equal(result.ok, false); assert.equal(result.failure, 'output-limit');
  assert.equal(result.killAttempted, true); assert.equal(result.killSent, true); assert.equal(result.closeConfirmed, true);
  for (const name of ['cap.stdout.log', 'cap.stderr.log']) assert.equal(statSync(join(directory, name)).size, 16);
});
test('deadline and unsuccessful kill never claim close or termination', async t => {
  const directory = temp(t); let kills = 0;
  const result = await runPrivateChild({ command: '/mock', args: [], directory, label: 'timeout', env: {}, deadlineMs: 5 }, {
    spawnChild: () => fakeChild(() => {}), closeGraceMs: 5, killGroup: () => { kills++; throw new Error('/secret'); },
  });
  assert.equal(kills, 1); assert.equal(result.failure, 'timeout'); assert.equal(result.ok, false);
  assert.equal(result.closeConfirmed, false); assert.equal(result.killSent, false); assert.equal(result.code, null);
});
test('successful kill request without close does not establish termination', async t => {
  const directory = temp(t);
  const result = await runPrivateChild({ command: '/mock', args: [], directory, label: 'kill-unconfirmed', env: {}, deadlineMs: 5 }, {
    spawnChild: () => fakeChild(() => {}), closeGraceMs: 5, killGroup: () => true,
  });
  assert.equal(result.killSent, true); assert.equal(result.killAttempted, true);
  assert.equal(result.closeConfirmed, false); assert.equal(result.ok, false);
});
test('spawn errors/nonzero exit/signals are never successes', async t => {
  const directory = temp(t);
  for (const [i, action] of [c => close(c, 1), c => close(c, null, 'SIGTERM'), c => { c.pid = undefined; c.emit('error', new Error('secret')); close(c, -2); }].entries()) {
    const result = await runPrivateChild({ command: '/mock', args: [], directory, label: `error${i}`, env: {} }, { spawnChild: () => fakeChild(action), closeGraceMs: 5 });
    assert.equal(result.ok, false); assert.equal(result.closeConfirmed, true);
  }
  const result = await runPrivateChild({ command: '/mock', args: [], directory, label: 'throw', env: {} }, { spawnChild: () => { throw new Error('/secret'); } });
  assert.equal(result.closeConfirmed, false); assert.equal(result.failure, 'spawn-error');
});

// Apple's pinned signer.cpp wraps an empty CFData signature for ad-hoc signing.
// This is still a SYNTHETIC container test, not Apple DER/native acceptance.
function withSignatureWrapper(f, payloadBytes) {
  const cd = Buffer.from(f.bytes.subarray(f.cdOffset, f.rawOffset));
  const raw = Buffer.from(f.bytes.subarray(f.rawOffset));
  const sb = Buffer.alloc(36 + cd.length + raw.length + 8 + payloadBytes);
  sb.writeUInt32BE(0xfade0cc0); sb.writeUInt32BE(sb.length, 4); sb.writeUInt32BE(3, 8);
  sb.writeUInt32BE(0, 12); sb.writeUInt32BE(36, 16);
  sb.writeUInt32BE(11, 20); sb.writeUInt32BE(36 + cd.length, 24);
  sb.writeUInt32BE(0x10000, 28); sb.writeUInt32BE(36 + cd.length + raw.length, 32);
  cd.copy(sb, 36); raw.copy(sb, 36 + cd.length);
  sb.writeUInt32BE(0xfade0b01, 36 + cd.length + raw.length);
  sb.writeUInt32BE(8 + payloadBytes, 40 + cd.length + raw.length);
  f.bytes = Buffer.concat([f.bytes.subarray(0, f.signature), sb]);
  f.bytes.writeUInt32LE(sb.length, 188); f.bytes.writeBigUInt64LE(BigInt(sb.length), 152);
  f.cdOffset = f.signature + 36; f.rawOffset = f.cdOffset + cd.length;
  f.expected.slice.size = f.bytes.length;
  rebind(f);
  return f;
}
test('static format accepts header-only ad-hoc signature wrapper, rejects CMS bytes', () => {
  const f = withSignatureWrapper(staticFixture(), 0);
  assert.deepEqual(extractStaticLibraryConstraintFormat(f.bytes).rawBlob, f.raw);
  assert.throws(() => extractStaticLibraryConstraintFormat(withSignatureWrapper(staticFixture(), 1).bytes), /unsupported static fixture signature/);
});
test('static fixture rejects malformed lengths/slot/architecture/runtime even without kernel expectation', () => {
  for (const mutate of [
    f => f.bytes.writeUInt32BE(0x1000, f.signature + 20),
    f => f.bytes.writeUInt32BE(0, f.signature + 20),
    f => f.bytes.writeUInt32BE(0xffffffff, f.rawOffset + 4),
    f => f.bytes.writeUInt32BE(0x10000, f.cdOffset + 12), // not ad-hoc
    f => f.bytes.writeUInt32BE(2, f.cdOffset + 12), // not hardened runtime
    f => f.bytes.writeUInt32LE(6, 12), // not executable
    f => f.bytes.writeUInt32LE(2, 8), // unsupported subtype
  ]) {
    const f = staticFixture(); mutate(f); rebind(f);
    assert.throws(() => extractStaticLibraryConstraintFormat(f.bytes), /^Error: macOS library constraint:/);
  }
  const f = staticFixture();
  for (let n = 0; n < f.bytes.length; n++) assert.throws(() => extractStaticLibraryConstraintFormat(f.bytes.subarray(0, n)), /^Error: macOS library constraint:/);
});
test('missing prerequisites fail before build/sign without installer queries or retries', async t => {
  const noSystem = mockHost(t);
  noSystem.host.checkSystemTools = () => { throw new Error('/private/missing-tool'); };
  await assert.rejects(collectFormatFixture([flag], noSystem.host), { message: 'format fixture failed; inspect private results locally' });
  assert.equal(noSystem.calls.length, 0);
  for (const path of ['SDKs/MacOSX.sdk', 'usr/bin/clang']) {
    const m = mockHost(t); rmSync(join(m.root, 'tools', path), { recursive: true, force: true });
    await assert.rejects(collectFormatFixture([flag], m.host));
    assert.equal(m.calls.length, 1); assert.equal(m.calls[0].command, '/usr/bin/xcode-select');
  }
});
test('exit without close times out without signaling a potentially reused process group', async t => {
  const directory = temp(t);
  const result = await runPrivateChild({ command: '/mock', args: [], directory, label: 'unclosed', env: {}, deadlineMs: 5 }, {
    spawnChild: () => fakeChild(c => c.emit('exit', 0, null)), closeGraceMs: 5, killGroup: () => assert.fail('leader already exited'),
  });
  assert.equal(result.ok, false); assert.equal(result.closeConfirmed, false);
  assert.equal(result.killSent, false); assert.equal(result.killAttempted, false); assert.equal(result.failure, 'timeout');
});
test('late output overflow after exit cannot signal a recycled group ID', async t => {
  const directory = temp(t);
  const result = await runPrivateChild({ command: '/mock', args: [], directory, label: 'late', env: {} }, {
    cap: 16, closeGraceMs: 5,
    spawnChild: () => fakeChild(c => { c.emit('exit', 0, null); c.stdout.write(Buffer.alloc(100)); }),
    killGroup: () => assert.fail('leader already exited'),
  });
  assert.equal(result.ok, false); assert.equal(result.closeConfirmed, false);
  assert.equal(result.killAttempted, false); assert.equal(result.failure, 'output-limit');
});
test('static parser refusal produces a fixed classification without private errors', async t => {
  const m = mockHost(t), underlying = m.host.childDependencies.spawnChild;
  m.host.childDependencies.spawnChild = (command, args, options) => {
    if (command === '/usr/bin/codesign') {
      const bytes = readFileSync(args.at(-1)); bytes[500] ^= 1;
      writeFileSync(args.at(-1), bytes);
    }
    return underlying(command, args, options);
  };
  await assert.rejects(collectFormatFixture([flag], m.host));
  const directory = m.calls[0].options.cwd;
  assert(!existsSync(join(directory, 'format-fixture.json')));
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'collection-failure.json'), 'utf8')),
    { phase: 'static-extraction', reason: 'code page hash mismatch', productionAuthority: false });
});
test('mocked native Intel selection uses x86_64 and requires matching generated architecture', async t => {
  const m = mockHost(t, { arm: '0' }); m.host.arch = 'x64';
  const result = await collectFormatFixture([flag], m.host);
  assert.equal(result.provenance.architecture, 'x86_64');
  assert.deepEqual(m.calls.at(-2).args.slice(0, 2), ['-arch', 'x86_64']);
  assert.equal(m.calls.length, 7);
});
