// Node/source checks, explicitly not Swift execution or native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapVectors } from './bootstrap-approval-swift-vectors.mjs';
import { bootstrapSourceGuards, runBootstrapTests } from './bootstrap-approval-swift.mjs';
import { runMachOTests } from './macho-library-constraint.mjs';

const vectors = bootstrapVectors();
test('independent JS record/geometry/coverage oracle has deterministic scoped verdicts', () => {
  assert.equal(vectors.length, 6298);
  assert.equal(vectors.filter(v => v.expected.match).length, 142);
  assert.equal(vectors.filter(v => v.mode === 'bind').length, 768);
  assert.equal(vectors.filter(v => v.mode === 'bind' && v.expected.match).length, 33);
  assert.deepEqual(bootstrapVectors(), vectors);
  assert.equal(vectors.filter(v => v.name.startsWith('record-truncated-')).length, 1376);
  assert.equal(vectors.filter(v => v.name.startsWith('record-byte-flip-')).length, 4128);
  for (const v of vectors) if (v.expected.error) assert.equal(v.expected.error, 'ERR_SWIFT_BOOTSTRAP_APPROVAL');
});
test('library corpus is unchanged; generic verifier does not relax its slot-11 requirement', () => {
  assert.deepEqual(runMachOTests('--portable'), { vectors: 5350, matches: 47, narrowerNativeRejections: 3, swiftExecuted: false });
  const { macho } = bootstrapSourceGuards();
  assert(macho.includes('guard special == 11'));
  assert(macho.includes('constraint.size <= Limits.constraintBytes'));
  assert(macho.includes('special <= 11'));
  assert.equal(vectors.filter(v => v.name.startsWith('no-slot11-') && v.expected.match).length, 12);
});
test('kernel and mapped-record provenance is deliberately not inferred from supplied bytes', () => {
  const v = vectors.find(v => v.name === 'disk-derived-hash-is-NOT-kernel-provenance');
  assert(v.expected.match);
  for (const value of vectors.filter(v => v.expected.match).map(v => v.expected.match)) {
    for (const flag of ['productionAuthority', 'cmsAuthentication', 'staticSignerAuthentication', 'kernelProvenanceAuthentication',
      'mappedRecordProvenanceAuthentication', 'nativeEnforcement', 'loadedImageAuthentication']) assert.equal(value[flag], false);
  }
  const { source } = bootstrapSourceGuards();
  assert(source.includes('never the parent pipe or a disk read'));
  assert(source.includes('signature/signer, flags/entitlements, generation and race checks'));
  assert(!/^import .*Anchor/m.test(source));
});
test('valid-but-different records, unsigned relocation, aliasing, full page and kernel mutations refuse', () => {
  for (const name of ['both-records-valid-but-different', 'relocated-unsigned-anchor',
    'duplicate-or-alias-section-false', 'duplicate-or-alias-section-true',
    'empty-mapped', 'zero-mapped', 'empty-disk', 'repaired-pages-old-kernel',
    'unsigned-helper-valid-record', 'extra-marker-fat-padding-true', 'extra-marker-opaque-CMS', 'marker-digest-not-unique-artifact',
    'geometry-missingReadonly', 'geometry-executeProtection', 'geometry-sectionUnexpectedAttribute',
    'geometry-noHeaderMap', 'geometry-extraMarker', 'fat-true-different-valid-records',
    'fat-false-unselected-page-mutation', 'optional-slot11-mutation', 'component-outside-special-table']) {
    const vector = vectors.find(v => v.name === name); assert(vector, name); assert(vector.expected.error, name);
  }
  assert.equal(vectors.filter(v => v.name.startsWith('artifact-tamper-') && v.expected.error).length, 250);
});
test('no second plaintext marker constant or runtime fallback in production Swift source', () => {
  const { source, macho } = bootstrapSourceGuards();
  assert(source.includes('@inline(never) private static func encodeMarkerByte'));
  assert(!source.includes('static let marker:'));
  assert(!source.includes('BRIAN_BOOTSTRAP_ANCHOR_V1'));
  assert(macho.includes('BootstrapApproval.matchesMarker(bytes, at: at)'));
  assert(!/\bvar\s+.*override/i.test(source));
  // Actual optimized/unoptimized binary scanning is done ONLY by the Foundation
  // runner; this source guard does not pretend to establish linker behavior.
});
test('portable mode cannot silently claim real Swift or compiler-marker acceptance', () => {
  assert.deepEqual(runBootstrapTests('--portable'), { vectors: 6298, matches: 142,
    bindingVectors: 768, bindingMatches: 33, swiftExecutions: 0, compiledMarkerAbsent: false });
  for (const mode of ['', '--fake', undefined]) assert.throws(() => runBootstrapTests(mode));
});
