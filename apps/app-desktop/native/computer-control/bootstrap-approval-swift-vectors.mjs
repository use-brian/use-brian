// TEST ONLY: synthetic Mach-O, synthetic kernel expectations, real Node SHA256.
// The production API cannot prove provenance of arguments; tests never claim it.
import assert from 'node:assert/strict';
import { approval, thin, fat, rehash, component, cdOffset, anchorOffset, signatureOffset, sha } from '../../scripts/mac-bootstrap-anchor.test-fixtures.mjs';
import { emptyBootstrapApprovalRecord as empty, encodeBootstrapApprovalRecord as encode,
  decodeBootstrapApprovalRecord as decode, verifyBootstrapApprovalCoverage as verify } from '../../scripts/mac-bootstrap-anchor.mjs';
const recordChanges = {
  marker: b => b[0] ^= 1, version: b => b[33] = 2, used: b => b[34] = 2,
  reserved: b => b[35] = 1, size: b => b.writeUInt32BE(1375, 36), length: b => b.writeUInt32BE(96, 40),
  zeroCount: b => b.writeUInt16BE(0, 44), excessiveCount: b => b.writeUInt16BE(65, 44),
  hashWidth: b => b[46] = 32, digestWidth: b => b[47] = 20, electron: b => b[48] = 0x35,
  electronNul: b => b[54] = 1, reserved2: b => b[56] = 1, zeroDigest: b => b.fill(0, 64, 96),
  zeroHash: b => b.fill(0, 96, 116), duplicate: b => b.copy(b, 116, 96, 116),
  unsorted: b => b[96] = 0xff, padding: b => b[1375] = 1,
};

const machoChanges = {
  magic: b => b.writeUInt32LE(0xfeedface), cpu: b => b.writeUInt32LE(7, 4), subtype: b => b.writeUInt32LE(2, 8),
  dylib: b => b.writeUInt32LE(6, 12), headerReserved: b => b[28] = 1,
  commandCount: b => b.writeUInt32LE(3, 16), commandOverflow: b => b.writeUInt32LE(0xffffffff, 20),
  commandUnknown: b => b.writeUInt32LE(0x1234, 32), commandAlignment: b => b.writeUInt32LE(71, 36),
  segmentName: b => b[112] = 0x41, sectionName: b => b[176] = 0x41, owner: b => b[192] = 0x41,
  duplicateSegment: b => { b.fill(0, 112, 128); b.write('__TEXT', 112); },
  missingReadonly: b => b.writeUInt32LE(0, 172), executeProtection: b => b.writeUInt32LE(7, 160),
  unreadable: b => b.writeUInt32LE(0, 164), virtualOverlap: b => b.writeBigUInt64LE(0n, 128),
  fileOverlap: b => b.writeBigUInt64LE(0n, 144), fileRange: b => b.writeBigUInt64LE(2n ** 63n, 144),
  sectionVM: b => b.writeBigUInt64LE(0n, 208), sectionSize: b => b.writeBigUInt64LE(1375n, 216),
  sectionOffset: b => b.writeUInt32LE(16, 224), sectionAlignment: b => b.writeUInt32LE(3, 228),
  sectionReloc: b => b.writeUInt32LE(1, 236), sectionReserved: b => b.writeUInt32LE(1, 244),
  sectionUnknownType: b => b.writeUInt32LE(0x100000ff, 240), sectionZeroFill: b => b.writeUInt32LE(0x10000001, 240),
  sectionUnknownFlags: b => b.writeUInt32LE(0x01000000, 240), sectionMissingNoDeadStrip: b => b.writeUInt32LE(0, 240),
  sectionsCount: b => b.writeUInt32LE(2, 168),
  noHeaderMap: b => b.writeBigUInt64LE(0n, 80),
  signatureBeforeHeader: b => b.writeUInt32LE(0, 336), signatureNotAtEnd: b => b.writeUInt32LE(128, 340),
  signatureAlignment: b => b.writeUInt32LE(signatureOffset + 1, 336),
  duplicateSignature: b => { b.copy(b, 344, 328, 344); b.writeUInt32LE(5, 16); b.writeUInt32LE(328, 20); },
  extraMarker: b => empty().subarray(0, 32).copy(b, 512),
};

const cdChanges = {
  wrongMagic: (b, cd) => b.writeUInt32BE(0xfade0c01, cd), short: (b, cd) => b.writeUInt32BE(80, cd + 4),
  oldVersion: (b, cd) => b.writeUInt32BE(0x20300, cd + 8), newVersion: (b, cd) => b.writeUInt32BE(0x20700, cd + 8),
  SHA1: (b, cd) => b[cd + 37] = 1, SHA256truncated: (b, cd) => b[cd + 37] = 3, SHA384: (b, cd) => b[cd + 37] = 4,
  hashWidth: (b, cd) => b[cd + 36] = 20, platform: (b, cd) => b[cd + 38] = 1, infinitePage: (b, cd) => b[cd + 39] = 0,
  scatter: (b, cd) => b.writeUInt32BE(88, cd + 44), limit64: (b, cd) => b.writeBigUInt64BE(12288n, cd + 56),
  spare2: (b, cd) => b[cd + 40] = 1, spare3: (b, cd) => b[cd + 52] = 1,
  hashesUnderflow: (b, cd) => b.writeUInt32BE(1, cd + 16), hashesOverflow: (b, cd) => b.writeUInt32BE(0xffffffff, cd + 16),
  pageCount: (b, cd) => b.writeUInt32BE(0xffffffff, cd + 28), codeLimit: (b, cd) => b.writeUInt32BE(4096, cd + 32),
  identOverlap: (b, cd) => b.writeUInt32BE(8, cd + 20), missingIdent: (b, cd) => b.writeUInt32BE(0, cd + 20),
  teamOverlap: (b, cd) => b.writeUInt32BE(88, cd + 48), flags: (b, cd) => b.writeUInt32BE(0x80000000, cd + 12),
  execFlags: (b, cd) => b.writeBigUInt64BE(0x400n, cd + 80), execRange: (b, cd) => b.writeBigUInt64BE(2n ** 63n, cd + 72),
};
const bad = { error: 'ERR_SWIFT_BOOTSTRAP_APPROVAL' };
function dto(data) {
  return { kind: 'bootstrap-approval-data', electronVersion: data.electronVersion,
    asarDigest: data.asarDigest.toString('base64'), libraryCDHashes: data.libraryCDHashes.map(b => b.toString('base64')),
    productionAuthority: false, cmsAuthentication: false, staticSignerAuthentication: false,
    kernelProvenanceAuthentication: false, mappedRecordProvenanceAuthentication: false,
    nativeEnforcement: false, loadedImageAuthentication: false };
}
export function syntheticKernelHash(b, offset = 0) {
  const slice = b.subarray(offset), cd = cdOffset(slice), length = slice.readUInt32BE(cd + 4);
  return sha(slice.subarray(cd, cd + length)).subarray(0, 20);
}
function filled(options = {}, count = 2) { const b = thin(options); encode(approval(count)).copy(b, anchorOffset); return rehash(b); }
export function bootstrapVectors() {
  const vectors = [];
  const addDecode = (name, record, want) => {
    let expected;
    try { expected = { match: dto(decode(record)) }; } catch (error) { assert.equal(error.code, "ERR_MAC_BOOTSTRAP_ANCHOR"); expected = bad; }
    if (want !== undefined) assert.equal(!!expected.match, want, name);
    vectors.push({ name, mode: 'decode', record: record.toString('base64'), expected });
  };
  const addBind = (name, bytes, { record = encode(approval()), offset = 0, architecture = 'arm64',
    hash = syntheticKernelHash(bytes, Number(offset)), want = false } = {}) => {
    let expected;
    try {
      const data = decode(record);
      verify(bytes, { electronVersion: data.electronVersion, asarDigest: data.asarDigest, libraryCDHashes: data.libraryCDHashes });
      const o = Number(offset), isFat = [0xcafebabe, 0xcafebabf].includes(bytes.readUInt32BE(0));
      if (!Number.isSafeInteger(o) || o < 0) throw Error('context');
      if (isFat) {
        const wide = bytes.readUInt32BE(0) === 0xcafebabf, stride = wide ? 32 : 20;
        const offsets = Array.from({ length: bytes.readUInt32BE(4) }, (_, i) => wide ? Number(bytes.readBigUInt64BE(16 + i * stride)) : bytes.readUInt32BE(16 + i * stride));
        if (!offsets.includes(o)) throw Error('selection');
      } else if (o !== 0) throw Error('selection');
      if (bytes.readUInt32LE(o + 4) !== (architecture === 'arm64' ? 0x0100000c : 0x01000007) ||
          hash.length !== 20 || !hash.equals(syntheticKernelHash(bytes, o))) throw Error('kernel');
      expected = { match: dto(data) };
    } catch (error) {
      assert(error.code === 'ERR_MAC_BOOTSTRAP_ANCHOR' || ['context', 'selection', 'kernel'].includes(error.message), `${name}: unexpected oracle error ${error.message}`);
      expected = bad;
    }
    assert.equal(!!expected.match, want, name);
    vectors.push({ name, mode: 'bind', bytes: bytes.toString('base64'), record: record.toString('base64'),
      offset: String(offset), architecture, cdHash: hash.toString('base64'), expected });
  };
  addDecode('valid-record', encode(approval()), true);
  for (const count of [1, 63, 64]) addDecode(`valid-record-${count}`, encode(approval(count)), true);
  addDecode('empty', empty(), false); addDecode('all-zero', Buffer.alloc(1376), false);
  for (const [name, change] of Object.entries(recordChanges)) { const b = encode(approval()); change(b); addDecode(name, b, false); }
  for (let n = 0; n < 1376; n++) addDecode(`record-truncated-${n}`, encode(approval()).subarray(0, n), false);
  addDecode('record-trailing', Buffer.concat([encode(approval()), Buffer.alloc(1)]), false);
  // Includes permitted digest/inventory mutations: JS independently supplies the
  // correct verdict AND complete data, rather than falsely calling all flips bad.
  for (const base of [empty(), encode(approval()), encode(approval(64))]) for (let i = 0; i < 1376; i++) {
    const b = Buffer.from(base); b[i] ^= 1; addDecode(`record-byte-flip-${vectors.length}`, b);
  }
  for (const version of [0x20400, 0x20500, 0x20600]) for (const page of [12, 14]) for (const cpu of [0x0100000c, 0x01000007]) {
    addBind(`no-slot11-${version}-${page}-${cpu}`, filled({ version, page, cpu }),
      { architecture: cpu === 0x0100000c ? 'arm64' : 'x86_64', want: true });
  }
  for (const count of [1, 64]) addBind(`bound-count-${count}`, filled({}, count), { record: encode(approval(count)), want: true });
  for (const special of [1, 3, 5, 7, 11]) addBind(`helper-special-${special}-without-library-blob`, filled({ special, flags: 0x10000, team: true }), { want: true });
  const cms = filled({ flags: 0x10000, team: true, extra: [[0x10000, component(0xfade0b01, Buffer.from('NOT CMS'))]] });
  addBind('opaque-CMS-not-authenticated', cms, { want: true });
  const withSlot = filled({ special: 11, extra: [[11, component(0xfade8181, Buffer.from('opaque NOT DER'))]] });
  addBind('optional-slot11', withSlot, { want: true });
  withSlot[signatureOffset + withSlot.readUInt32BE(signatureOffset + 24) + 8] ^= 1;
  addBind('optional-slot11-mutation', withSlot);
  const missingSlots = filled({ special: 0, extra: [[11, component(0xfade8181)]] });
  addBind('component-outside-special-table', missingSlots);
  for (const wide of [false, true]) {
    const b = fat(filled({ cpu: 0x01000007 }), filled(), wide);
    addBind(`fat-${wide}-intel`, b, { offset: 4096, architecture: 'x86_64', want: true });
    addBind(`fat-${wide}-arm`, b, { offset: 20480, want: true });
    addBind(`fat-${wide}-wrong-selected-hash`, b, { offset: 20480, hash: syntheticKernelHash(b, 4096) });
    b[4096 + 400] ^= 1; addBind(`fat-${wide}-unselected-page-mutation`, b, { offset: 20480 });
    const different = fat(filled({ cpu: 0x01000007 }, 1), filled(), wide);
    addBind(`fat-${wide}-different-valid-records`, different, { offset: 20480 });
  }
  const valid = filled(), oldHash = syntheticKernelHash(valid);
  const unsigned = thin({ signed: false }); encode(approval()).copy(unsigned, anchorOffset);
  addBind('unsigned-helper-valid-record', unsigned, { hash: oldHash });
  for (const wide of [false, true]) {
    const shadow = fat(filled({ cpu: 0x01000007 }), filled(), wide);
    empty().subarray(0, 32).copy(shadow, 256);
    addBind(`extra-marker-fat-padding-${wide}`, shadow, { offset: 20480 });
  }
  addBind('extra-marker-opaque-CMS', filled({ extra: [[0x10000, component(0xfade0b01, empty().subarray(0, 32))]] }));
  const markerDigest = { ...approval(), asarDigest: empty().subarray(0, 32) }, markerRecord = encode(markerDigest);
  addDecode('marker-digest-valid-record-only', markerRecord, true);
  const duplicateMarker = filled(); markerRecord.copy(duplicateMarker, anchorOffset); rehash(duplicateMarker);
  addBind('marker-digest-not-unique-artifact', duplicateMarker, { record: markerRecord });

  for (const [name, change] of Object.entries(machoChanges)) {
    const b = Buffer.from(valid); change(b); rehash(b);
    addBind(`geometry-${name}`, b);
  }
  for (const [name, change] of Object.entries(cdChanges)) {
    const b = Buffer.from(valid); change(b, cdOffset(b)); addBind(`cd-${name}`, b, { hash: oldHash });
  }
  for (const [name, mutate] of [
    ['maxprot', b => b.writeUInt32LE(8, 160)], ['initprot', b => b.writeUInt32LE(4, 164)],
    ['segment-flags', b => b.writeUInt32LE(0x20, 172)], ['vm-size', b => b.writeBigUInt64LE(1n, 136)],
    ['vm-overflow', b => b.writeBigUInt64LE(2n ** 64n - 1n, 136)], ['vm-unsafe', b => b.writeBigUInt64LE(2n ** 53n, 128)],
    ['anchor-reloff', b => b.writeUInt32LE(1, 232)], ['reserved2', b => b.writeUInt32LE(1, 248)],
    ['reserved3', b => b.writeUInt32LE(1, 252)], ['bad-ASCII-name', b => b[120] = 0xff],
    ['bad-name-padding', b => b[127] = 1],
  ]) { const b = Buffer.from(valid); mutate(b); rehash(b); addBind(name, b); }
  for (const rename of [false, true]) {
    const b = Buffer.from(valid);
    b.copy(b, 416, 176, 256); b.copy(b, 336, 256, 344); b.copy(b, 256, 416, 496); b.fill(0, 416, 496);
    b.writeUInt32LE(232, 108); b.writeUInt32LE(2, 168); b.writeUInt32LE(392, 20);
    if (rename) { b.fill(0, 256, 272); b.write('__alias', 256); }
    rehash(b); addBind(`duplicate-or-alias-section-${rename}`, b);
  }
  const relocated = Buffer.from(valid), target = signatureOffset + 512;
  encode(approval()).copy(relocated, target); relocated.fill(0, anchorOffset, anchorOffset + 1376);
  relocated.writeBigUInt64LE(BigInt(target), 208); relocated.writeUInt32LE(target, 224);
  relocated.writeBigUInt64LE(10240n, 136); relocated.writeBigUInt64LE(10240n, 152);
  rehash(relocated); addBind('relocated-unsigned-anchor', relocated);
  const different = encode(approval(1)); addBind('both-records-valid-but-different', valid, { record: different });
  addBind('empty-mapped', valid, { record: empty() }); addBind('zero-mapped', valid, { record: Buffer.alloc(1376) });
  addBind('mapped-trailing', valid, { record: Buffer.concat([encode(approval()), Buffer.alloc(1)]) });
  addBind('empty-disk', thin());
  for (const where of [24, 400, anchorOffset - 1, anchorOffset, anchorOffset + 64, anchorOffset + 1200, anchorOffset + 1376, signatureOffset - 1,
    signatureOffset, cdOffset(valid) + 12, valid.length - 1]) {
    const b = Buffer.from(valid); b[where] ^= 1; addBind(`signed-mutation-${where}`, b, { hash: oldHash });
  }
  const repaired = Buffer.from(valid); repaired[anchorOffset + 64] ^= 1; rehash(repaired);
  addBind('repaired-pages-old-kernel', repaired, { record: repaired.subarray(anchorOffset, anchorOffset + 1376), hash: oldHash });
  // Positive data-only case intentionally illustrates the provenance caveat:
  // test-generated disk hashes can satisfy bytes, but NEVER authenticate a kernel.
  addBind('disk-derived-hash-is-NOT-kernel-provenance', repaired, { record: repaired.subarray(anchorOffset, anchorOffset + 1376), want: true });
  for (const hash of [Buffer.alloc(0), Buffer.alloc(19), Buffer.alloc(20), Buffer.alloc(21)]) addBind(`bad-kernel-width-or-zero-${hash.length}`, valid, { hash });
  for (const offset of [1, signatureOffset, '18446744073709551615']) addBind(`wrong-offset-${offset}`, valid, { offset, hash: oldHash });
  addBind('wrong-architecture', valid, { architecture: 'x86_64' });
  const lengths = new Set([...Array.from({ length: 361 }, (_, i) => i), anchorOffset, anchorOffset + 31, anchorOffset + 96,
    anchorOffset + 1375, signatureOffset - 1, signatureOffset, valid.length - 1]);
  for (const n of lengths) addBind(`artifact-truncated-${n}`, valid.subarray(0, n), { hash: oldHash });
  let seed = 0x12345678;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 250; i++) {
    const b = Buffer.from(valid); b[next() % b.length] ^= 1 << (next() % 8);
    addBind(`artifact-tamper-${i}`, b, { hash: oldHash });
  }
  return vectors;
}
