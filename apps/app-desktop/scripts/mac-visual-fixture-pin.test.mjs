import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emptyVisualFixtureRecord as empty, encodeVisualFixtureRecord as encode,
  decodeVisualFixtureRecord as decode, stampNativeApprovalRecords as stamp,
  verifyVisualFixturePinCoverage as verify, verifyBootstrapApprovalCoverage,
  validateUnstampedVisualFixturePin, nativeApprovalArchitectures } from './mac-bootstrap-anchor.mjs';
import { extractVisualFixtureCodeData } from './mac-bootstrap-inventory.mjs';
import { thin, fat, rehash, fatRehash, approval } from './mac-bootstrap-anchor.test-fixtures.mjs';
const hashes = [Buffer.alloc(20, 1), Buffer.alloc(20, 2)];
const pinOffset = 0x2400;
function helper(options = {}) {
  const b = thin(options), signed = options.signed !== false;
  b.copy(b, 336, 256, signed ? 344 : 328);
  b.fill(0, 256, 336);
  b.writeUInt32LE(b.readUInt32LE(20) + 80, 20);
  b.writeUInt32LE(232, 108); b.writeUInt32LE(2, 168);
  b.write('__br_visual', 256); b.write('__DATA_CONST', 272);
  b.writeBigUInt64LE(BigInt(pinOffset), 288); b.writeBigUInt64LE(80n, 296);
  b.writeUInt32LE(pinOffset, 304); b.writeUInt32LE(4, 308); b.writeUInt32LE(0x10000000, 320);
  empty().copy(b, pinOffset); return signed ? rehash(b) : b;
}
test('visual ABI default empty, exact canonical hashes, malformed/duplicates refuse', () => {
  assert.deepEqual(decode(empty(), true), []); assert.throws(() => decode(empty()));
  for (const count of [1, 2]) assert.deepEqual(decode(encode(hashes.slice(0, count))), hashes.slice(0, count));
  for (const bad of [[], [hashes[0], hashes[0]], [...hashes].reverse(), [Buffer.alloc(20)], [...hashes, hashes[0]]]) assert.throws(() => encode(bad));
  for (const at of [...Array(34).keys(), 35, 36, 37, 38, 39, 60, 79]) {
    const b = encode(hashes.slice(0, 1)); b[at] ^= 1; assert.throws(() => decode(b));
  }
});
for (const signed of [false, true]) test(`stamp both original helper records together, linker=${signed}`, () => {
  const original = helper({ signed }); validateUnstampedVisualFixturePin(original);
  const stamped = stamp(original, approval(), hashes);
  assert.deepEqual(original.subarray(pinOffset, pinOffset + 80), empty());
  assert.deepEqual(stamped.subarray(pinOffset, pinOffset + 80), encode(hashes));
  assert.throws(() => stamp(stamped, approval(), hashes));
  if (signed) {
    assert.throws(() => verify(stamped, hashes)); rehash(stamped);
    assert.equal(verify(stamped, hashes).slices, 1); verifyBootstrapApprovalCoverage(stamped, approval());
    assert.throws(() => verify(stamped, [Buffer.alloc(20, 3)]));
    stamped[pinOffset + 40] ^= 1; assert.throws(() => verify(stamped, hashes));
  }
});
test('a sealed but empty visual pin is never final approval', () => {
  const b = helper();
  validateUnstampedVisualFixturePin(b);
  assert.deepEqual(nativeApprovalArchitectures(b), ['arm64']);
  assert.throws(() => verify(b, hashes));
  assert.throws(() => verify(b, []));
});
test('signed, malformed, populated, missing or duplicate pin records refuse', () => {
  assert.throws(() => stamp(helper({ flags: 0x10000, team: true }), approval(), hashes));
  assert.throws(() => stamp(thin(), approval(), hashes));
  for (const mutate of [b => { b[pinOffset + 34] = 3; }, b => encode(hashes).copy(b, pinOffset),
    b => empty().copy(b, 0x2600), b => b.writeUInt32LE(3, 308)]) {
    const b = helper(); mutate(b); rehash(b); assert.throws(() => stamp(b, approval(), hashes));
  }
});
for (const wide of [false, true]) test(`every helper slice requires matching covered pins, fat64=${wide}`, () => {
  const b = fat(helper({ cpu: 0x01000007 }), helper(), wide);
  assert.deepEqual(nativeApprovalArchitectures(b), ['arm64', 'x86_64']);
  const stamped = fatRehash(stamp(b, approval(), hashes));
  assert.equal(verify(stamped, hashes).slices, 2); verifyBootstrapApprovalCoverage(stamped, approval());
  stamped[20480 + pinOffset + 40] ^= 1; fatRehash(stamped); assert.throws(() => verify(stamped, hashes));
  const bad = fat(helper({ cpu: 0x01000007 }), helper({ flags: 0x10000 }));
  assert.throws(() => stamp(bad, approval(), hashes));
});
test('fixture executable extraction covers all intended slices, refuses changed pages/architecture', () => {
  const b = fat(thin({ cpu: 0x01000007 }), thin());
  const records = extractVisualFixtureCodeData(b, ['arm64', 'x86_64'], Buffer.alloc(0), Buffer.alloc(0));
  assert.equal(records.length, 2); assert.notEqual(records[0].cdHash, records[1].cdHash);
  assert.throws(() => extractVisualFixtureCodeData(b, ['arm64'], Buffer.alloc(0), Buffer.alloc(0)));
  b[4096 + 0x1000] ^= 1;
  assert.throws(() => extractVisualFixtureCodeData(b, ['arm64', 'x86_64'], Buffer.alloc(0), Buffer.alloc(0)));
});
test('release source fixes fixture identity/signer, captures before first sign, pins before final helper/outer sign and rechecks', () => {
  const signer = readFileSync(new URL('./sign-mac-app.mjs', import.meta.url), 'utf8');
  const release = readFileSync(new URL('./mac-release-bootstrap.mjs', import.meta.url), 'utf8');
  assert.ok(signer.indexOf('captureUnstampedHelper(options.app)') < signer.indexOf('await signAsync(selected)'));
  assert.ok(signer.indexOf('await signAsync(selected)') < signer.indexOf('await sealNativeBootstrap'));
  assert.match(signer, /if \(!fixtureVisited\) throw/);
  assert.match(release, /certificate leaf = H"\$\{identity\}"/);
  assert.match(release, /identifier "com.usebrian.NativeComputerFixture"/);
  assert.match(release, /'--verify', '--strict', '--all-architectures'/);
  const seal = release.slice(release.indexOf('export async function sealNativeBootstrap'));
  assert.ok(seal.indexOf('verifiedFixture(') < seal.indexOf('stampNativeApprovalRecords('));
  assert.ok(seal.indexOf('stampNativeApprovalRecords(') < seal.indexOf("command([...base, '--entitlements'"));
  assert.ok(seal.indexOf("command([...base, '--entitlements'") < seal.indexOf("'--library-constraint', constraint, app"));
  assert.ok(seal.indexOf("'--library-constraint', constraint, app") < seal.indexOf('const finalFixture = verifiedFixture'));
  assert.match(seal, /JSON.stringify\(finalFixture.records\) !== JSON.stringify\(fixture.records\)/);
});
test('production C mapped pin copy matches canonical validator, zero output on every refusal',
  { skip: process.platform !== 'linux' || !existsSync('/bin/cc') }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'visual-pin-c-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = readFileSync(new URL('../native/computer-control/BootstrapApprovalAnchor.c', import.meta.url), 'utf8');
    const injected = source.replace(/#if !defined\(__APPLE__\) \|\| !defined\(__MACH__\)\n#error[^\n]*\n#endif/, '')
      .replace(/__attribute__\(\(used, aligned\(16\), section\("__DATA_CONST,__br_(?:bootstrap|visual),regular,no_dead_strip"\)\)\)/g, '')
      .replace('static const volatile uint8_t brian_visual_fixture_pin', 'static volatile uint8_t brian_visual_fixture_pin');
    const harness = `\n#include <stdio.h>\nint main(void) {
      uint8_t input[80], out[40];
      memset(out, 1, 40);
      if (brian_visual_fixture_hashes_copy(out, 40) || !zero(out, 40)) return 1;
      if (brian_visual_fixture_hashes_copy(NULL, 40)) return 2;
      memset(out, 1, 40);
      if (brian_visual_fixture_hashes_copy(out, 39) || out[0] != 1) return 3;
      while (fread(input, 1, 80, stdin) == 80) {
        for (size_t i = 0; i < 80; ++i) brian_visual_fixture_pin[i] = input[i];
        memset(out, 0xff, 40); int count = brian_visual_fixture_hashes_copy(out, 40);
        if (count ? (memcmp(out, input + 40, count * 20) || !zero(out + count * 20, 40 - count * 20)) : !zero(out, 40)) return 4;
        printf("%d\\n", count);
      } return 0;
    }`;
    const path = join(dir, 'test.c'), executable = join(dir, 'test'); writeFileSync(path, injected + harness);
    const result = spawnSync('/bin/cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-I',
      fileURLToPath(new URL('../native/computer-control/', import.meta.url)), path, '-o', executable], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const vectors = [empty(), encode(hashes), encode(hashes.slice(0, 1))];
    for (const base of [...vectors]) for (let i = 0; i < 80; i++) {
      const b = Buffer.from(base); b[i] ^= 1; vectors.push(b);
    }
    const duplicate = encode(hashes); hashes[0].copy(duplicate, 60); vectors.push(duplicate);
    const expected = vectors.map(b => { try { return decode(b).length; } catch { return 0; } });
    const run = spawnSync(executable, [], { input: Buffer.concat(vectors), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr); assert.deepEqual(run.stdout.trim().split('\n').map(Number), expected);
  });
