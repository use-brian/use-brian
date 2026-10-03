// TEST ONLY. node library-constraint-policy.mjs --portable
// Linux Foundation: node library-constraint-policy.mjs --foundation [--library-path=/.../lib]
// Uses swiftc from PATH, -swift-version 5, and a temporary concatenated main.swift.
// No helper/build integration, native Security/SDK test, signing, bundle or authority.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareObservedLibraryConstraintPolicy as compareJS } from '../../scripts/mac-library-constraint-policy.mjs';
import { verifyLibraryConstraintPolicy } from '../../scripts/mac-library-constraints.mjs';

const fixtureURL = new URL('../../scripts/fixtures/mac-library-constraint.arm64-macos26.v1.json', import.meta.url);
const failure = Object.freeze({ code: 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_COMPARISON',
  message: 'Library constraint policy comparison rejected: unsupported profile, malformed input, or inventory mismatch' });
const inventory = () => ({ teamIdentifier: 'ZZZZZZZZZZ', cdHashes: [Buffer.alloc(20, 0x11), Buffer.alloc(20, 0x22)] });
const validResult = count => ({ kind: 'observed-policy-comparison', profile: 'user-arm64-macos26-v1-envelope-only',
  policyMatchesSuppliedInventory: true, matchedHashCount: count, productionAuthority: false,
  slotAuthentication: false, kernelAuthentication: false, cmsAuthentication: false,
  loadedImageAuthentication: false, nativeEnforcement: false });

// Synthetic encoder only: mirrors a described tree, does NOT call either parser.
// The exact native bytes and their mutation/truncation corpora do not use this
// builder. Known verdict labels are independently asserted against BOTH languages.
const leaf = (tag, data) => ({ tag, data: Buffer.from(data) });
const integer = value => leaf(2, [value]);
const text = value => leaf(12, Buffer.from(value, 'utf8'));
const box = (tag, children) => ({ tag, children });
const pair = (name, value) => box(0x30, [text(name), value]);
function tree(e = inventory()) {
  const hashes = box(0x30, e.cdHashes.map(hash => leaf(4, hash)));
  const inPair = pair('$in', hashes), hashDict = box(0xb0, [inPair]), hashPair = pair('cdhash', hashDict);
  const team = text(e.teamIdentifier), category = integer(6);
  const reqs = box(0xb0, [hashPair, pair('team-identifier', team), pair('validation-category', category)]);
  const ccat = integer(0), comp = integer(1), vers = integer(1), outerVersion = integer(1);
  const envelope = box(0xb0, [pair('ccat', ccat), pair('comp', comp), pair('reqs', reqs), pair('vers', vers)]);
  return { root: box(0x70, [outerVersion, envelope]), outerVersion, envelope, ccat, comp, reqs, hashPair, hashDict, inPair, hashes, team, category, vers };
}
function sizeBytes(n) { return Buffer.from(n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]); }
function encode(node) {
  const body = node.children ? Buffer.concat(node.children.map(encode)) : node.data;
  return Buffer.concat([Buffer.from([node.tag]), node.lengthEncoding ?? sizeBytes(body.length), body]);
}
function generic(t) {
  const der = encode(t.root), result = Buffer.alloc(8 + der.length);
  result.writeUInt32BE(0xfade8181); result.writeUInt32BE(result.length, 4); der.copy(result, 8); return result;
}
function generatedInventory(count) {
  return { teamIdentifier: 'A1B2C3D4E5', cdHashes: Array.from({ length: count }, (_, i) => {
    const bytes = Buffer.alloc(20); bytes.writeUInt32BE(i + 1, 16); return bytes;
  }) };
}

export function buildPolicyVectors() {
  const fixtureText = readFileSync(fixtureURL, 'utf8'), evidence = JSON.parse(fixtureText);
  const native = Buffer.from(evidence.rawLibraryConstraintBase64, 'base64');
  assert.equal(native.length, 183); assert.equal(evidence.provenance.macOSBuild, '25G83');
  assert.equal(evidence.provenance.architecture, 'arm64'); assert.equal(evidence.executed, false);
  assert.equal(evidence.cmsAuthentication, false); assert.equal(evidence.kernelEvidence, false);
  const vectors = [];
  function add(name, raw, expected = inventory(), want = false) {
    vectors.push({ name, want, count: want ? expected.cdHashes.length : null, raw: raw.toString('base64'),
      teamIdentifier: expected.teamIdentifier, cdHashes: expected.cdHashes.map(h => h.toString('base64')) });
  }
  function change(name, mutate) { const t = tree(); mutate(t); add(name, generic(t)); }
  add('native-exact-independent-inventory', native, inventory(), true);
  assert.deepEqual(generic(tree()), native, 'Synthetic encoder sanity, NOT new native evidence');
  add('native-reversed-expected-inventory', native, { ...inventory(), cdHashes: inventory().cdHashes.reverse() }, true);
  const reverse = tree(); reverse.hashes.children.reverse(); add('synthetic-reversed-membership', generic(reverse), inventory(), true);
  for (const count of [1, 2, 4, 5, 6, 10, 11, 12, 63, 64]) {
    const e = generatedInventory(count); add(`synthetic-count-${count}`, generic(tree(e)), e, true);
  }
  // Full-byte variation is data, not integer coercion/truncation. Exactly one
  // mismatched byte (including the last) must change set membership.
  const varied = { teamIdentifier: '0123456789', cdHashes: [Buffer.from(Array.from({ length: 20 }, (_, i) => i * 13)), Buffer.alloc(20, 255)] };
  add('synthetic-varied-hash-bytes', generic(tree(varied)), varied, true);
  for (let i = 0; i < 20; ++i) {
    const wrong = varied.cdHashes.map(h => Buffer.from(h)); wrong[0][i] ^= 1;
    add(`inventory-byte-${i}`, generic(tree(varied)), { ...varied, cdHashes: wrong });
  }
  for (const team of ['', 'ZZZZZZZZZ', 'ZZZZZZZZZZZ', 'zzzzzzzzzz', 'ZZZZZZZZZ\0', 'ＺZZZZZZZZZ', 'ZZZZZZZZZZ\n', 'A'.repeat(10000)])
    add('invalid-team', native, { ...inventory(), teamIdentifier: team });
  add('different-team', native, { ...inventory(), teamIdentifier: 'A1B2C3D4E5' });
  for (const list of [[], [Buffer.alloc(19)], [Buffer.alloc(21)], [Buffer.alloc(0)], [Buffer.alloc(4097)],
    [Buffer.alloc(20, 0x11)], [Buffer.alloc(20, 0x11), Buffer.alloc(20, 0x11)],
    [Buffer.alloc(20, 0x11), Buffer.alloc(20, 0x33)], [...inventory().cdHashes, Buffer.alloc(20, 0x33)], generatedInventory(65).cdHashes])
    add('invalid-or-mismatched-inventory', native, { ...inventory(), cdHashes: list });
  change('policy-subset', t => t.hashes.children.pop());
  change('policy-superset', t => t.hashes.children.push(leaf(4, Buffer.alloc(20, 0x33))));
  change('cdhash-only-is-NOT-three-fact-policy', t => { t.reqs.children = [t.hashPair]; });
  for (const field of ['outerVersion', 'ccat', 'comp', 'vers', 'category']) {
    const original = tree()[field].data[0];
    for (const value of [0, 1, 2, 5, 6, 7, 127, 128, 255].filter(v => v !== original))
      change(`integer-value-${field}-${value}`, t => { t[field].data = Buffer.from([value]); });
    for (const data of [[], [0, original], [255, original], [0, 0, 0, original]])
      change(`integer-encoding-${field}`, t => { t[field].data = Buffer.from(data); });
    for (const tag of [1, 4, 12, 0x30, 0xb0]) change(`integer-type-${field}-${tag}`, t => { t[field].tag = tag; });
  }
  for (const field of ['envelope', 'reqs', 'hashDict']) {
    change(`missing-${field}`, t => t[field].children.pop());
    change(`duplicate-${field}`, t => t[field].children.push(t[field].children[0]));
    change(`extra-${field}`, t => t[field].children.push(pair('extra', integer(1))));
    change(`renamed-${field}`, t => { t[field].children[0].children[0] = text('unknown'); });
    if (tree()[field].children.length > 1) change(`reversed-${field}`, t => t[field].children.reverse());
  }
  for (let i = 0; i < 4; ++i) {
    change(`guessed-metadata-meaning-${i}`, t => { t.envelope.children[i].children[0] = text(['category', 'compatibility', 'requirements', 'version'][i]); });
    change(`duplicate-metadata-${i}`, t => t.envelope.children.splice(i, 0, t.envelope.children[i]));
    change(`wrong-metadata-type-${i}`, t => { t.envelope.children[i].children[1] = text('1'); });
  }
  for (const op of ['$or', '$optional', '$and', '$or-array', '$and-array', '$query', '$in\0', 'in', '$IN']) {
    change(`unknown-operator-${op}`, t => { t.inPair.children[0] = text(op); });
    change(`weakened-wrapper-${op}`, t => { t.envelope.children[2].children[1] = box(0xb0, [pair(op, t.reqs)]); });
  }
  for (const list of [[], [leaf(4, Buffer.alloc(19))], [leaf(4, Buffer.alloc(21))], [leaf(4, Buffer.alloc(20, 0x11)), leaf(4, Buffer.alloc(20, 0x11))],
    [leaf(4, Buffer.alloc(20, 0x11)), text('22222222222222222222')], [integer(1)], [box(0x30, [leaf(4, Buffer.alloc(20, 0x11))])]])
    change('malformed-hash-list', t => { t.hashes.children = list; });
  change('extra-pair-value', t => t.inPair.children.push(integer(1)));
  change('extra-outer-value', t => t.root.children.push(integer(1)));
  change('extra-tuple-key', t => t.hashPair.children.unshift(text('cdhash')));
  for (const bad of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('ZZZZZZZZZ\0'), Buffer.from('ＺZZZZZZZZZ'), Buffer.from('ZZZZZZZZZZ\0')]) {
    change('invalid-string-key', t => { t.envelope.children[0].children[0].data = bad; });
    change('invalid-string-team', t => { t.team.data = bad; });
  }
  for (const tag of [4, 0x13, 0x16, 0x1e]) {
    change('wrong-team-string-type', t => { t.team.tag = tag; });
    change('wrong-key-string-type', t => { t.envelope.children[0].children[0].tag = tag; });
  }
  for (const field of ['root', 'envelope', 'reqs', 'hashDict', 'hashes', 'inPair'])
    for (const tag of [0, 0x10, 0x31, 0x50, 0x70, 0x90, 0xb0, 0xf0, 0x7f, 0xbf].filter(v => v !== tree()[field].tag))
      change(`wrong-container-${field}-${tag}`, t => { t[field].tag = tag; });
  for (const field of ['root', 'outerVersion', 'envelope', 'ccat', 'reqs', 'hashPair', 'hashDict', 'inPair', 'hashes', 'team', 'category', 'vers']) {
    const original = tree()[field], size = original.children ? Buffer.concat(original.children.map(encode)).length : original.data.length;
    const encodings = [[0x80], [0xff], [0x81, 0], [0x82, 0, size], [0x83, 0, 0, size], [0x82, 0xff, 0xff], [0]];
    if (size < 128) encodings.push([0x81, size]);
    for (const bytes of encodings) change(`nonminimal-or-invalid-length-${field}`, t => { t[field].lengthEncoding = Buffer.from(bytes); });
  }
  add('over-max-policy-hashes', generic(tree(generatedInventory(65))), generatedInventory(64));
  add('over-max-bytes', Buffer.alloc(4097));
  const maximum = Buffer.alloc(4096); maximum.writeUInt32BE(0xfade8181); maximum.writeUInt32BE(maximum.length, 4);
  add('max-bytes-unknown-shape', maximum);
  change('deep-nesting', t => { let nested = integer(1); for (let i = 0; i < 100; ++i) nested = box(0x30, [nested]); t.hashes.children = [nested]; });
  change('excess-nodes', t => { t.hashes.children = Array.from({ length: 200 }, () => integer(1)); });
  // Independent corpus: mutations operate directly on the original 183 bytes,
  // never by reserializing, locating fields or consulting either parser's output.
  const appended = Buffer.concat([native, Buffer.from([0])]); add('native-trailing', appended);
  appended.writeUInt32BE(appended.length, 4); add('native-trailing-correct-header', appended);
  for (let size = 0; size < native.length; ++size) {
    add(`native-truncated-${size}`, native.subarray(0, size));
    if (size >= 8) { const b = Buffer.from(native.subarray(0, size)); b.writeUInt32BE(size, 4); add(`native-truncated-adjusted-${size}`, b); }
  }
  for (let i = 0; i < native.length; ++i) {
    for (let bit = 0; bit < 8; ++bit) { const b = Buffer.from(native); b[i] ^= 1 << bit; add(`native-flip-${i}-${bit}`, b); }
    if (i < 8) continue;
    const deleted = Buffer.concat([native.subarray(0, i), native.subarray(i + 1)]); deleted.writeUInt32BE(deleted.length, 4); add(`native-deleted-${i}`, deleted);
    const inserted = Buffer.concat([native.subarray(0, i), Buffer.from([0]), native.subarray(i)]); inserted.writeUInt32BE(inserted.length, 4); add(`native-inserted-${i}`, inserted);
  }
  let seed = 0xc0ffee;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 500; ++i) {
    const b = Buffer.alloc(8 + next() % 1024);
    for (let j = 8; j < b.length; ++j) b[j] = next() & 255;
    b.writeUInt32BE(0xfade8181); b.writeUInt32BE(b.length, 4); add(`deterministic-malformed-${i}`, b);
  }
  assert.equal(readFileSync(fixtureURL, 'utf8'), fixtureText);
  return vectors;
}

export function validateJSVectors(vectors) {
  return vectors.map(vector => {
    let verdict;
    try {
      verdict = { match: compareJS(Buffer.from(vector.raw, 'base64'), { teamIdentifier: vector.teamIdentifier,
        cdHashes: vector.cdHashes.map(h => Buffer.from(h, 'base64')) }) };
    } catch (error) {
      assert.equal(error.code, failure.code, vector.name); assert.equal(error.message, failure.message, vector.name);
      verdict = { error: failure };
    }
    assert.deepEqual(verdict, vector.want ? { match: validResult(vector.count) } : { error: failure }, vector.name);
    return verdict;
  });
}

export function checkPolicySourceGuards() {
  const source = readFileSync(new URL('./LibraryConstraintPolicy.swift', import.meta.url), 'utf8');
  const executable = source.replace(/\/\/[^\n]*/g, '');
  for (const text of ['static let bytes = 4096', 'static let hashes = 64', 'static let nodes = 128', 'static let depth = 9',
    'let bytes: [UInt8]', 'copy.reserveCapacity(input.count)', 'for byte in input { copy.append(byte) }',
    'expectedTeam.utf8.prefix(11)', 'actual.count == inventory.count', 'inventory.contains(hash)', 'actual.insert(hash).inserted',
    'nodes < Limits.nodes', 'parent.depth < Limits.depth', 'parent.end - parent.at', 'count != 2 || length >= 256',
    'try integerPair(&envelope, "ccat", 0)', 'try integerPair(&envelope, "comp", 1)', 'try integerPair(&envelope, "vers", 1)',
    'try integerPair(&reqs, "validation-category", 6)', 'word(0) == 0xfade8181', 'word(4) == UInt32(bytes.count)']) assert(source.includes(text), text);
  for (const name of ['productionAuthority', 'slotAuthentication', 'kernelAuthentication', 'cmsAuthentication', 'loadedImageAuthentication', 'nativeEnforcement'])
    assert(source.includes(`let ${name} = false`));
  assert(!/Unsafe|NSData|\bData\b|FileHandle|FileManager|ProcessInfo|CommandLine|Dispatch|Date\(|print\(|getenv|SecCode|Crypto|fatalError|precondition|try!|as!|#if/.test(executable));
  assert(!/import (?!Foundation\b)/.test(executable));
  assert.equal((executable.match(/case rejected/g) ?? []).length, 1);
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const build = readFileSync(new URL('./build.sh', import.meta.url), 'utf8');
  // Compiled into the native build now, but never used as operational admission.
  assert(!helper.includes('LibraryConstraintPolicy'));
  assert(build.includes('LibraryConstraintPolicy.swift'));
  assert(build.includes('BootstrapApprovalAnchor.c'));
  assert(helper.includes('dispatcher.response(request, clock: sourceClock)')); assert(helper.includes('let dispatcher = ObservationDispatcher { Broker(trust: trust) }'));
  assert.throws(() => verifyLibraryConstraintPolicy(validResult(2)), { code: 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_UNSUPPORTED' });
  return source;
}

export function runPolicyComparisonTests(args, { spawnCompiler = spawnSync } = {}) {
  const modes = args.filter(a => ['--foundation', '--portable'].includes(a));
  assert.equal(modes.length, 1, 'Choose exactly --portable or --foundation');
  assert(args.every(a => ['--foundation', '--portable'].includes(a) || a.startsWith('--library-path=')), 'Unknown test option');
  const paths = args.filter(a => a.startsWith('--library-path=')).map(a => a.slice('--library-path='.length));
  assert(paths.every(p => p.startsWith('/') && !p.includes('\0')), 'Linker paths must be absolute');
  assert(modes[0] === '--foundation' || paths.length === 0, 'Linker paths only apply to Foundation tests');
  const fixtureBefore = readFileSync(fixtureURL, 'utf8');
  const source = checkPolicySourceGuards(), vectors = buildPolicyVectors(), jsVerdicts = validateJSVectors(vectors);
  const summary = { vectors: vectors.length, matches: vectors.filter(v => v.want).length, swiftExecuted: false };
  if (modes[0] === '--portable') return summary;
  const temporary = mkdtempSync(join(tmpdir(), 'brian-swift-policy-tests-'));
  try {
    // Test-only solution for Swift top-level code. Production/build files are NOT
    // concatenated or rewired; this emits only an ephemeral harness executable.
    const main = join(temporary, 'main.swift'), binary = join(temporary, 'policy-tests'), data = join(temporary, 'vectors.json');
    writeFileSync(main, source + '\n' + readFileSync(new URL('./LibraryConstraintPolicyTests.swift', import.meta.url), 'utf8'));
    writeFileSync(data, JSON.stringify(vectors.map(({ raw, teamIdentifier, cdHashes }) => ({ raw, teamIdentifier, cdHashes }))));
    const libraries = paths.flatMap(p => ['-L', p, '-Xlinker', '-rpath', '-Xlinker', p]);
    const compiled = spawnCompiler('swiftc', ['-swift-version', '5', ...libraries, main, '-o', binary],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(compiled.error, undefined, `Swift compiler unavailable: ${compiled.error?.code ?? ''}`);
    assert.equal(compiled.status, 0, `Swift compile failed:\n${compiled.stdout ?? ''}\n${compiled.stderr ?? ''}`);
    const executed = spawnCompiler(binary, [data], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(executed.error, undefined, 'Swift test execution unavailable/timed out');
    assert.equal(executed.status, 0, `Swift test failed:\n${executed.stderr ?? ''}`);
    const verdicts = JSON.parse(executed.stdout);
    assert.equal(verdicts.length, vectors.length);
    for (let i = 0; i < vectors.length; ++i) assert.deepEqual(verdicts[i], jsVerdicts[i], vectors[i].name);
    summary.swiftExecuted = true;
    return summary;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    assert.equal(readFileSync(fixtureURL, 'utf8'), fixtureBefore, 'Native fixture must remain untouched');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runPolicyComparisonTests(process.argv.slice(2));
    console.log(`PASS ${result.vectors} independently labeled vectors (${result.matches} matches) against JS; source guards passed.`);
    console.log(result.swiftExecuted
      ? `PASS ${process.platform === 'linux' ? 'Linux Foundation' : 'host Foundation'} Swift 5 execution: all verdicts/evidence equal JS. NOT helper/macOS SDK/native enforcement acceptance.`
      : 'SKIP Swift execution (--portable only). No Swift compilation or native acceptance claimed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
