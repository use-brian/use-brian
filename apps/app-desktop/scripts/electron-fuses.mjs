// macOS only. Official API: https://www.electronjs.org/docs/latest/tutorial/fuses
import { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options, FuseState } from '@electron/fuses';
import { getRawHeader, extractFile, uncache } from '@electron/asar';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath, open } from 'node:fs/promises';
import { join } from 'node:path';
import plist from 'plist';
import { constants } from 'node:fs';
import { requireElectronVersion, integritySlots, populateIntegrityDigest, verifyIntegrityDigest } from './mac-asar-integrity.mjs';

export const bootstrapPolicy = 'electron-fuses-v1:0,2,3=0;4,5=1';
export const requiredFuses = Object.freeze({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
});
const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
export const packagedApp = context => join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
const fail = message => { throw new Error(`macOS bootstrap: ${message}`); };

export function verifyFuseWire(wire) {
  if (wire.version !== FuseVersion.V1) fail('unknown fuse version');
  for (const [key, enabled] of Object.entries(requiredFuses)) {
    if (wire[key] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE)) fail(`unsafe or unknown fuse ${key}`);
  }
}

// getCurrentFuseWire reads only the first wire. Also inspect EVERY Mach-O slice,
// so a universal binary with a missing/unsafe second wire cannot pass acceptance.
export function verifyMacFuseBytes(bytes, enforce = true) {
  if (bytes.length < 32 || bytes.length > 1024 ** 3) fail('invalid framework size');
  const slices = [];
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = bytes.readUInt32BE(4), stride = magic === 0xcafebabe ? 20 : 32;
    if (count < 1 || count > 2 || 8 + count * stride > bytes.length) fail('unknown fat header');
    let end = 8 + count * stride;
    for (let i = 0; i < count; i++) {
      const base = 8 + i * stride;
      const offset = stride === 20 ? bytes.readUInt32BE(base + 8) : Number(bytes.readBigUInt64BE(base + 8));
      const size = stride === 20 ? bytes.readUInt32BE(base + 12) : Number(bytes.readBigUInt64BE(base + 16));
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < end || size < 32 || offset + size > bytes.length) fail('invalid/overlapping slice');
      slices.push({ offset, size, cpu: bytes.readUInt32BE(base) });
      end = offset + size;
    }
  } else {
    slices.push({ offset: 0, size: bytes.length, cpu: bytes.readUInt32LE(4) });
  }
  let cursor = 0, totalWires = 0;
  while ((cursor = bytes.indexOf(sentinel, cursor)) !== -1) { totalWires++; cursor++; if (totalWires > slices.length) fail('extra fuse sentinel outside slices'); }
  if (totalWires !== slices.length) fail('missing fuse sentinel');
  const cpus = new Set();
  let firstWire;
  for (const { offset, size, cpu } of slices) {
    if (![0x01000007, 0x0100000c].includes(cpu) || cpus.has(cpu)) fail('unknown/duplicate architecture');
    cpus.add(cpu);
    const slice = bytes.subarray(offset, offset + size);
    if (slice.readUInt32LE(0) !== 0xfeedfacf || slice.readUInt32LE(4) !== cpu || slice.readUInt32LE(12) !== 6) fail('not a 64-bit framework');
    const at = slice.indexOf(sentinel);
    if (at < 32 || slice.indexOf(sentinel, at + 1) !== -1) fail('missing/ambiguous fuse wire');
    const start = at + sentinel.length;
    if (start + 2 > size || slice[start] !== 1 || ![8, 9].includes(slice[start + 1]) || start + 2 + slice[start + 1] > size) fail('unknown/truncated fuse schema');
    const wire = { version: FuseVersion.V1 };
    for (let i = 0; i < slice[start + 1]; i++) {
      const value = slice[start + 2 + i];
      if (![FuseState.DISABLE, FuseState.ENABLE].includes(value)) fail('removed/unknown fuse state');
      wire[i] = value;
    }
    const rawWire = slice.subarray(start, start + 2 + slice[start + 1]);
    if (firstWire && !firstWire.equals(rawWire)) fail('inconsistent architecture fuse wires');
    firstWire = rawWire;
    if (enforce) verifyFuseWire(wire);
  }
  return slices.length;
}

async function frameworkBytes(app) {
  const contents = await realpath(join(app, 'Contents'));
  const path = join(contents, 'Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
  if (await realpath(join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')) !== path || await realpath(path) !== path) fail('framework escaped canonical tree');
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 32 || before.size > 1024 ** 3) fail('invalid framework size');
    const bytes = Buffer.alloc(before.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('framework changed during read');
    return bytes;
  } finally { await file.close(); }
}

async function verifyAsar(app, info) {
  const asar = join(await realpath(join(app, 'Contents')), 'Resources/app.asar');
  if (await realpath(asar) !== asar) fail('ASAR escaped canonical tree');
  const expected = info.ElectronAsarIntegrity?.['Resources/app.asar'];
  if (expected?.algorithm !== 'SHA256' || !/^[a-f0-9]{64}$/.test(expected?.hash ?? '')) fail('missing ASAR integrity');
  const { headerString, header } = getRawHeader(asar);
  if (createHash('sha256').update(headerString).digest('hex') !== expected.hash) fail('ASAR header hash mismatch');
  if (info.CFBundleIdentifier !== 'ai.usebrian.desktop' || info.CFBundleExecutable !== 'Use Brian') fail('wrong desktop identity');
  for (const file of [header.files?.['package.json'], header.files?.dist?.files?.['bootstrap.js']]) {
    if (!file || file.unpacked || file.link || file.integrity?.algorithm !== 'SHA256') fail('bootstrap must be integrity-protected inside app.asar');
  }
  uncache(asar); // afterSign cannot reuse afterPack's ASAR offset/header cache.
  if (JSON.parse(extractFile(asar, 'package.json').toString('utf8')).main !== 'dist/bootstrap.js') fail('Firefox/desktop bootstrap entry changed');
}

async function frameworkVersion(app) {
  const path = join(await realpath(join(app, 'Contents')), 'Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist');
  if (await realpath(path) !== path) fail('framework version plist escaped canonical tree');
  const info = plist.parse(await readFile(path, 'utf8'));
  requireElectronVersion(info.CFBundleVersion);
}

async function verifyBootstrapContent(app, requireMarker) {
  await frameworkVersion(app);
  const bytes = await frameworkBytes(app);
  verifyMacFuseBytes(bytes);
  verifyFuseWire(await getCurrentFuseWire(app));
  const info = plist.parse(await readFile(join(app, 'Contents/Info.plist'), 'utf8'));
  await verifyAsar(app, info);
  verifyIntegrityDigest(bytes, info.ElectronAsarIntegrity, { requireSignatureCoverage: false });
  if (requireMarker && info.BrianElectronFusePolicy !== bootstrapPolicy) fail('missing signed bootstrap policy');
  return { info, bytes };
}

// Post-sign verification is read-only and always requires final page-hash
// coverage. CMS/team/resource authentication remains the signing hook's job;
// neither this check nor a successful codesign proves a loaded dyld image.
export async function verifyMacBootstrap(app, requireMarker = true) {
  const { info, bytes } = await verifyBootstrapContent(app, requireMarker);
  verifyIntegrityDigest(bytes, info.ElectronAsarIntegrity);
  return info;
}

async function writeFrameworkDigest(app, beforeBytes, afterBytes) {
  const path = join(await realpath(join(app, 'Contents')), 'Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
  if (await realpath(path) !== path) fail('framework escaped canonical tree');
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== beforeBytes.length) fail('framework changed before digest write');
    const current = Buffer.alloc(beforeBytes.length);
    const { bytesRead } = await file.read(current, 0, current.length, 0);
    if (bytesRead !== current.length || !current.equals(beforeBytes)) fail('framework changed before digest write');
    for (const { slot } of integritySlots(afterBytes)) {
      const { bytesWritten } = await file.write(afterBytes, slot + 32, 34, slot + 32);
      if (bytesWritten !== 34) fail('short integrity digest write');
    }
    await file.sync();
    if ((await file.stat()).size !== before.size) fail('framework changed during digest write');
  } finally { await file.close(); }
  if (!(await frameworkBytes(app)).equals(afterBytes)) fail('integrity digest readback mismatch');
}

export async function hardenMacBootstrap(context) {
  // Never apply macOS-only ASAR flags to Linux/Windows packages.
  if (context.electronPlatformName !== 'darwin') return;
  requireElectronVersion(context.packager.config?.electronVersion);
  const app = packagedApp(context);
  await frameworkVersion(app);
  const initial = await frameworkBytes(app);
  const info = plist.parse(await readFile(join(app, 'Contents/Info.plist'), 'utf8'));
  await verifyAsar(app, info);
  // Validate every digest slot before the fuse API writes anything. Unknown
  // schemas are not repaired. This is the sole pre-sign mutation phase.
  populateIntegrityDigest(initial, info.ElectronAsarIntegrity);
  const slices = verifyMacFuseBytes(initial, false);
  if (await flipFuses(app, { version: FuseVersion.V1, ...requiredFuses }) !== slices) fail('fuse write count mismatch');
  const fused = await frameworkBytes(app);
  await writeFrameworkDigest(app, fused, populateIntegrityDigest(fused, info.ElectronAsarIntegrity));
  // No resetAdHocDarwinSignature: electron-builder signs after this hook.
  await verifyBootstrapContent(app, false);
  info.BrianElectronFusePolicy = bootstrapPolicy;
  await writeFile(join(app, 'Contents/Info.plist'), plist.build(info));
  await verifyBootstrapContent(app, true);
}
