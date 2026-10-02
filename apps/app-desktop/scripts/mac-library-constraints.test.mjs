import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAuthenticatedLibraryConstraint as extract, extractPackagedParentLibraryConstraints as extractPackaged, verifyLibraryConstraintPolicy } from './mac-library-constraints.mjs';
import { fixture, fatFixture, rebind, digest } from './mac-library-constraints.test-fixtures.mjs';
const reject = f => assert.throws(() => extract(f.bytes, f.expected), /^Error: macOS library constraint:/);

for (const version of [0x20400, 0x20500, 0x20600]) for (const page of [12, 14]) {
  test(`synthetic extraction only: version ${version}, page ${page}`, () => {
    const f = fixture({ version, page }), before = Buffer.from(f.bytes);
    const result = extract(f.bytes, f.expected);
    assert.deepEqual(result.rawBlob, f.raw);
    assert.equal(result.policyStatus, 'unsupported');
    assert.equal(result.codeDirectoryVersion, version);
    assert.deepEqual(result.slice, f.expected.slice);
    result.rawBlob.fill(0); result.slice.offset = 55;
    assert.deepEqual(f.bytes, before);
    assert.deepEqual(extract(f.bytes, f.expected).rawBlob, f.raw);
  });
}
test('policy validation ALWAYS throws, including extracted opaque bytes or plausible DER', () => {
  const f = fixture();
  for (const value of [undefined, Buffer.from([0x30, 0]), extract(f.bytes, f.expected), { team: 'SYNTHETIC', cdhashes: [] }]) {
    assert.throws(() => verifyLibraryConstraintPolicy(value), { code: 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_UNSUPPORTED' });
  }
});
for (const wide of [false, true]) test(`fat${wide ? 64 : 32} selects exact kernel slice, not first/host`, () => {
  const f = fatFixture(wide);
  assert.deepEqual(extract(f.bytes, f.expected).rawBlob, f.a.raw);
  const expectedB = { ...f.b.expected, slice: { ...f.b.expected.slice, offset: f.offsetB } };
  assert.deepEqual(extract(f.bytes, expectedB).rawBlob, f.b.raw);
  reject({ ...f, expected: { ...f.expected, cdHash: f.b.expected.cdHash } });
  f.bytes[f.offsetB + 400] ^= 1; // malformed unselected slice also refuses
  reject(f);
});

test('trusted kernel evidence is mandatory, exact and not coerced', () => {
  const f = fixture();
  for (const expected of [undefined, {}, { ...f.expected, cdHash: f.expected.cdHash.toString('hex') },
    { ...f.expected, cdHash: Buffer.alloc(32) }, { ...f.expected, cdHash: Buffer.alloc(20) }]) reject({ ...f, expected });
  for (const key of ['offset', 'size', 'cpuType', 'cpuSubtype']) {
    for (const value of [undefined, -1, NaN, 1.5, f.expected.slice[key] + 1]) {
      reject({ ...f, expected: { ...f.expected, slice: { ...f.expected.slice, [key]: value } } });
    }
  }
  reject({ ...f, bytes: new Uint8Array(f.bytes) });
  reject({ ...f, bytes: Buffer.from(new SharedArrayBuffer(f.bytes.length)) });
});

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
for (const [name, mutate] of Object.entries(mutations)) test(`fail closed: ${name}`, () => {
  const f = fixture(); mutate(f); rebind(f); reject(f);
});
for (const [version, field] of [[0x20500, 92], [0x20600, 96], [0x20600, 100], [0x20600, 104]]) test(`unsupported optional field ${version}/${field}`, () => {
  const f = fixture({ version }); f.bytes[f.cdOffset + field] = 1; rebind(f); reject(f);
});

test('whole blob, not payload-only, authenticates slot -11', () => {
  const f = fixture(); digest(f.raw.subarray(8)).copy(f.bytes, f.cdOffset + f.hashStart); rebind(f); reject(f);
});
test('tampering CD, payload, or covered bytes fails independently', () => {
  for (const where of ['cd', 'raw', 'page']) {
    const f = fixture(); f.bytes[{ cd: f.cdOffset + 12, raw: f.rawOffset + 8, page: 400 }[where]] ^= 1; reject(f);
  }
});
test('component overlap cannot hide inside authenticated CD', () => {
  const f = fixture();
  const offset = f.cdOffset + 64;
  f.bytes.writeUInt32BE(offset - f.signature, f.signature + 24);
  f.bytes.writeUInt32BE(0xfade8181, offset); f.bytes.writeUInt32BE(9, offset + 4);
  rebind(f); reject(f);
});
test('every truncated prefix rejects without leaking buffer exceptions', () => {
  const f = fixture();
  for (let n = 0; n < f.bytes.length; n++) reject({ ...f, bytes: f.bytes.subarray(0, n), expected: { ...f.expected, slice: { ...f.expected.slice, size: n } } });
});
for (const wide of [false, true]) test(`malformed fat${wide ? 64 : 32} table`, () => {
  const mutations = [
    f => f.bytes.writeUInt32BE(3, 4),
    f => f.bytes.writeUInt32BE(31, 8 + (wide ? 24 : 16)),
    f => f.bytes.writeUInt32BE(7, 8),
    f => f.bytes.writeUInt32BE(0x0100000c, 8 + (wide ? 32 : 20)),
    f => wide ? f.bytes.writeBigUInt64BE(8n, 16) : f.bytes.writeUInt32BE(8, 16),
    f => wide ? f.bytes.writeBigUInt64BE(2n ** 63n, 16) : f.bytes.writeUInt32BE(0xffffffff, 16),
    f => wide ? f.bytes.writeBigUInt64BE(4096n, 48) : f.bytes.writeUInt32BE(4096, 36),
  ];
  if (wide) mutations.push(f => f.bytes.writeUInt32BE(1, 36));
  for (const mutate of mutations) { const f = fatFixture(wide); mutate(f); reject(f); }
});
test('error messages never contain artifact/hash material', () => {
  const f = fixture(); f.expected.cdHash.fill(0x99);
  assert.throws(() => extract(f.bytes, f.expected), e => e.message === 'macOS library constraint: kernel CDHash mismatch');
});

test('two individually framed LC_CODE_SIGNATURE commands reject', () => {
  const f = fixture(); f.bytes.copy(f.bytes, 192, 176, 192);
  f.bytes.writeUInt32LE(4, 16); f.bytes.writeUInt32LE(176, 20);
  rebind(f); reject(f);
});
test('unknown CD flags / executable segment range reject with matching synthetic CDHash', () => {
  for (const mutate of [
    f => f.bytes.writeUInt32BE(0x80000000, f.cdOffset + 12),
    f => f.bytes.writeBigUInt64BE(0x400n, f.cdOffset + 80),
    f => f.bytes.writeBigUInt64BE(4097n, f.cdOffset + 72),
    f => f.bytes.writeBigUInt64BE(2n ** 63n, f.cdOffset + 64),
  ]) { const f = fixture(); mutate(f); rebind(f); reject(f); }
});
test('unused allocation is opaque; declared tail and indexed extents remain strict', () => {
  const f = fixture(), old = f.bytes.length;
  f.bytes = Buffer.concat([f.bytes, Buffer.alloc(32)]);
  f.bytes.writeUInt32LE(f.bytes.length - f.signature, 188);
  f.bytes.writeBigUInt64LE(BigInt(f.bytes.length - f.signature), 152);
  f.expected.slice.size = f.bytes.length;
  rebind(f);
  assert.deepEqual(extract(f.bytes, f.expected).rawBlob, f.raw);
  const before = extract(f.bytes, f.expected), cdHash = Buffer.from(f.expected.cdHash);
  f.bytes[old] = 1;
  assert.deepEqual(extract(f.bytes, f.expected), before);
  assert.deepEqual(f.expected.cdHash, cdHash);
  const length = old - f.signature;
  f.bytes.writeUInt32BE(length + 1, f.signature + 4); reject(f); // Nonzero declared tail.
  f.bytes.writeUInt32BE(length - 1, f.signature + 4); reject(f); // Component crosses declared end.
  f.bytes.writeUInt32BE(length, f.signature + 4);
  f.raw.copy(f.bytes, old);
  f.bytes.writeUInt32BE(length, f.signature + 24); reject(f); // Header in unused allocation.
});
test('multi-page coverage checks every page, including short last page', () => {
  // Move the signature and rebuild the CD page table, preserving opaque blob.
  const f = fixture(), oldCd = f.bytes.subarray(f.cdOffset, f.rawOffset);
  const signature = 9000, cd = Buffer.concat([oldCd, Buffer.alloc(64)]);
  cd.writeUInt32BE(cd.length, 4); cd.writeUInt32BE(3, 28); cd.writeUInt32BE(signature, 32);
  const sb = Buffer.alloc(28 + cd.length + f.raw.length);
  sb.writeUInt32BE(0xfade0cc0); sb.writeUInt32BE(sb.length, 4); sb.writeUInt32BE(2, 8);
  sb.writeUInt32BE(28, 16); sb.writeUInt32BE(11, 20); sb.writeUInt32BE(28 + cd.length, 24);
  const bytes = Buffer.alloc(signature + sb.length); f.bytes.copy(bytes, 0, 0, f.signature);
  bytes.writeBigUInt64LE(BigInt(signature), 80);
  bytes.writeBigUInt64LE(BigInt(signature), 144); bytes.writeBigUInt64LE(BigInt(sb.length), 152);
  bytes.writeUInt32LE(signature, 184); bytes.writeUInt32LE(sb.length, 188);
  for (let p = 0; p < 3; p++) digest(bytes.subarray(p * 4096, Math.min((p + 1) * 4096, signature))).copy(cd, f.hashes + p * 32);
  cd.copy(sb, 28); f.raw.copy(sb, 28 + cd.length); sb.copy(bytes, signature);
  const expected = { cdHash: digest(cd).subarray(0, 20), slice: { ...f.expected.slice, size: bytes.length } };
  assert.deepEqual(extract(bytes, expected).rawBlob, f.raw);
  for (const at of [500, 5000, 8999]) { bytes[at] ^= 1; reject({ bytes, expected }); bytes[at] ^= 1; }
});
test('deterministic malformed-input smoke test produces only scoped errors', () => {
  let seed = 0x12345678;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 1000; i++) {
    const f = fixture();
    const at = next() % f.bytes.length; f.bytes[at] ^= 1 << (next() % 8);
    try { assert.equal(extract(f.bytes, f.expected).policyStatus, 'unsupported'); }
    catch (e) { assert.match(e.message, /^macOS library constraint:/); }
  }
});

// Signed-like framing only: deliberately invalid CMS proves no signer claim.
function withOpaqueCMS(f) {
  const cd = Buffer.from(f.bytes.subarray(f.cdOffset, f.rawOffset));
  cd.writeUInt32BE(0x10000, 12); // runtime, not ad-hoc
  const cms = Buffer.from('opaque CMS DATA, NOT a signature');
  const sb = Buffer.alloc(36 + cd.length + f.raw.length + 8 + cms.length);
  sb.writeUInt32BE(0xfade0cc0); sb.writeUInt32BE(sb.length, 4); sb.writeUInt32BE(3, 8);
  for (const [i, type, offset] of [[0, 0, 36], [1, 11, 36 + cd.length], [2, 0x10000, 36 + cd.length + f.raw.length]]) {
    sb.writeUInt32BE(type, 12 + i * 8); sb.writeUInt32BE(offset, 16 + i * 8);
  }
  cd.copy(sb, 36); f.raw.copy(sb, 36 + cd.length);
  const cmsOffset = 36 + cd.length + f.raw.length;
  sb.writeUInt32BE(0xfade0b01, cmsOffset); sb.writeUInt32BE(8 + cms.length, cmsOffset + 4); cms.copy(sb, cmsOffset + 8);
  f.bytes = Buffer.concat([f.bytes.subarray(0, f.signature), sb]);
  f.bytes.writeUInt32LE(sb.length, 188); f.bytes.writeBigUInt64LE(BigInt(sb.length), 152);
  f.cdOffset = f.signature + 36; f.rawOffset = f.cdOffset + cd.length;
  f.expected.slice.size = f.bytes.length; rebind(f);
  return f;
}

for (const cpu of [{ cpuType: 0x0100000c, cpuSubtype: 0 }, { cpuType: 0x01000007, cpuSubtype: 3 }]) {
  test(`packaged parent: opaque CMS is data only, cpu ${cpu.cpuType}`, () => {
    const f = withOpaqueCMS(fixture(cpu)), before = Buffer.from(f.bytes);
    const result = extractPackaged(f.bytes);
    assert.deepEqual(result, [{ rawBlob: f.raw, slice: f.expected.slice,
      codeDirectoryVersion: 0x20400, policyStatus: 'unsupported', productionAuthority: false }]);
    assert.deepEqual(f.bytes, before);
    assert.throws(() => verifyLibraryConstraintPolicy(result[0]), { code: 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_UNSUPPORTED' });
    result[0].rawBlob.fill(0); result[0].slice.offset = 99;
    assert.deepEqual(f.bytes, before);
    // Neither opaque CMS mutations nor a caller's invented kernel hash are authority.
    f.bytes[f.bytes.length - 1] ^= 1; f.expected.cdHash.fill(0);
    assert.deepEqual(extractPackaged(f.bytes)[0].rawBlob, f.raw);
    reject(f);
  });
}
for (const wide of [false, true]) test(`packaged parent: all signed-like fat${wide ? 64 : 32} slices`, () => {
  const f = fatFixture(wide);
  withOpaqueCMS(f.a); withOpaqueCMS(f.b);
  f.bytes = Buffer.concat([f.bytes.subarray(0, f.offsetB), f.b.bytes]);
  f.a.bytes.copy(f.bytes, f.offsetA);
  for (const [i, part] of [[0, f.a], [1, f.b]]) {
    const at = 8 + i * (wide ? 32 : 20);
    if (wide) f.bytes.writeBigUInt64BE(BigInt(part.bytes.length), at + 16);
    else f.bytes.writeUInt32BE(part.bytes.length, at + 12);
  }
  const results = extractPackaged(f.bytes);
  assert.equal(results.length, 2);
  for (const [i, part, offset] of [[0, f.a, f.offsetA], [1, f.b, f.offsetB]]) {
    assert.deepEqual(results[i].rawBlob, part.raw);
    assert.deepEqual(results[i].slice, { ...part.expected.slice, offset });
    assert.equal(results[i].productionAuthority, false);
  }
  for (const offset of [f.offsetA, f.offsetB]) {
    f.bytes[offset + 400] ^= 1;
    assert.throws(() => extractPackaged(f.bytes), /code page hash mismatch/);
    f.bytes[offset + 400] ^= 1;
  }
});
test('packaged parent: only MH_EXECUTE, even with self-consistent hashes', () => {
  for (const type of [1, 6, 8]) {
    const f = withOpaqueCMS(fixture()); f.bytes.writeUInt32LE(type, 12); rebind(f);
    assert.throws(() => extractPackaged(f.bytes), /must be MH_EXECUTE/);
  }
});
test('packaged parent: code and whole constraint hashes remain mandatory', () => {
  for (const where of ['page', 'raw', 'hash']) {
    const f = withOpaqueCMS(fixture());
    f.bytes[{ page: 400, raw: f.rawOffset + 8, hash: f.cdOffset + f.hashStart }[where]] ^= 1;
    assert.throws(() => extractPackaged(f.bytes), /(?:code page|special slot) hash mismatch/);
  }
  const f = withOpaqueCMS(fixture()); digest(f.raw.subarray(8)).copy(f.bytes, f.cdOffset + f.hashStart);
  assert.throws(() => extractPackaged(f.bytes), /special slot hash mismatch/);
});
for (const [name, mutate] of Object.entries(mutations)) test(`packaged parent unsupported layout: ${name}`, () => {
  const f = withOpaqueCMS(fixture()); mutate(f); rebind(f);
  assert.throws(() => extractPackaged(f.bytes), /^Error: macOS library constraint:/);
});
test('packaged parent: invalid buffers and every truncated prefix fail with scoped errors', () => {
  const f = withOpaqueCMS(fixture());
  for (const bytes of [undefined, new Uint8Array(f.bytes), Buffer.from(new SharedArrayBuffer(f.bytes.length))]) {
    assert.throws(() => extractPackaged(bytes), /invalid artifact bytes/);
  }
  for (let n = 0; n < f.bytes.length; n++) {
    assert.throws(() => extractPackaged(f.bytes.subarray(0, n)), /^Error: macOS library constraint:/);
  }
});
