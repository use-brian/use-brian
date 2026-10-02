// TEST ONLY: independent Node SHA256 + existing SYNTHETIC fixtures, never kernel/signing evidence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, fatFixture, rebind, digest } from '../../scripts/mac-library-constraints.test-fixtures.mjs';
import { extractAuthenticatedLibraryConstraint as jsExtract } from '../../scripts/mac-library-constraints.mjs';

const mutations = {
  'wrong Mach-O magic': f => f.bytes.writeUInt32LE(0xfeedface, 0),
  'unsupported cpu': f => f.bytes.writeUInt32LE(7, 4),
  'unsupported subtype': f => f.bytes.writeUInt32LE(2, 8),
  'unsupported filetype': f => f.bytes.writeUInt32LE(1, 12),
  'reserved header': f => f.bytes[28] = 1,
  'too many commands': f => f.bytes.writeUInt32LE(4097, 16),
  'wrong command count': f => f.bytes.writeUInt32LE(2, 16),
  'command bytes overflow': f => f.bytes.writeUInt32LE(0xffffffff, 20),
  'unknown command': f => f.bytes.writeUInt32LE(0x12345678, 32),
  'zero command size': f => f.bytes.writeUInt32LE(0, 36),
  'unaligned command size': f => f.bytes.writeUInt32LE(71, 36),
  'segment sections mismatch': f => f.bytes.writeUInt32LE(1, 96),
  'segment overflow': f => f.bytes.writeBigUInt64LE(2n ** 63n, 72),
  'segment overlap': f => f.bytes.writeBigUInt64LE(0n, 144),
  'missing LINKEDIT': f => f.bytes[112] = 65,
  'duplicate signature command': f => { f.bytes.writeUInt32LE(0x1d, 32); f.bytes.writeUInt32LE(16, 36); },
  'signature before commands': f => f.bytes.writeUInt32LE(16, 184),
  'signature past EOF': f => f.bytes.writeUInt32LE(0xffffffff, 188),
  'wrong SuperBlob magic': f => f.bytes.writeUInt32BE(0xfade0cc1, f.signature),
  'short SuperBlob': f => f.bytes.writeUInt32BE(12, f.signature + 4),
  'long SuperBlob': f => f.bytes.writeUInt32BE(0xffffffff, f.signature + 4),
  'too many components': f => f.bytes.writeUInt32BE(65, f.signature + 8),
  'missing constraint': f => f.bytes.writeUInt32BE(1, f.signature + 8),
  'duplicate slot': f => f.bytes.writeUInt32BE(0, f.signature + 20),
  'alternate CodeDirectory': f => f.bytes.writeUInt32BE(0x1000, f.signature + 20),
  'unknown slot': f => f.bytes.writeUInt32BE(12, f.signature + 20),
  'blob overlaps index': f => f.bytes.writeUInt32BE(20, f.signature + 16),
  'blob offset overflow': f => f.bytes.writeUInt32BE(0xffffffff, f.signature + 24),
  'blob length overflow': f => f.bytes.writeUInt32BE(0xffffffff, f.rawOffset + 4),
  'empty payload': f => f.bytes.writeUInt32BE(8, f.rawOffset + 4),
  'wrong constraint magic': f => f.bytes.writeUInt32BE(0xfade7172, f.rawOffset),
  'wrong CD magic': f => f.bytes.writeUInt32BE(0xfade0c01, f.cdOffset),
  'old CD version': f => f.bytes.writeUInt32BE(0x20300, f.cdOffset + 8),
  'future CD version': f => f.bytes.writeUInt32BE(0x20700, f.cdOffset + 8),
  'SHA1': f => f.bytes[f.cdOffset + 37] = 1,
  'truncated SHA256': f => { f.bytes[f.cdOffset + 37] = 3; f.bytes[f.cdOffset + 36] = 20; },
  'SHA384': f => f.bytes[f.cdOffset + 37] = 4,
  'wrong hash width': f => f.bytes[f.cdOffset + 36] = 20,
  'platform CD': f => f.bytes[f.cdOffset + 38] = 1,
  'infinite page': f => f.bytes[f.cdOffset + 39] = 0,
  'scatter': f => f.bytes.writeUInt32BE(88, f.cdOffset + 44),
  'spare2': f => f.bytes.writeUInt32BE(1, f.cdOffset + 40),
  'spare3': f => f.bytes.writeUInt32BE(1, f.cdOffset + 52),
  '64bit code limit': f => f.bytes.writeBigUInt64BE(4096n, f.cdOffset + 56),
  'special slot absent': f => f.bytes.writeUInt32BE(10, f.cdOffset + 24),
  'unknown special slot': f => f.bytes.writeUInt32BE(12, f.cdOffset + 24),
  'hash table underflow': f => f.bytes.writeUInt32BE(2, f.cdOffset + 16),
  'hash table overflow': f => f.bytes.writeUInt32BE(0xffffffff, f.cdOffset + 16),
  'pages overflow': f => f.bytes.writeUInt32BE(0xffffffff, f.cdOffset + 28),
  'coverage mismatch': f => f.bytes.writeUInt32BE(32, f.cdOffset + 32),
  'identifier overlaps header': f => f.bytes.writeUInt32BE(4, f.cdOffset + 20),
  'identifier overlaps hashes': f => f.bytes.writeUInt32BE(f.hashStart, f.cdOffset + 20),
  'identifier unterminated': f => f.bytes[f.cdOffset + f.hashStart - 1] = 65,
  'team overlaps identifier': f => f.bytes.writeUInt32BE(88, f.cdOffset + 48),
  'unknown slot 6 hash': f => f.bytes[f.cdOffset + f.hashes - 6 * 32] = 1,
  'unsupported application hash': f => f.bytes[f.cdOffset + f.hashes - 4 * 32] = 1,
  'missing entitlements but nonzero hash': f => f.bytes[f.cdOffset + f.hashes - 5 * 32] = 1,
  'zero library hash': f => f.bytes.fill(0, f.cdOffset + f.hashStart, f.cdOffset + f.hashStart + 32),
};

// Rebuild a synthetic signature using independent Node SHA256. The payload may
// be real user-supplied DER; the enclosing Mach-O and expected kernel hash NEVER are.
function rebuilt(raw, { signature = 4096, page = 12, version = 0x20400 } = {}) {
  const base = fixture({ version, page }), pages = Math.ceil(signature / (2 ** page));
  const cd = Buffer.concat([base.bytes.subarray(base.cdOffset, base.cdOffset + base.hashes), Buffer.alloc(pages * 32)]);
  cd.writeUInt32BE(cd.length, 4); cd.writeUInt32BE(pages, 28); cd.writeUInt32BE(signature, 32);
  digest(raw).copy(cd, base.hashStart);
  const sb = Buffer.alloc(28 + cd.length + raw.length);
  sb.writeUInt32BE(0xfade0cc0); sb.writeUInt32BE(sb.length, 4); sb.writeUInt32BE(2, 8);
  sb.writeUInt32BE(28, 16); sb.writeUInt32BE(11, 20); sb.writeUInt32BE(28 + cd.length, 24);
  const bytes = Buffer.alloc(signature + sb.length); base.bytes.copy(bytes, 0, 0, Math.min(signature, base.signature));
  bytes.writeBigUInt64LE(BigInt(signature), 64); bytes.writeBigUInt64LE(BigInt(signature), 80);
  bytes.writeBigUInt64LE(BigInt(sb.length), 136); bytes.writeBigUInt64LE(BigInt(signature), 144); bytes.writeBigUInt64LE(BigInt(sb.length), 152);
  bytes.writeUInt32LE(signature, 184); bytes.writeUInt32LE(sb.length, 188);
  for (let p = 0; p < pages; ++p) digest(bytes.subarray(p * 2 ** page, Math.min((p + 1) * 2 ** page, signature))).copy(cd, base.hashes + p * 32);
  cd.copy(sb, 28); raw.copy(sb, 28 + cd.length); sb.copy(bytes, signature);
  return { ...base, bytes, signature, raw, cdOffset: signature + 28, rawOffset: signature + 28 + cd.length,
    expected: { cdHash: digest(cd).subarray(0, 20), slice: { ...base.expected.slice, size: bytes.length } } };
}

// Additional opaque embedded components. These are structurally/hash-consistent
// synthetic blobs, NOT valid requirements/entitlements/CMS or native evidence.
function extraComponent(type, magic) {
  const f = fixture(), cd = Buffer.from(f.bytes.subarray(f.cdOffset, f.rawOffset));
  const extra = Buffer.alloc(11); extra.writeUInt32BE(magic); extra.writeUInt32BE(extra.length, 4); extra.fill(0x41, 8);
  if (type < 12) digest(extra).copy(cd, f.hashes - type * 32);
  const headerSize = 36, rawAt = headerSize + cd.length, extraAt = rawAt + f.raw.length;
  const sb = Buffer.alloc(extraAt + extra.length);
  sb.writeUInt32BE(0xfade0cc0); sb.writeUInt32BE(sb.length, 4); sb.writeUInt32BE(3, 8);
  for (const [i, slot, offset] of [[0, 0, headerSize], [1, 11, rawAt], [2, type, extraAt]]) {
    sb.writeUInt32BE(slot, 12 + i * 8); sb.writeUInt32BE(offset, 16 + i * 8);
  }
  f.bytes = Buffer.concat([f.bytes.subarray(0, f.signature), sb]);
  f.bytes.writeUInt32LE(sb.length, 188); f.bytes.writeBigUInt64LE(BigInt(sb.length), 152);
  digest(f.bytes.subarray(0, f.signature)).copy(cd, f.hashes);
  cd.copy(f.bytes, f.signature + headerSize); f.raw.copy(f.bytes, f.signature + rawAt); extra.copy(f.bytes, f.signature + extraAt);
  f.cdOffset = f.signature + headerSize; f.rawOffset = f.signature + rawAt; f.extraOffset = f.signature + extraAt;
  f.expected.slice.size = f.bytes.length; f.expected.cdHash = digest(cd).subarray(0, 20);
  return f;
}
function extraCommand(command, size, populate = () => {}) {
  const f = fixture();
  f.bytes.writeUInt32LE(4, 16); f.bytes.writeUInt32LE(160 + size, 20);
  f.bytes.writeUInt32LE(command, 192); f.bytes.writeUInt32LE(size, 196);
  populate(f.bytes); rebind(f); return f;
}

export function machoVectors() {
  const vectors = [];
  const add = (name, f, want = false, { jsWant = want, policy = false } = {}) => {
    const e = f.expected;
    vectors.push({ name, bytes: f.bytes.toString('base64'), cdHash: e.cdHash.toString('base64'),
      offset: String(e.slice.offset), architecture: e.slice.cpuType === 0x0100000c ? 'arm64' : 'x86_64',
      compareObservedPolicy: policy, want, jsWant, jsSize: e.slice.size, jsSubtype: e.slice.cpuSubtype });
  };
  add('synthetic-thin-arm64', fixture(), true);
  for (const version of [0x20400, 0x20500, 0x20600]) for (const page of [12, 14])
    add(`synthetic-version-${version}-page-${page}`, fixture({ version, page }), true);
  add('synthetic-thin-x86_64', fixture({ cpuType: 0x01000007, cpuSubtype: 3 }), true);
  for (const wide of [false, true]) {
    const f = fatFixture(wide);
    add(`synthetic-fat-${wide}-first`, f, true);
    add(`synthetic-fat-${wide}-second`, { ...f, expected: { ...f.b.expected, slice: { ...f.b.expected.slice, offset: f.offsetB } } }, true);
    add(`fat-${wide}-other-slice-hash`, { ...f, expected: { ...f.expected, cdHash: f.b.expected.cdHash } });
    f.bytes[f.offsetB + 400] ^= 1; add(`fat-${wide}-unselected-page-corruption`, f);
  }
  const fixtureURL = new URL('../../scripts/fixtures/mac-library-constraint.arm64-macos26.v1.json', import.meta.url);
  const fixtureText = readFileSync(fixtureURL, 'utf8');
  const nativeDER = Buffer.from(JSON.parse(fixtureText).rawLibraryConstraintBase64, 'base64');
  assert.equal(nativeDER.length, 183);
  add('native-DER-in-SYNTHETIC-MachO-not-native-signing-evidence', rebuilt(nativeDER), true, { policy: true });
  for (const [name, mutate] of Object.entries(mutations)) { const f = fixture(); mutate(f); rebind(f); add(name, f); }
  for (const [version, field] of [[0x20500, 92], [0x20600, 96], [0x20600, 100], [0x20600, 104]]) {
    const f = fixture({ version }); f.bytes[f.cdOffset + field] = 1; rebind(f); add(`optional-${version}-${field}`, f);
  }
  for (const [name, mutate] of [
    ['unknown-CD-flags', f => f.bytes.writeUInt32BE(0x80000000, f.cdOffset + 12)],
    ['unknown-exec-flags', f => f.bytes.writeBigUInt64BE(0x400n, f.cdOffset + 80)],
    ['bad-exec-size', f => f.bytes.writeBigUInt64BE(4097n, f.cdOffset + 72)],
    ['huge-exec-base', f => f.bytes.writeBigUInt64BE(2n ** 63n, f.cdOffset + 64)],
    ['duplicate-signature-command', f => { f.bytes.copy(f.bytes, 192, 176, 192); f.bytes.writeUInt32LE(4, 16); f.bytes.writeUInt32LE(176, 20); }],
    ['whole-blob-not-payload-hash', f => digest(f.raw.subarray(8)).copy(f.bytes, f.cdOffset + f.hashStart)],
  ]) { const f = fixture(); mutate(f); rebind(f); add(name, f); }
  for (const where of ['cd', 'raw', 'page', 'header']) {
    const f = fixture(); f.bytes[{ cd: f.cdOffset + 12, raw: f.rawOffset + 8, page: 400, header: 24 }[where]] ^= 1;
    add(`unrebound-${where}-substitution`, f);
  }
  const repairedSlot = fixture(); repairedSlot.bytes[repairedSlot.rawOffset + 8] ^= 1;
  digest(repairedSlot.bytes.subarray(repairedSlot.rawOffset)).copy(repairedSlot.bytes, repairedSlot.cdOffset + repairedSlot.hashStart);
  add('repaired-slot-but-OLD-kernel-hash', repairedSlot);
  const repairedPage = fixture(); repairedPage.bytes[24] ^= 1;
  digest(repairedPage.bytes.subarray(0, repairedPage.signature)).copy(repairedPage.bytes, repairedPage.cdOffset + repairedPage.hashes);
  add('repaired-page-table-but-OLD-kernel-hash', repairedPage);
  const overlap = fixture(), at = overlap.cdOffset + 64;
  overlap.bytes.writeUInt32BE(at - overlap.signature, overlap.signature + 24);
  overlap.bytes.writeUInt32BE(0xfade8181, at); overlap.bytes.writeUInt32BE(9, at + 4);
  rebind(overlap); add('component-overlap-inside-CD', overlap);
  const padding = fixture(), oldSize = padding.bytes.length;
  padding.bytes = Buffer.concat([padding.bytes, Buffer.alloc(32)]);
  padding.bytes.writeUInt32LE(padding.bytes.length - padding.signature, 188);
  padding.bytes.writeBigUInt64LE(BigInt(padding.bytes.length - padding.signature), 152);
  padding.expected.slice.size = padding.bytes.length; rebind(padding); add('zero-signature-padding', padding, true);
  padding.bytes[oldSize] = 1; add('nonzero-unused-signature-allocation', padding, true);
  const declared = oldSize - padding.signature;
  padding.bytes.writeUInt32BE(declared + 1, padding.signature + 4);
  add('hidden-signature-padding', padding); // Nonzero tail INSIDE declared SuperBlob.
  padding.bytes.writeUInt32BE(declared - 1, padding.signature + 4);
  add('component-crosses-declared-end', padding);
  padding.bytes.writeUInt32BE(declared, padding.signature + 4);
  padding.raw.copy(padding.bytes, oldSize);
  padding.bytes.writeUInt32BE(declared, padding.signature + 24);
  add('component-header-outside-declared-end', padding);
  for (const page of [12, 14]) {
    const signature = page === 12 ? 9000 : 34000;
    const f = rebuilt(nativeDER, { signature, page }); add(`multi-page-${page}`, f, true, { policy: true });
    for (const index of [0, 500, 2 ** page + 100, signature - 1]) {
      f.bytes[index] ^= 1; add(`multi-page-${page}-corrupt-${index}`, f); f.bytes[index] ^= 1;
    }
  }
  for (const length of [0, 19, 21, 32]) { const f = fixture(); f.expected.cdHash = Buffer.alloc(length); add(`wrong-kernel-hash-width-${length}`, f); }
  const zero = fixture(); zero.expected.cdHash = Buffer.alloc(20); add('zero-kernel-hash', zero);
  for (const offset of [1, 4096, 999999999, '18446744073709551615']) {
    const f = fixture(); f.expected.slice.offset = offset; add(`wrong-kernel-offset-${offset}`, f);
  }
  const wrongArch = fixture(); wrongArch.expected.slice.cpuType = 0x01000007; wrongArch.expected.slice.cpuSubtype = 3;
  add('independent-architecture-context-mismatch', wrongArch);
  for (const wide of [false, true]) {
    const edits = [
      f => f.bytes.writeUInt32BE(3, 4), f => f.bytes.writeUInt32BE(0, 4),
      f => f.bytes.writeUInt32BE(31, 8 + (wide ? 24 : 16)), f => f.bytes.writeUInt32BE(7, 8),
      f => f.bytes.writeUInt32BE(0x0100000c, 8 + (wide ? 32 : 20)),
      f => wide ? f.bytes.writeBigUInt64BE(8n, 16) : f.bytes.writeUInt32BE(8, 16),
      f => wide ? f.bytes.writeBigUInt64BE(2n ** 63n, 16) : f.bytes.writeUInt32BE(0xffffffff, 16),
      f => wide ? f.bytes.writeBigUInt64BE(4096n, 48) : f.bytes.writeUInt32BE(4096, 36),
    ];
    if (wide) edits.push(f => f.bytes.writeUInt32BE(1, 36));
    for (const [i, edit] of edits.entries()) { const f = fatFixture(wide); edit(f); add(`fat-${wide}-malformed-${i}`, f); }
  }
  // Intentionally narrower native MAIN-image profile; these are explicit
  // divergences, never represented as cross-language parity successes.
  for (const filetype of [6, 8]) {
    const f = fixture(); f.bytes.writeUInt32LE(filetype, 12); rebind(f);
    add(`native-main-only-rejects-filetype-${filetype}`, f, false, { jsWant: true });
  }
  const largeRaw = Buffer.alloc(4097); largeRaw.writeUInt32BE(0xfade8181); largeRaw.writeUInt32BE(largeRaw.length, 4);
  add('native-policy-size-cap', rebuilt(largeRaw), false, { jsWant: true });
  // Framing coverage for every supported fixed/string/build command family.
  // No claims that these synthetic zero-filled command bodies are executable.
  for (const [cmd, size] of [[2,24],[0xb,80],[0x1b,24],[0x24,16],[0x26,16],[0x29,16],[0x2a,16],
    [0x80000028,24],[0x22,48],[0x80000022,48],[0x80000033,16],[0x80000034,16]]) {
    add(`synthetic-framed-command-${cmd}`, extraCommand(cmd, size), true);
    add(`wrong-fixed-command-size-${cmd}`, extraCommand(cmd, size + 8));
  }
  for (const [cmd, minimum] of [[0xc,24],[0xd,24],[0x80000018,24],[0x8000001f,24],[0x80000023,24],[0xe,12],[0x8000001c,12]]) {
    const size = Math.ceil((minimum + 5) / 8) * 8;
    const populate = b => { b.writeUInt32LE(minimum, 200); b.write('fake', 192 + minimum); };
    add(`synthetic-framed-string-${cmd}`, extraCommand(cmd, size, populate), true);
    add(`bad-string-offset-${cmd}`, extraCommand(cmd, size, b => { populate(b); b.writeUInt32LE(size, 200); }));
    add(`unterminated-string-${cmd}`, extraCommand(cmd, size, b => { populate(b); b.fill(0x41, 192 + minimum, 192 + size); }));
  }
  add('synthetic-build-version', extraCommand(0x32, 32, b => b.writeUInt32LE(1, 212)), true);
  add('bad-build-version', extraCommand(0x32, 32, b => b.writeUInt32LE(2, 212)));
  for (const [type, magic] of [[2,0xfade0c01],[5,0xfade7171],[7,0xfade7172],[8,0xfade8181],[9,0xfade8181],[10,0xfade8181]]) {
    const f = extraComponent(type, magic);
    add(`synthetic-opaque-special-${type}`, f, true);
    f.bytes[f.extraOffset + 8] ^= 1; add(`tampered-special-${type}`, f);
  }
  const cms = extraComponent(0x10000, 0xfade0b01);
  add('opaque-CMS-is-NOT-authenticated', cms, true);
  cms.bytes[cms.extraOffset + 8] ^= 1;
  add('changed-CMS-still-NOT-authenticated', cms, true);
  const external = fixture();
  external.bytes.fill(0x77, external.cdOffset + external.hashes - 3 * 32, external.cdOffset + external.hashes - 2 * 32);
  external.bytes.fill(0x55, external.cdOffset + external.hashes - 32, external.cdOffset + external.hashes);
  rebind(external); add('external-resource-and-plist-slots-NOT-verified', external, true);
  const duplicateName = fixture(); duplicateName.bytes.copy(duplicateName.bytes, 112, 40, 56); rebind(duplicateName); add('duplicate-segment-name', duplicateName);
  const namePadding = fixture(); namePadding.bytes[55] = 1; rebind(namePadding); add('noncanonical-segment-padding', namePadding);
  const twoCDs = extraComponent(0x10000, 0xfade0b01); twoCDs.bytes.writeUInt32BE(0, twoCDs.signature + 28); add('duplicate-CodeDirectory-index', twoCDs);
  const atBound = Buffer.alloc(4096); atBound.writeUInt32BE(0xfade8181); atBound.writeUInt32BE(atBound.length, 4);
  add('exact-native-policy-size-bound-opaque-only', rebuilt(atBound), true);
  const base = fixture();
  for (let n = 0; n < base.bytes.length; ++n)
    add(`every-truncated-prefix-${n}`, { ...base, bytes: base.bytes.subarray(0, n), expected: { ...base.expected, slice: { ...base.expected.slice, size: n } } });
  // Independently labeled tampering in covered pages, selected CD and whole slot
  // blob. No re-sign/rebind, parser-driven mutation or production kernel spoof.
  let seed = 0x12345678;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 500; ++i) {
    const f = fixture(), regions = [[0, f.signature], [f.cdOffset, f.rawOffset], [f.rawOffset, f.bytes.length]];
    const [low, high] = regions[i % 3], at = low + next() % (high - low);
    f.bytes[at] ^= 1 << (next() % 8); add(`deterministic-signed-byte-tamper-${i}`, f);
  }
  assert.equal(readFileSync(fixtureURL, 'utf8'), fixtureText);
  return vectors;
}

export function oracle(vector) {
  let result;
  try {
    result = jsExtract(Buffer.from(vector.bytes, 'base64'), { cdHash: Buffer.from(vector.cdHash, 'base64'), slice: {
      offset: Number(vector.offset), size: vector.jsSize, cpuType: vector.architecture === 'arm64' ? 0x0100000c : 0x01000007, cpuSubtype: vector.jsSubtype } });
  } catch (error) {
    assert.match(error.message, /^macOS library constraint:/, vector.name);
    assert.equal(vector.jsWant, false, vector.name);
    return { error: 'ERR_MACHO_LIBRARY_CONSTRAINT_EXTRACTION' };
  }
  assert.equal(vector.jsWant, true, vector.name);
  if (!vector.want) return { error: 'ERR_MACHO_LIBRARY_CONSTRAINT_EXTRACTION' };
  return { match: { rawBlob: result.rawBlob.toString('base64'), slice: { offset: result.slice.offset, size: result.slice.size, architecture: vector.architecture },
    version: result.codeDirectoryVersion, policyStatus: 'unsupported', productionAuthority: false,
    cmsAuthentication: false, nativeEnforcement: false, loadedImageAuthentication: false } };
}
