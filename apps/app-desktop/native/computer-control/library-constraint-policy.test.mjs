// Portable source/JS-oracle tests. These do not count as Swift execution.
// Run separate --foundation command for actual Swift 5 / Foundation evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildPolicyVectors, validateJSVectors, checkPolicySourceGuards, runPolicyComparisonTests } from './library-constraint-policy.mjs';

const fixtureURL = new URL('../../scripts/fixtures/mac-library-constraint.arm64-macos26.v1.json', import.meta.url);

test('3046 independently labeled byte/inventory vectors agree with JS; fixture is never rewritten', () => {
  const before = readFileSync(fixtureURL, 'utf8');
  const vectors = buildPolicyVectors(), again = buildPolicyVectors();
  assert.deepEqual(vectors, again, 'Mutation/fuzz corpus must be deterministic');
  assert.equal(vectors.length, 3046);
  assert.equal(vectors.filter(v => v.want).length, 14);
  assert.equal(vectors[0].name, 'native-exact-independent-inventory');
  assert.equal(vectors[0].teamIdentifier, 'ZZZZZZZZZZ');
  assert.deepEqual(vectors[0].cdHashes.map(h => Buffer.from(h, 'base64')), [Buffer.alloc(20, 0x11), Buffer.alloc(20, 0x22)]);
  assert.equal(vectors[0].raw, JSON.parse(before).rawLibraryConstraintBase64);
  assert.equal(vectors.filter(v => v.name.startsWith('native-flip-')).length, 183 * 8);
  assert.equal(vectors.filter(v => v.name.startsWith('native-truncated-')).length, 183 + 175);
  assert.equal(vectors.filter(v => v.name.startsWith('native-deleted-')).length, 175);
  assert.equal(vectors.filter(v => v.name.startsWith('native-inserted-')).length, 175);
  assert.equal(vectors.filter(v => v.name.startsWith('deterministic-malformed-')).length, 500);
  assert(vectors.some(v => v.name === 'synthetic-count-64' && v.want));
  assert(vectors.some(v => v.name === 'cdhash-only-is-NOT-three-fact-policy' && !v.want));
  const beforeVectors = JSON.stringify(vectors), verdicts = validateJSVectors(vectors);
  assert.equal(verdicts.length, vectors.length);
  assert.equal(JSON.stringify(vectors), beforeVectors);
  assert.equal(readFileSync(fixtureURL, 'utf8'), before);
});

test('Swift source has immutable owned copying, fixed bounds/schema, no effects or authority integration', () => {
  const source = checkPolicySourceGuards();
  assert(source.includes('rawGenericBlob: [UInt8], expectedTeam: String'));
  assert(source.includes('expectedCDHashes: [[UInt8]]'));
  assert(source.includes('fileprivate init(matchedHashCount: Int)'));
  assert(source.includes('private struct Parser'));
  assert(source.includes('var inventory = Set<[UInt8]>()'));
  assert(source.includes('inventory.insert(owned).inserted'));
  assert(source.includes('TRUSTED') || source.includes('trusted provenance'));
  assert(source.includes('later cdhash-only load differential does NOT'));
  const harness = readFileSync(new URL('./LibraryConstraintPolicyTests.swift', import.meta.url), 'utf8');
  assert(harness.includes('policyTestValueSemantics'));
  assert(harness.includes('precondition(fields == Set(policyTestDTO(match).keys)'));
  assert(harness.includes('catch let error as LibraryConstraintPolicy.Failure'));
  assert(harness.includes('FileHandle.standardOutput.write'));
  assert(!source.includes('FileHandle.standardOutput.write'));
  // JavaScript's proxy/Buffer-brand/Any-schema tests have no equivalent typed
  // Swift argument. They are NOT simulated with an unsafe Foundation bridge.
  assert(!source.replace(/\/\/[^\n]*/g, '').includes('Any'));
});

test('portable runner never requests a compiler or claims Swift execution', () => {
  const summary = runPolicyComparisonTests(['--portable'], { spawnCompiler: () => assert.fail('Compiler must not run') });
  assert.deepEqual(summary, { vectors: 3046, matches: 14, swiftExecuted: false });
  for (const args of [[], ['--unknown'], ['--portable', '--foundation'], ['--foundation', '--library-path=relative'], ['--portable', '--library-path=/tmp']])
    assert.throws(() => runPolicyComparisonTests(args), { name: 'AssertionError' });
});

test('unavailable/failed Swift compiler fails explicit Foundation mode; no silent skip or fake pass', () => {
  for (const unavailable of [true, false]) {
    let calls = 0, main;
    assert.throws(() => runPolicyComparisonTests(['--foundation'], { spawnCompiler: (command, args) => {
      ++calls; assert.equal(command, 'swiftc'); assert(args.includes('-swift-version')); assert.equal(args[1], '5');
      main = args.find(a => a.endsWith('/main.swift'));
      const text = readFileSync(main, 'utf8');
      assert(text.startsWith(readFileSync(new URL('./LibraryConstraintPolicy.swift', import.meta.url), 'utf8')));
      return unavailable ? { error: { code: 'ENOENT' }, status: null } : { status: 1, stderr: 'synthetic compile failure' };
    } }), { name: 'AssertionError' });
    assert.equal(calls, 1); assert(!existsSync(main), 'Ephemeral concatenation removed even after failure');
  }
});

test('mocked execution timeout is failure, never a matching verdict', () => {
  let calls = 0, binary;
  assert.throws(() => runPolicyComparisonTests(['--foundation', '--library-path=/test-only/lib'], { spawnCompiler: (command, args) => {
    if (++calls === 1) {
      assert.equal(command, 'swiftc'); assert(args.includes('/test-only/lib')); binary = args.at(-1);
      return { status: 0 }; // Only simulates reaching the execution failure branch.
    }
    assert.equal(command, binary);
    return { error: { code: 'ETIMEDOUT' }, status: null };
  } }), { name: 'AssertionError' });
  assert.equal(calls, 2); assert(!existsSync(binary));
});
