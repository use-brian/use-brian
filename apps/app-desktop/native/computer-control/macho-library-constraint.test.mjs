// Source/Node reference tests only. Real Swift execution is the separate
// --foundation-crypto / --foundation-cryptokit runner, never mocked as a pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { machoVectors, oracle } from './macho-library-constraint-vectors.mjs';
import { machoSourceGuards, runMachOTests } from './macho-library-constraint.mjs';

const nativeURL = new URL('../../scripts/fixtures/mac-library-constraint.arm64-macos26.v1.json', import.meta.url);

test('fixed synthetic corpus has independent verdict labels and deterministic bytes', () => {
  const before = readFileSync(nativeURL, 'utf8');
  const vectors = machoVectors();
  assert.equal(vectors.length, 5350);
  assert.equal(vectors.filter(v => v.want).length, 47);
  assert.deepEqual(machoVectors(), vectors);
  const beforeVectors = JSON.stringify(vectors);
  const verdicts = vectors.map(oracle);
  assert.equal(JSON.stringify(vectors), beforeVectors);
  assert.equal(verdicts.filter(v => v.match).length, 47);
  assert.equal(vectors.filter(v => v.name.startsWith('deterministic-signed-byte-tamper-')).length, 500);
  assert(vectors.filter(v => v.name.startsWith('every-truncated-prefix-')).length > 4500);
  assert.equal(readFileSync(nativeURL, 'utf8'), before);
});

test('actual native DER is used unchanged only inside a labeled SYNTHETIC Mach-O', () => {
  const raw = Buffer.from(JSON.parse(readFileSync(nativeURL, 'utf8')).rawLibraryConstraintBase64, 'base64');
  assert.equal(raw.length, 183);
  const vectors = machoVectors();
  const selected = vectors.filter(v => v.compareObservedPolicy);
  assert.equal(selected.length, 3);
  assert(selected[0].name.includes('SYNTHETIC-MachO-not-native-signing-evidence'));
  for (const vector of selected) {
    const result = oracle(vector).match;
    assert.deepEqual(Buffer.from(result.rawBlob, 'base64'), raw);
    for (const flag of ['productionAuthority', 'cmsAuthentication', 'nativeEnforcement', 'loadedImageAuthentication']) assert.equal(result[flag], false);
    assert.equal(result.policyStatus, 'unsupported');
  }
});

test('explicitly narrower main-only/raw-size profile is not falsely reported as JS parity', () => {
  const delta = machoVectors().filter(v => v.want !== v.jsWant);
  assert.deepEqual(delta.map(v => v.name), ['native-main-only-rejects-filetype-6', 'native-main-only-rejects-filetype-8', 'native-policy-size-cap']);
  for (const vector of delta) {
    assert.equal(vector.jsWant, true); assert.equal(vector.want, false);
    assert.deepEqual(oracle(vector), { error: 'ERR_MACHO_LIBRARY_CONSTRAINT_EXTRACTION' });
  }
});

test('kernel expectation never pretends to include file size, subtype or path identity', () => {
  const source = machoSourceGuards();
  assert(source.includes('let offset: Int'));
  assert(source.includes('let size: Int // Derived from this captured buffer/container, NOT the kernel.'));
  assert(source.includes('Caller-supplied DATA, not an attestation object'));
  assert(source.includes('MUST be independently established'));
  assert(source.includes('Never manufacture it from disk'));
  assert(source.includes('kernel.mainCDHash.count == 20'));
  assert(source.includes('kernel.mainCDHash.contains(where: { $0 != 0 })'));
  assert(source.includes('kernel.activeSliceOffset < UInt64(capturedMain.count)'));
  assert(source.includes('$0.offset == offset && $0.architecture == architecture'));
  assert(!source.replace(/\/\/[^\n]*/g, '').includes('Codable'));
});

test('selected slice/hash, full pages/load commands and whole slot blob all matter', () => {
  const vectors = machoVectors();
  for (const name of ['fat-false-other-slice-hash', 'fat-true-other-slice-hash',
    'fat-false-unselected-page-corruption', 'independent-architecture-context-mismatch',
    'whole-blob-not-payload-hash', 'repaired-slot-but-OLD-kernel-hash',
    'repaired-page-table-but-OLD-kernel-hash', 'unrebound-header-substitution',
    'component-overlap-inside-CD', 'duplicate-CodeDirectory-index',
    'duplicate-segment-name', 'hidden-signature-padding', 'zero-kernel-hash']) {
    const v = vectors.find(v => v.name === name); assert(v, name);
    assert.equal(v.want, false); assert.equal(v.jsWant, false); assert(oracle(v).error);
  }
  for (const page of [12, 14]) {
    const valid = vectors.find(v => v.name === `multi-page-${page}`);
    assert(oracle(valid).match);
    const corrupt = vectors.filter(v => v.name.startsWith(`multi-page-${page}-corrupt-`));
    assert.equal(corrupt.length, 4); for (const v of corrupt) assert(oracle(v).error);
  }
});

test('opaque CMS and external resource hashes are deliberately NOT signer/seal verification', () => {
  for (const name of ['opaque-CMS-is-NOT-authenticated', 'changed-CMS-still-NOT-authenticated', 'external-resource-and-plist-slots-NOT-verified']) {
    const vector = machoVectors().find(v => v.name === name), result = oracle(vector).match;
    assert.equal(result.cmsAuthentication, false); assert.equal(result.productionAuthority, false);
    assert.equal(result.nativeEnforcement, false); assert.equal(result.loadedImageAuthentication, false);
  }
  const source = readFileSync(new URL('./MachOLibraryConstraint.swift', import.meta.url), 'utf8');
  assert(source.includes('External Info.plist/resources slots 1/3'));
  assert(source.includes('ONLY the selected CD'));
  assert(source.includes('unsigned fat table/padding is not'));
  assert(source.includes('not a full dyld/VM/section/linkedit semantics parser'));
});

test('production SHA256 is unconditional CryptoKit; only temporary Linux test import changes', () => {
  const source = machoSourceGuards();
  assert.match(source, /^import Foundation\nimport CryptoKit\n/);
  assert(!source.includes('import Crypto\n'));
  assert(!source.includes('canImport') && !source.includes('#if'));
  const runner = readFileSync(new URL('./macho-library-constraint.mjs', import.meta.url), 'utf8');
  assert(runner.includes("source.replace(/^import Crypto$/m, 'import CryptoKit'), original"));
  assert(runner.includes("'-swift-version', '5'"));
  const harness = readFileSync(new URL('./MachOLibraryConstraintTests.swift', import.meta.url), 'utf8');
  assert(harness.includes('SHA256.hash(data: Data())'));
  assert(harness.includes('SHA256.hash(data: Data("abc".utf8))'));
  assert(harness.includes('LibraryConstraintPolicy.compare(rawGenericBlob: result.rawBlob'));
  assert(harness.includes('snapshot.rawBlob == first.rawBlob'));
  assert(harness.includes('catch let error as MachOLibraryConstraint.Failure'));
});

test('portable mode reports no Swift execution and requires an explicit valid mode', () => {
  assert.deepEqual(runMachOTests('--portable'), { vectors: 5350, matches: 47, narrowerNativeRejections: 3, swiftExecuted: false });
  for (const mode of [undefined, '', '--native', '--fake-crypto']) assert.throws(() => runMachOTests(mode));
});
