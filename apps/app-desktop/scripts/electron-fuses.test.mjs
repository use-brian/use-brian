import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPackage, getRawHeader } from '@electron/asar';
import { FuseVersion, FuseV1Options, FuseState, getCurrentFuseWire } from '@electron/fuses';
import plist from 'plist';
import { hardenMacBootstrap, verifyMacBootstrap, verifyMacFuseBytes, verifyFuseWire, bootstrapPolicy, requiredFuses } from './electron-fuses.mjs';

import { thinFramework, universalFramework, syntheticPageHashes } from './mac-asar-integrity.test-fixtures.mjs';

const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
// Full synthetic section/signature layouts, still no genuine signing or SDK execution.
const thin = thinFramework, fat = universalFramework;
async function syntheticFinalSign(b) {
  await writeFile(b.framework, syntheticPageHashes(await readFile(b.framework)));
}
async function bundle(t, binary = thin()) {
  const root = await mkdtemp(join(tmpdir(), 'brian-fuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'Use Brian.app'), contents = join(app, 'Contents');
  const frameworkRoot = join(contents, 'Frameworks/Electron Framework.framework');
  const framework = join(frameworkRoot, 'Versions/A/Electron Framework');
  await mkdir(join(frameworkRoot, 'Versions/A'), { recursive: true });
  await writeFile(framework, binary);
  await mkdir(join(frameworkRoot, 'Versions/A/Resources'));
  await writeFile(join(frameworkRoot, 'Versions/A/Resources/Info.plist'), plist.build({ CFBundleVersion: '43.2.0' }));
  await symlink('Versions/A/Electron Framework', join(frameworkRoot, 'Electron Framework'));
  const source = join(root, 'source');
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(join(source, 'dist/bootstrap.js'), 'console.log("trusted bootstrap")');
  await writeFile(join(source, 'package.json'), JSON.stringify({ main: 'dist/bootstrap.js' }));
  await mkdir(join(contents, 'Resources'), { recursive: true });
  const asar = join(contents, 'Resources/app.asar');
  await createPackage(source, asar);
  const header = getRawHeader(asar).headerString;
  const info = { CFBundleIdentifier: 'ai.usebrian.desktop', CFBundleExecutable: 'Use Brian', ElectronAsarIntegrity: {
    'Resources/app.asar': { algorithm: 'SHA256', hash: createHash('sha256').update(header).digest('hex') },
  } };
  const infoPath = join(contents, 'Info.plist');
  await writeFile(infoPath, plist.build(info));
  return { app, framework, info, infoPath, asar, source, context: {
    electronPlatformName: 'darwin', appOutDir: root, packager: { config: { electronVersion: '43.2.0' }, appInfo: { productFilename: 'Use Brian' } },
  } };
}

test('official API names and wire offsets match the native v1 policy', () => {
  assert.equal(FuseV1Options.RunAsNode, 0);
  assert.equal(FuseV1Options.EnableNodeOptionsEnvironmentVariable, 2);
  assert.equal(FuseV1Options.EnableNodeCliInspectArguments, 3);
  assert.equal(FuseV1Options.EnableEmbeddedAsarIntegrityValidation, 4);
  assert.equal(FuseV1Options.OnlyLoadAppFromAsar, 5);
  assert.equal(FuseState.DISABLE, 0x30); assert.equal(FuseState.ENABLE, 0x31);
  const wire = { version: FuseVersion.V1, ...Object.fromEntries(Object.entries(requiredFuses).map(([key, value]) => [key, value ? FuseState.ENABLE : FuseState.DISABLE])) };
  verifyFuseWire(wire);
  for (const key of Object.keys(requiredFuses)) for (const state of [undefined, '0', false, FuseState.REMOVED, FuseState.INHERIT, 255, wire[key] === 48 ? 49 : 48]) {
    assert.throws(() => verifyFuseWire({ ...wire, [key]: state }));
  }
  assert.throws(() => verifyFuseWire({ ...wire, version: '2' }));
});

test('real fuse API hardens/readbacks thin and universal synthetic frameworks before policy attestation', async t => {
  for (const binary of [thin(), fat()]) {
    const b = await bundle(t, binary);
    await assert.rejects(verifyMacBootstrap(b.app));
    await hardenMacBootstrap(b.context);
    await syntheticFinalSign(b);
    verifyFuseWire(await getCurrentFuseWire(b.app));
    assert.equal(verifyMacFuseBytes(await readFile(b.framework)), binary.readUInt32BE(0) === 0xcafebabe ? 2 : 1);
    assert.equal((await verifyMacBootstrap(b.app)).BrianElectronFusePolicy, bootstrapPolicy);
    // Browser-related optional fuses remain exactly as shipped, not broadly disabled.
    const wire = await getCurrentFuseWire(b.app);
    assert.equal(wire[FuseV1Options.EnableCookieEncryption], FuseState.DISABLE);
    assert.equal(wire[FuseV1Options.GrantFileProtocolExtraPrivileges], FuseState.ENABLE);
  }
});

test('universal verification rejects unsafe/missing second wire even when official first-wire read succeeds', async t => {
  const b = await bundle(t, fat(thin(0x01000007, '000011011'), thin()));
  verifyFuseWire(await getCurrentFuseWire(b.app));
  await assert.rejects(verifyMacBootstrap(b.app), /unsafe or unknown fuse|inconsistent architecture/);
  const missing = thin(); missing.fill(0, 512, 558);
  assert.throws(() => verifyMacFuseBytes(fat(thin(0x01000007, '000011011'), missing)), /missing/);
});

test('missing, duplicate, unknown, removed and truncated wires fail before flipping/signing', async t => {
  for (const mutate of [
    b => b.fill(0, 512, 544), b => { b[544] = 2; }, b => { b[545] = 7; },
    b => { b[545] = 10; }, b => { b[546] = FuseState.REMOVED; }, b => { b[548] = 255; },
    b => sentinel.copy(b, 650), b => b.writeUInt32LE(0, 4),
  ]) {
    const bytes = thin(); mutate(bytes);
    const b = await bundle(t, bytes);
    await assert.rejects(hardenMacBootstrap(b.context));
    assert.equal(plist.parse(await readFile(b.infoPath, 'utf8')).BrianElectronFusePolicy, undefined);
  }
  assert.throws(() => verifyMacFuseBytes(thin().subarray(0, 100)));
  const overlap = fat(); overlap.writeUInt32BE(256, 40);
  assert.throws(() => verifyMacFuseBytes(overlap));
  assert.throws(() => verifyMacFuseBytes(fat(thin(0x01000007, '000011011'), thin(0x0100000c, '010011011'))), /inconsistent/);
  const gapCollision = fat(thin(0x01000007, '000011011'), thin(0x0100000c, '000011011'));
  sentinel.copy(gapCollision, 100);
  assert.throws(() => verifyMacFuseBytes(gapCollision), /extra fuse sentinel/);
});

test('ASAR integrity, sealed-policy presence and canonical framework/ASAR tree are mandatory', async t => {
  const b = await bundle(t);
  await hardenMacBootstrap(b.context);
    await syntheticFinalSign(b);
  await writeFile(b.infoPath, plist.build(b.info));
  await assert.rejects(verifyMacBootstrap(b.app), /missing signed bootstrap policy/);
  b.info.BrianElectronFusePolicy = bootstrapPolicy;
  b.info.ElectronAsarIntegrity['Resources/app.asar'].hash = '0'.repeat(64);
  await writeFile(b.infoPath, plist.build(b.info));
  await assert.rejects(verifyMacBootstrap(b.app), /ASAR header hash mismatch/);
  delete b.info.ElectronAsarIntegrity;
  await writeFile(b.infoPath, plist.build(b.info));
  await assert.rejects(verifyMacBootstrap(b.app), /missing ASAR integrity/);
  await rm(b.framework);
  const outside = join(b.source, 'outside'); await writeFile(outside, thin(0x0100000c, '000011011'));
  await symlink(outside, b.framework);
  await assert.rejects(verifyMacBootstrap(b.app), /framework escaped/);
});

test('macOS flags do not run for Linux/Windows; Firefox bootstrap remains ordinary packaged Electron', async () => {
  await hardenMacBootstrap({ electronPlatformName: 'linux' });
  await hardenMacBootstrap({ electronPlatformName: 'win32' });
  const source = await readFile(new URL('../src/bootstrap.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('isFirefoxNativeHostArgv(process.argv)'));
  assert.ok(source.includes('runFirefoxNativeHost'));
  assert.ok(source.includes('spawn(process.execPath, ["usebrian://firefox-control"]'));
  assert.ok(!source.includes('ELECTRON_RUN_AS_NODE') && !source.includes('fork('));
});

test('helper requires runtime bytes plus signed policy, nested seals and fresh dynamic identity', async () => {
  const helper = await readFile(new URL('../native/computer-control/Helper.swift', import.meta.url), 'utf8');
  for (const marker of [bootstrapPolicy, sentinel.toString(), 'wire[0] == 0x30, wire[2] == 0x30, wire[3] == 0x30',
    'wire[4] == 0x31, wire[5] == 0x31', 'cpus.insert(cpu).inserted', '[8, 9].contains', 'kSecCSCheckNestedCode',
    'kSecCodeInfoPList', 'hardenedParentBootstrap(identity, info)', 'hardenedElectronWire(bytes), frameworkValid()',
    'signedProcess(parent, teamRequirement("ai.usebrian.desktop"), bootstrap: true)',
    'canonicalPath(framework) == framework', 'ProcessIdentity.read(identity.pid) == identity',
    'URL(fileURLWithPath: frameworkBundle) as CFURL', 'kSecCSCheckAllArchitectures | kSecCSCheckNestedCode',
    'canonicalPath(executable.path) == framework', 'let bytes = boundedFrameworkBytes(framework)',
    'before.st_size <= 1024 * 1024 * 1024', 'previous != wire', 'totalWires == slices.count']) assert.ok(helper.includes(marker), marker);
  assert.ok(!helper.includes('ProcessInfo.processInfo.environment'));
});

test('digest preflight rejects unknown layouts/versions before any fuse or policy writes', async t => {
  for (const mutate of [
    bytes => { bytes[4352 + 33] = 2; },
    bytes => bytes.fill(0, 4352, 4352 + 32),
    bytes => bytes.writeUInt32LE(0xffffffff, 224),
  ]) {
    const bytes = thin(); mutate(bytes);
    const b = await bundle(t, bytes), beforeInfo = await readFile(b.infoPath);
    await assert.rejects(hardenMacBootstrap(b.context));
    assert.deepEqual(await readFile(b.framework), bytes);
    assert.deepEqual(await readFile(b.infoPath), beforeInfo);
  }
  const b = await bundle(t), before = await readFile(b.framework);
  b.context.packager.config.electronVersion = '43.2.1';
  await assert.rejects(hardenMacBootstrap(b.context), /unsupported Electron version/);
  assert.deepEqual(await readFile(b.framework), before);
  b.context.packager.config.electronVersion = '43.2.0';
  await writeFile(join(b.app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist'), plist.build({ CFBundleVersion: '42.0.0' }));
  await assert.rejects(hardenMacBootstrap(b.context), /unsupported Electron version/);
  await assert.rejects(verifyMacBootstrap(b.app), /unsupported Electron version/);
  assert.deepEqual(await readFile(b.framework), before);
});

test('post-sign verification never repairs missing/stale coverage or changed digest on either slice', async t => {
  const b = await bundle(t, fat());
  await hardenMacBootstrap(b.context);
  let before = await readFile(b.framework);
  await assert.rejects(verifyMacBootstrap(b.app), /page hash mismatch/);
  assert.deepEqual(await readFile(b.framework), before);
  await syntheticFinalSign(b);
  await verifyMacBootstrap(b.app);
  const signed = await readFile(b.framework);
  for (const mutate of [
    bytes => { bytes[4096 + 4352 + 32] = 0; },
    bytes => { bytes[16384 + 4352 + 33] = 2; },
    bytes => { bytes[16384 + 4352 + 34] ^= 1; },
    bytes => { bytes[16384 + 4352 - 1] ^= 1; },
    bytes => bytes.writeUInt32LE(0x1b, 4096 + 328),
  ]) {
    before = Buffer.from(signed); mutate(before); await writeFile(b.framework, before);
    await assert.rejects(verifyMacBootstrap(b.app));
    assert.deepEqual(await readFile(b.framework), before);
  }
  const afterPack = await readFile(new URL('./sign-siri-extension.mjs', import.meta.url), 'utf8');
  const afterSign = await readFile(new URL('./verify-siri-extension.mjs', import.meta.url), 'utf8');
  assert(afterPack.indexOf('await hardenMacBootstrap(context)') < afterPack.indexOf('await availableSigningIdentity(context)'));
  assert(afterSign.includes('await verifyMacBootstrap(appPath)'));
  assert(!afterSign.includes('hardenMacBootstrap'));
  const helper = await readFile(new URL('../native/computer-control/Helper.swift', import.meta.url), 'utf8');
  assert(!/Broker\s*\(/.test(helper), 'Unconditional helper probe-only barrier remains');
  assert(helper.includes('probeOnlyResponse(request, clock: sourceClock)'));
});
