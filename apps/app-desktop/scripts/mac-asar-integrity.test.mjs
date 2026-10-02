import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { integrityDictionaryDigest, integritySlots, populateIntegrityDigest, verifyIntegrityDigest, integritySentinel, requireElectronVersion } from './mac-asar-integrity.mjs';
import { thinFramework, universalFramework, syntheticPageHashes, digestOffset, signatureOffset } from './mac-asar-integrity.test-fixtures.mjs';

const dictionary = { 'Resources/app.asar': { algorithm: 'SHA256', hash: '0'.repeat(64) } };
const populated = () => populateIntegrityDigest(thinFramework(), dictionary);
const covered = () => syntheticPageHashes(populated());
const cdOffset = signatureOffset + 20;

test('pinned Electron43.2.0 digest hashes sorted literal ASCII keys/algorithm/HEX TEXT without separators', () => {
  requireElectronVersion('43.2.0');
  for (const version of [undefined, null, 43, '43.2', '43.2.1', '43.2.0-beta.1', '44.0.0']) assert.throws(() => requireElectronVersion(version));
  assert.equal(integrityDictionaryDigest(dictionary).toString('hex'), '0d0379b03797cd157251d6af924f85f98ed473f75cad417b8b500f220c518cde');
  const entries = ['Resources/z.asar', 'Resources/a.asar', 'Resources/A.asar', 'Resources/nested/a.asar'].map(key => [key, dictionary['Resources/app.asar']]);
  const first = Object.fromEntries(entries), second = Object.fromEntries([...entries].reverse());
  assert.deepEqual(integrityDictionaryDigest(first), integrityDictionaryDigest(second));
  const input = ['Resources/A.asar', 'Resources/a.asar', 'Resources/nested/a.asar', 'Resources/z.asar'].map(key => key + 'SHA256' + '0'.repeat(64)).join('');
  assert.deepEqual(integrityDictionaryDigest(first), createHash('sha256').update(input).digest());
  assert.deepEqual(integrityDictionaryDigest(Object.assign(Object.create(null), dictionary)), integrityDictionaryDigest(dictionary));
});

test('dictionary parser rejects ambiguous/unsupported types, paths, algorithms and hash encodings', () => {
  for (const value of [null, [], true, 'dictionary', {}, new Date(), Object.create(dictionary)]) assert.throws(() => integrityDictionaryDigest(value));
  for (const item of [null, [], {}, { algorithm: 'SHA1', hash: '0'.repeat(64) }, { algorithm: 'SHA256', hash: Buffer.alloc(32) },
    { algorithm: 'SHA256', hash: 'A'.repeat(64) }, { algorithm: 'SHA256', hash: 'a'.repeat(63) }, { algorithm: 'SHA256', hash: 'a'.repeat(65) },
    { algorithm: 'SHA256', hash: '0'.repeat(64), extra: true }, { algorithm: 'SHA256', hash: true }]) {
    assert.throws(() => integrityDictionaryDigest({ 'Resources/app.asar': item }));
  }
  for (const path of ['../app.asar', '/Resources/app.asar', 'Resources/../app.asar', 'Resources/./app.asar', 'Resources//app.asar',
    'Resources/é.asar', 'Resources/a\0.asar', 'Resources/a\\b.asar', 'Resources/a.asar\n', 'Resources/a.js', 'Resources/' + 'x'.repeat(1024) + '.asar']) {
    assert.throws(() => integrityDictionaryDigest({ [path]: dictionary['Resources/app.asar'] }));
  }
  const accessor = {}; Object.defineProperty(accessor, 'Resources/app.asar', { enumerable: true, get() { throw Error('must not execute accessor'); } });
  assert.throws(() => integrityDictionaryDigest(accessor), /invalid integrity dictionary/);
  const hidden = { ...dictionary }; Object.defineProperty(hidden, 'hidden', { value: 1 });
  assert.throws(() => integrityDictionaryDigest(hidden));
  assert.throws(() => integrityDictionaryDigest({ ...dictionary, [Symbol('hidden')]: 1 }));
  assert.throws(() => integrityDictionaryDigest(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`Resources/a${i}.asar`, dictionary['Resources/app.asar']]))));
});

test('thin arm64/x86_64 and fat32/fat64 slots are populated exactly and read back before signing', () => {
  for (const bytes of [thinFramework(), thinFramework(0x01000007), universalFramework(), universalFramework(undefined, undefined, true)]) {
    const before = Buffer.from(bytes), patched = populateIntegrityDigest(bytes, dictionary), slots = integritySlots(bytes);
    assert.deepEqual(bytes, before, 'pure writer cannot mutate source on failure or success');
    assert.equal(verifyIntegrityDigest(patched, dictionary, { requireSignatureCoverage: false }), slots.length);
    assert.throws(() => verifyIntegrityDigest(patched, dictionary), /page hash mismatch/, 'pre-sign mutation must invalidate old coverage');
    const outside = Buffer.from(patched);
    for (const { slot } of slots) {
      assert.equal(patched[slot + 32], 1); assert.equal(patched[slot + 33], 1);
      assert.deepEqual(patched.subarray(slot + 34, slot + 66), integrityDictionaryDigest(dictionary));
      before.copy(outside, slot + 32, slot + 32, slot + 66);
    }
    assert.deepEqual(outside, before, 'only the digest payload may change');
    assert.deepEqual(populateIntegrityDigest(patched, dictionary), patched, 'idempotent pre-sign writing');
    assert.equal(verifyIntegrityDigest(syntheticPageHashes(patched), dictionary), slots.length);
  }
});

test('strict section/segment/load-command bounds and mapping reject malformed layouts', () => {
  const mutations = [
    b => b.writeUInt32LE(0, 16), b => b.writeUInt32LE(4097, 16), b => b.writeUInt32LE(311, 20),
    b => b.writeUInt32LE(7, 36), b => b.writeUInt32LE(0xfffffff8, 36), b => b.writeUInt32LE(0, 12),
    b => b.writeUInt32LE(2, 168), // section count inconsistent with command size
    b => b.writeBigUInt64LE(4095n, 144), // segment fileoff/address disagreement
    b => b.writeBigUInt64LE(4097n, 152), // file size exceeds vm size
    b => b.writeBigUInt64LE(4095n, 208), // section before segment
    b => b.writeBigUInt64LE(8190n, 208), // section beyond segment vm range
    b => b.writeBigUInt64LE(65n, 216), b => b.writeBigUInt64LE(67n, 216),
    b => b.writeUInt32LE(4353, 224), b => b.writeUInt32LE(31, 228), b => b.writeUInt32LE(10, 228),
    b => b.writeUInt32LE(1, 240), b => b.writeUInt32LE(0x80000000, 240),
    b => b.writeUInt32LE(1, 236), b => b.writeUInt32LE(1, 232),
    b => b.writeUInt32LE(5, 164), // executable DATA_CONST
    b => b.fill(0, 192, 208), b => b.fill(0, 176, 192), b => b.fill(0, 112, 128),
    b => { b[123] = 0; b[124] = 65; }, // noncanonical name padding
    b => b.writeBigUInt64LE(0xffffffffffffffffn, 144),
    b => b.writeBigUInt64LE(4000n, 280), // overlapping VM segments
    b => b.writeBigUInt64LE(8000n, 296), // overlapping file segments
    b => b.writeUInt32LE(0xffffffff, 336), b => b.writeUInt32LE(0xffffffff, 340),
    b => b.writeUInt32LE(4352, 336), // signature overlaps integrity section
  ];
  for (const [i, mutate] of mutations.entries()) {
    const b = thinFramework(); mutate(b);
    assert.throws(() => populateIntegrityDigest(b, dictionary), undefined, `layout mutation ${i}`);
  }
  for (const length of [0, 4, 31, 200, digestOffset + 65, 8500]) assert.throws(() => integritySlots(thinFramework().subarray(0, length)));
  // Duplicate the section descriptor and grow the table/load command region.
  const duplicate = thinFramework();
  duplicate.copy(duplicate, 336, 256, 344); duplicate.copy(duplicate, 256, 176, 256);
  duplicate.writeUInt32LE(232, 108); duplicate.writeUInt32LE(2, 168); duplicate.writeUInt32LE(392, 20);
  assert.throws(() => integritySlots(duplicate), /duplicate/);
});

test('missing/extra sentinels and unsupported/ambiguous architecture coverage fail closed', () => {
  const mutations = [
    b => b.writeUInt32BE(3, 4), b => b.writeUInt32BE(0, 8),
    b => b.writeUInt32BE(3, 32), // arm64e/unsupported subtype
    b => b.writeUInt32BE(4096, 36), // overlapping slices
    b => b.writeUInt32BE(0xffffffff, 40), b => b.writeUInt32BE(31, 44),
    b => integritySentinel.copy(b, 100),
    b => b.fill(0, 16384 + digestOffset, 16384 + digestOffset + 32),
    b => integritySentinel.copy(b, 16384 + 700),
  ];
  for (const mutate of mutations) { const b = universalFramework(); mutate(b); assert.throws(() => integritySlots(b)); }
  assert.throws(() => integritySlots(universalFramework(thinFramework(), thinFramework())), /duplicate/);
  const bad64 = universalFramework(undefined, undefined, true); bad64.writeBigUInt64BE(0xffffffffffffffffn, 16);
  assert.throws(() => integritySlots(bad64));
  const reserved = universalFramework(undefined, undefined, true); reserved.writeUInt32BE(1, 36);
  assert.throws(() => integritySlots(reserved));
});

test('unused, unknown, wrong and inconsistent digest slots fail read-only verification', () => {
  assert.throws(() => verifyIntegrityDigest(thinFramework(), dictionary), /unused/);
  for (const [used, version] of [[0, 1], [2, 1], [1, 0], [1, 2], [255, 255]]) {
    const b = populated(); b[digestOffset + 32] = used; b[digestOffset + 33] = version;
    assert.throws(() => verifyIntegrityDigest(b, dictionary));
    assert.throws(() => populateIntegrityDigest(b, dictionary));
  }
  const dirty = thinFramework(); dirty[digestOffset + 34] = 1;
  assert.throws(() => populateIntegrityDigest(dirty, dictionary), /non-pristine/);
  const wrong = covered(); wrong[digestOffset + 34] ^= 1;
  const before = Buffer.from(wrong); assert.throws(() => verifyIntegrityDigest(wrong, dictionary), /incorrect/); assert.deepEqual(wrong, before);
  const second = populateIntegrityDigest(universalFramework(), dictionary); second[16384 + digestOffset + 34] ^= 1;
  assert.throws(() => verifyIntegrityDigest(second, dictionary, { requireSignatureCoverage: false }));
  const mixed = universalFramework(); mixed[16384 + digestOffset + 33] = 2;
  const pristine = Buffer.from(mixed); assert.throws(() => populateIntegrityDigest(mixed, dictionary)); assert.deepEqual(mixed, pristine);
});

test('final signature coverage requires bounded CodeDirectories and matching slot page hashes, not CMS authority', () => {
  assert.equal(verifyIntegrityDigest(covered(), dictionary), 1);
  const mutations = [
    b => b.writeUInt32LE(0x1b, 328), // remove LC_CODE_SIGNATURE
    b => b.writeUInt32BE(0, signatureOffset), b => b.writeUInt32BE(0xffffffff, signatureOffset + 4),
    b => b.writeUInt32BE(0xffffffff, signatureOffset + 8), b => b.writeUInt32BE(1, signatureOffset + 12),
    b => b.writeUInt32BE(0, signatureOffset + 16), b => b.writeUInt32BE(0xffffffff, cdOffset + 4),
    b => b.writeUInt32BE(0x20700, cdOffset + 8), b => { b[cdOffset + 36] = 20; }, b => { b[cdOffset + 37] = 1; },
    b => { b[cdOffset + 39] = 0; }, b => b.writeUInt32BE(1, cdOffset + 44),
    b => b.writeUInt32BE(99, cdOffset + 16), b => b.writeUInt32BE(65, cdOffset + 24),
    b => b.writeUInt32BE(1, cdOffset + 28), b => b.writeUInt32BE(4096, cdOffset + 32),
    b => b.writeBigUInt64BE(0xffffffffffffffffn, cdOffset + 56),
    b => { b[cdOffset + 132] ^= 1; }, b => { b[digestOffset - 1] ^= 1; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const b = covered(); mutate(b); assert.throws(() => verifyIntegrityDigest(b, dictionary), undefined, `signature mutation ${i}`);
  }
  // Missing signature is permissible ONLY in the explicitly pre-sign phase.
  const unsigned = populated(); unsigned.writeUInt32LE(0x1b, 328);
  assert.equal(verifyIntegrityDigest(unsigned, dictionary, { requireSignatureCoverage: false }), 1);
  assert.throws(() => verifyIntegrityDigest(unsigned, dictionary), /missing final/);
  // Verify the entire slot even when it straddles a signature page boundary.
  const boundary = thinFramework(); boundary.fill(0, digestOffset, digestOffset + 66);
  integritySentinel.copy(boundary, 4096 - 32);
  boundary.writeBigUInt64LE(4096n - 32n, 208); boundary.writeUInt32LE(4096 - 32, 224);
  // Move the DATA_CONST boundary and TEXT size together, preserving file/VM maps.
  boundary.writeBigUInt64LE(4064n, 64); boundary.writeBigUInt64LE(4064n, 80);
  boundary.writeBigUInt64LE(4064n, 128); boundary.writeBigUInt64LE(4128n, 136);
  boundary.writeBigUInt64LE(4064n, 144); boundary.writeBigUInt64LE(4128n, 152);
  const good = syntheticPageHashes(populateIntegrityDigest(boundary, dictionary));
  assert.equal(verifyIntegrityDigest(good, dictionary), 1);
  good[cdOffset + 100] ^= 1;
  assert.throws(() => verifyIntegrityDigest(good, dictionary), /page hash mismatch/);
});
