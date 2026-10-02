import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bootstrapAnchorSize, bootstrapElectronVersion, emptyBootstrapApprovalRecord as empty,
  encodeBootstrapApprovalRecord as encode, decodeBootstrapApprovalRecord as decode,
  readBootstrapApproval as read, stampBootstrapApproval as stamp, verifyBootstrapApprovalCoverage as verify } from './mac-bootstrap-anchor.mjs';
import { approval, thin, fat, rehash, fatRehash, component, cdOffset, anchorOffset, signatureOffset } from './mac-bootstrap-anchor.test-fixtures.mjs';
const reject = fn => assert.throws(fn, { code: 'ERR_MAC_BOOTSTRAP_ANCHOR', message: 'Bootstrap anchor: unsupported, malformed, unsealed, or mismatched data' });
const sourceURL = new URL('../native/computer-control/BootstrapApprovalAnchor.c', import.meta.url);
const headerURL = new URL('../native/computer-control/BootstrapApprovalAnchor.h', import.meta.url);

test('canonical binary record, empty refuses, no circular main/team/path fields', () => {
  const pristine = empty(); assert.equal(pristine.length, bootstrapAnchorSize); assert.equal(pristine[34], 0);
  reject(() => decode(pristine));
  for (const count of [1, 2, 63, 64]) {
    const data = approval(count), encoded = encode(data), result = decode(encoded);
    assert.equal(encoded.length, 1376); assert.equal(encoded.readUInt32BE(40), 96 + count * 20);
    assert.equal(result.electronVersion, '43.2.0'); assert.equal(result.productionAuthority, false);
    assert.deepEqual(result.asarDigest, data.asarDigest); assert.deepEqual(result.libraryCDHashes, data.libraryCDHashes);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.libraryCDHashes));
    result.asarDigest.fill(0); result.libraryCDHashes[0].fill(0);
    assert.deepEqual(decode(encoded).asarDigest, data.asarDigest);
    assert.deepEqual(decode(encoded).libraryCDHashes, data.libraryCDHashes);
  }
  assert.equal(bootstrapElectronVersion, '43.2.0');
});
test('record schema rejects wrong Electron, zero/empty/excess/duplicate/unsorted inventory', () => {
  for (const data of [approval(0), approval(65), { ...approval(), electronVersion: '43.3.0' },
    { ...approval(), asarDigest: Buffer.alloc(32) }, { ...approval(), asarDigest: Buffer.alloc(31) },
    { ...approval(), libraryCDHashes: [Buffer.alloc(20)] }, { ...approval(), libraryCDHashes: [Buffer.alloc(19, 1)] },
    { ...approval(), libraryCDHashes: [Buffer.alloc(21, 1)] },
    { ...approval(), libraryCDHashes: [Buffer.alloc(20, 1), Buffer.alloc(20, 1)] },
    { ...approval(), libraryCDHashes: approval().libraryCDHashes.reverse() },
    { ...approval(), mainCDHash: Buffer.alloc(20) }, { ...approval(), team: 'ZZZZZZZZZZ' },
  ]) reject(() => encode(data));
});
const recordChanges = {
  marker: b => b[0] ^= 1, version: b => b[33] = 2, used: b => b[34] = 2,
  reserved: b => b[35] = 1, size: b => b.writeUInt32BE(1375, 36), length: b => b.writeUInt32BE(96, 40),
  zeroCount: b => b.writeUInt16BE(0, 44), excessiveCount: b => b.writeUInt16BE(65, 44),
  hashWidth: b => b[46] = 32, digestWidth: b => b[47] = 20, electron: b => b[48] = 0x35,
  electronNul: b => b[54] = 1, reserved2: b => b[56] = 1, zeroDigest: b => b.fill(0, 64, 96),
  zeroHash: b => b.fill(0, 96, 116), duplicate: b => b.copy(b, 116, 96, 116),
  unsorted: b => b[96] = 0xff, padding: b => b[1375] = 1,
};
for (const [name, mutate] of Object.entries(recordChanges)) test(`malformed record: ${name}`, () => {
  const b = encode(approval()); mutate(b); reject(() => decode(b));
});
test('empty must be EXACT pristine bytes, and every truncation rejects', () => {
  for (let i = 0; i < bootstrapAnchorSize; i++) {
    const b = empty(); b[i] ^= 1;
    const artifact = thin({ signed: false }); b.copy(artifact, anchorOffset);
    reject(() => stamp(artifact, approval()));
  }
  const b = encode(approval());
  for (let n = 0; n < b.length; n++) reject(() => decode(b.subarray(0, n)));
  reject(() => decode(Buffer.concat([b, Buffer.alloc(1)])));
});
test('input hooks/proxies/shared stores cannot bypass byte/array bounds or run', () => {
  let calls = 0; const hook = () => { calls++; throw new Error('private error'); };
  const proxied = new Proxy(approval(), { get: hook, ownKeys: hook, getPrototypeOf: hook }); reject(() => encode(proxied));
  const getter = approval(); Object.defineProperty(getter, 'asarDigest', { get: hook }); reject(() => encode(getter));
  const arrayGetter = approval(); Object.defineProperty(arrayGetter.libraryCDHashes, '0', { get: hook }); reject(() => encode(arrayGetter));
  const b = encode(approval()); for (const key of ['length', 'buffer', 'valueOf', Symbol.iterator]) Object.defineProperty(b, key, { get: hook });
  assert.equal(decode(b).libraryCDHashes.length, 2);
  const shared = Buffer.from(new SharedArrayBuffer(1376)); encode(approval()).copy(shared);
  Object.defineProperty(shared, 'buffer', { get: hook }); reject(() => decode(shared));
  const fake = new Uint16Array(1376); Object.setPrototypeOf(fake, Buffer.prototype); reject(() => decode(fake));
  assert.equal(calls, 0);
});
for (const signed of [false, true]) test(`stamp ${signed ? 'validated linker-only' : 'unsigned'} artifact, no input mutation`, () => {
  const b = thin({ signed }), before = Buffer.from(b); reject(() => read(b));
  const stamped = stamp(b, approval()); assert.deepEqual(b, before);
  assert.deepEqual(read(stamped).libraryCDHashes, approval().libraryCDHashes);
  reject(() => stamp(stamped, approval())); // no restamping, even same data
  reject(() => verify(stamped, approval())); // unsigned or stale linker pages
  if (signed) {
    rehash(stamped); const snapshot = Buffer.from(stamped), result = verify(stamped, approval());
    assert.equal(result.pageHashCoverage, true); assert.equal(result.signatureAuthentication, false);
    assert.equal(result.productionAuthority, false); assert.deepEqual(stamped, snapshot);
  }
});
for (const version of [0x20400, 0x20500, 0x20600]) for (const page of [12, 14]) test(`supported SHA256 CD ${version}/${page}`, () => {
  const b = stamp(thin({ version, page }), approval(64)); rehash(b);
  assert.equal(verify(b, approval(64)).slices, 1);
});
test('final runtime/CMS-bearing profile: readonly coverage only; never patch', () => {
  const b = thin({ flags: 0x10000, version: 0x20500, team: true, special: 11,
    extra: [[2, component(0xfade0c01, Buffer.alloc(4))], [11, component(0xfade8181, Buffer.from('synthetic NOT DER'))],
      [0x10000, component(0xfade0b01, Buffer.from('synthetic NOT CMS'))]] });
  reject(() => stamp(b, approval()));
  encode(approval()).copy(b, anchorOffset); rehash(b);
  const before = Buffer.from(b); assert.equal(verify(b, approval()).pageHashCoverage, true); assert.deepEqual(b, before);
  const other = approval(); other.asarDigest[0] ^= 1; reject(() => verify(b, other));
  const fewer = approval(1); reject(() => verify(b, fewer));
});
for (const options of [{ flags: 2 }, { flags: 0x10002 }, { flags: 0 }, { flags: 0x10000 },
  { flags: 0x30002 }, { team: true }, { special: 1 }, { extra: [[0x10000, component(0xfade0b01)]] },
  { extra: [[0x10000, component(0xfade0b01, Buffer.alloc(1))]] }]) {
  test(`patch refuses non-linker-unsealed profile ${JSON.stringify(options, (key, value) => key === 'data' ? '[omitted]' : value)}`, () => {
    const b = thin(options), before = Buffer.from(b); reject(() => stamp(b, approval())); assert.deepEqual(b, before);
  });
}
for (const wide of [false, true]) test(`fat${wide ? 64 : 32}: all slices stamped/covered, identical inventory`, () => {
  const original = fat(undefined, undefined, wide), before = Buffer.from(original);
  const b = stamp(original, approval()); assert.deepEqual(original, before); reject(() => verify(b, approval()));
  fatRehash(b); assert.equal(verify(b, approval()).slices, 2);
  b[20480 + anchorOffset + 64] ^= 1; fatRehash(b);
  reject(() => read(b)); reject(() => verify(b, approval()));
  for (const badFirst of [false, true]) {
    const intel = thin({ cpu: 0x01000007, flags: badFirst ? 2 : 0x20002 }), arm = thin({ flags: badFirst ? 0x20002 : 2 });
    const mixed = fat(intel, arm, wide), snapshot = Buffer.from(mixed); reject(() => stamp(mixed, approval())); assert.deepEqual(mixed, snapshot);
  }
});
test('header, anchor crossing two pages, and ALL other code pages are covered', () => {
  const b = rehash(stamp(thin(), approval()));
  for (const at of [24, 400, anchorOffset - 1, anchorOffset, anchorOffset + 64, anchorOffset + 1200, anchorOffset + 1376, signatureOffset - 1]) {
    const changed = Buffer.from(b); changed[at] ^= 1; reject(() => verify(changed, approval()));
  }
  const invalidLinker = thin(); invalidLinker[400] ^= 1; reject(() => stamp(invalidLinker, approval()));
});
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
for (const [name, mutate] of Object.entries(machoChanges)) test(`Mach-O fails closed: ${name}`, () => {
  const b = thin(); mutate(b); rehash(b); reject(() => stamp(b, approval()));
});
test('overlapping/duplicate anchor sections and non-anchor aliases reject', () => {
  for (const rename of [false, true]) {
    const b = thin(); b.copy(b, 416, 176, 256); b.copy(b, 336, 256, 344); b.copy(b, 256, 416, 496); b.fill(0, 416, 496);
    b.writeUInt32LE(232, 108); b.writeUInt32LE(2, 168); b.writeUInt32LE(392, 20);
    if (rename) { b.fill(0, 256, 272); b.write('__alias', 256); }
    rehash(b); reject(() => stamp(b, approval()));
  }
});
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
for (const [name, mutate] of Object.entries(cdChanges)) test(`CodeDirectory fails closed: ${name}`, () => {
  const b = thin(); mutate(b, cdOffset(b)); reject(() => stamp(b, approval()));
  encode(approval()).copy(b, anchorOffset); reject(() => verify(b, approval()));
});
test('SuperBlob duplicate/alternate/unknown/overlap/padding/length/profile cases reject', () => {
  for (const change of [
    b => b.writeUInt32BE(0x1000, signatureOffset + 12), b => b.writeUInt32BE(99, signatureOffset + 12),
    b => b.writeUInt32BE(0xffffffff, signatureOffset + 16), b => b.writeUInt32BE(12, signatureOffset + 16),
    b => b.writeUInt32BE(0xffffffff, signatureOffset + 4), b => b.writeUInt32BE(1, signatureOffset + 4),
    b => b.writeUInt32BE(65, signatureOffset + 8), b => b.writeUInt32BE(0xfade0cc1, signatureOffset),
    b => b[b.length - 1] = 1,
  ]) { const b = thin(); change(b); reject(() => stamp(b, approval())); }
  for (const [version, field] of [[0x20500, 92], [0x20600, 96], [0x20600, 100], [0x20600, 104]]) {
    const b = thin({ version }); b[cdOffset(b) + field] = 1; reject(() => stamp(b, approval()));
  }
  const duplicate = thin({ extra: [[0, component(0xfade0c02, Buffer.alloc(100))]] }); reject(() => stamp(duplicate, approval()));
  const overlapping = thin({ extra: [[0x10000, component(0xfade0b01)]] });
  overlapping.writeUInt32BE(overlapping.readUInt32BE(signatureOffset + 16), signatureOffset + 24); reject(() => stamp(overlapping, approval()));
});
test('fat truncation, overlapping/duplicate/unknown arches and header mismatch reject', () => {
  for (const wide of [false, true]) {
    const stride = wide ? 32 : 20;
    for (const mutate of [
      b => b.writeUInt32BE(3, 4), b => b.writeUInt32BE(7, 8),
      b => b.writeUInt32BE(0x01000007, 8 + stride), b => b.writeUInt32BE(31, 8 + (wide ? 24 : 16)),
      b => wide ? b.writeBigUInt64BE(4096n, 16 + stride) : b.writeUInt32BE(4096, 16 + stride),
      b => wide ? b.writeBigUInt64BE(2n ** 63n, 16) : b.writeUInt32BE(0xffffffff, 16),
      b => b.writeUInt32LE(0x0100000c, 4096 + 4),
    ]) { const b = fat(undefined, undefined, wide); mutate(b); reject(() => stamp(b, approval())); }
    if (wide) { const b = fat(undefined, undefined, true); b.writeUInt32BE(1, 36); reject(() => stamp(b, approval())); }
    for (const length of [32, 48, 71, 4096, 4096 + 16, 20480, 20480 + 16]) reject(() => stamp(fat(undefined, undefined, wide).subarray(0, length), approval()));
  }
});
test('every truncated thin artifact and deterministic malformed mutations give scoped errors', () => {
  const original = thin();
  for (let i = 0; i < original.length; i++) reject(() => stamp(original.subarray(0, i), approval()));
  let seed = 0x12abcdef;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 500; i++) {
    const b = Buffer.from(original); b[next() % b.length] ^= 1 << (next() % 8);
    reject(() => stamp(b, approval()));
  }
});
test('C owns volatile constant section; no path/env/signer/parent override or production non-Darwin fallback', () => {
  const source = readFileSync(sourceURL, 'utf8'), header = readFileSync(headerURL, 'utf8');
  assert.match(source, /static const volatile uint8_t brian_bootstrap_anchor/);
  assert.match(source, /section\("__DATA_CONST,__br_bootstrap,regular,no_dead_strip"\)/);
  assert.match(source, /output\[i\] = brian_bootstrap_anchor\[i\]/);
  assert.match(source, /#if !defined\(__APPLE__\) \|\| !defined\(__MACH__\)/);
  assert.match(source, /#error "BootstrapApprovalAnchor requires Darwin/);
  assert.ok('__br_bootstrap'.length <= 16);
  assert.doesNotMatch(source + header, /\b(getenv|setenv|fopen|open|dlopen|system|execve|posix_spawn)\s*\(/);
  assert.doesNotMatch(source, /#if.*TEST/);
  assert.match(header, /DATA ONLY/); assert.match(header, /BEFORE final helper signing/);
});

test('portable injected C translation unit agrees with JS canonical validation (NOT Darwin section/link proof)',
  { skip: process.platform !== 'linux' || !existsSync('/bin/cc') }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-anchor-c-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = readFileSync(sourceURL, 'utf8');
    const include = fileURLToPath(new URL('../native/computer-control/', import.meta.url));
    // Prove the actual production source refuses non-Darwin. No platform defines.
    const refused = spawnSync('/bin/cc', ['-std=c11', '-c', fileURLToPath(sourceURL), '-o', join(dir, 'refused.o')], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /requires Darwin/);
    // Test-only replacement is in a NEW temporary TU; production bytes unchanged.
    const injected = source.replace(/#if !defined\(__APPLE__\) \|\| !defined\(__MACH__\)\n#error[^\n]*\n#endif/, '')
      .replace(/__attribute__\(\(used, aligned\(16\), section\("__DATA_CONST,__br_bootstrap,regular,no_dead_strip"\)\)\)/, '')
      .replace('static const volatile uint8_t brian_bootstrap_anchor', 'static volatile uint8_t brian_bootstrap_anchor');
    const harness = `\n#include <stdio.h>\nint main(void) {
      uint8_t input[1376], out[1376]; size_t written = 9;
      if (brian_bootstrap_approval_copy(out, sizeof(out), &written) != BRIAN_BOOTSTRAP_ANCHOR_EMPTY || written || !zero(out, sizeof(out))) return 2;
      memset(out, 1, sizeof(out));
      if (brian_bootstrap_approval_copy(out, sizeof(out), NULL) != BRIAN_BOOTSTRAP_ANCHOR_INVALID_ARGUMENT || !zero(out, sizeof(out))) return 3;
      if (brian_bootstrap_approval_copy(NULL, sizeof(out), &written) != BRIAN_BOOTSTRAP_ANCHOR_INVALID_ARGUMENT || written) return 4;
      if (brian_bootstrap_approval_copy(out, 1375, &written) != BRIAN_BOOTSTRAP_ANCHOR_INVALID_ARGUMENT || written) return 5;
      while (fread(input, 1, sizeof(input), stdin) == sizeof(input)) {
        for (size_t i = 0; i < sizeof(input); ++i) brian_bootstrap_anchor[i] = input[i];
        memset(out, 0xff, sizeof(out)); written = 9;
        int result = brian_bootstrap_approval_copy(out, sizeof(out), &written);
        int intact = result == 1 ? memcmp(input, out, sizeof(out)) == 0 : zero(out, sizeof(out));
        if (!intact || written != (result == 1 ? 1376u : 0u)) return 6;
        printf("%d\\n", result);
      }
      return ferror(stdin) ? 7 : 0;
    }\n`;
    const path = join(dir, 'injected.c'), executable = join(dir, 'injected-test');
    writeFileSync(path, injected + harness, { mode: 0o600 });
    const built = spawnSync('/bin/cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-I', include, path, '-o', executable], { encoding: 'utf8', timeout: 20000, maxBuffer: 65536 });
    assert.equal(built.status, 0, 'injected portable test compilation failed');
    const vectors = [empty(), encode(approval(1)), encode(approval()), encode(approval(64))];
    for (const base of [empty(), encode(approval()), encode(approval(64))]) {
      for (let i = 0; i < 1376; i++) { const b = Buffer.from(base); b[i] ^= 1; vectors.push(b); }
    }
    const expected = vectors.map(b => { try { decode(b); return 1; } catch { return b.equals(empty()) ? 11 : 12; } });
    const result = spawnSync(executable, [], { input: Buffer.concat(vectors), encoding: 'utf8', timeout: 20000, maxBuffer: 65536 });
    assert.equal(result.status, 0, 'injected portable C copy/clear test failed');
    assert.deepEqual(result.stdout.trim().split('\n').map(Number), expected);
    assert.ok(readFileSync(sourceURL, 'utf8') === source);
  });

test('CMS presence rejects stamping on either fat slice even with forged linker-only flags', () => {
  for (const wide of [false, true]) for (const cmsFirst of [false, true]) {
    for (const payload of [Buffer.alloc(0), Buffer.from('synthetic non-CMS bytes')]) {
      const extra = [[0x10000, component(0xfade0b01, payload)]];
      const intel = thin({ cpu: 0x01000007, extra: cmsFirst ? extra : [] });
      const arm = thin({ extra: cmsFirst ? [] : extra });
      const b = fat(intel, arm, wide), before = Buffer.from(b);
      reject(() => stamp(b, approval()));
      assert.deepEqual(b, before);
    }
  }
});
test('certificate-signature-shaped artifacts are never patched on either architecture (synthetic, NOT Developer ID evidence)', () => {
  for (const cpu of [0x01000007, 0x0100000c]) {
    const b = thin({ cpu, flags: 0x10000, team: true,
      extra: [[0x10000, component(0xfade0b01, Buffer.from('NOT a real certificate/signature'))]] });
    const before = Buffer.from(b); reject(() => stamp(b, approval())); assert.deepEqual(b, before);
  }
});
test('coverage deliberately cannot authenticate CMS or its mutation; result never grants authority', () => {
  const b = thin({ flags: 0x10000, team: true,
    extra: [[0x10000, component(0xfade0b01, Buffer.from('opaque synthetic bytes'))]] });
  encode(approval()).copy(b, anchorOffset); rehash(b);
  const first = verify(b, approval());
  assert.deepEqual(first, { kind: 'static-bootstrap-anchor-coverage', slices: 1,
    pageHashCoverage: true, signatureAuthentication: false, productionAuthority: false });
  assert.ok(Object.isFrozen(first));
  // CMS is outside the code pages and not a CD special slot. No attempt to
  // decode or authenticate it belongs to this static coverage-only API.
  const cmsOffset = signatureOffset + b.readUInt32BE(signatureOffset + 24);
  b[cmsOffset + 8] ^= 1;
  const before = Buffer.from(b), second = verify(b, approval());
  assert.deepEqual(second, first); assert.deepEqual(b, before);
  reject(() => stamp(b, approval()));
});
