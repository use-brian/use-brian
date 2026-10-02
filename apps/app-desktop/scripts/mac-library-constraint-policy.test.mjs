import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { compareObservedLibraryConstraintPolicy as compare, observedLibraryConstraintProfile, policyComparisonLimits } from './mac-library-constraint-policy.mjs';
import { verifyLibraryConstraintPolicy } from './mac-library-constraints.mjs';

// The only native-format evidence. Read-only: never rewrite or generate it.
const evidenceURL = new URL('./fixtures/mac-library-constraint.arm64-macos26.v1.json', import.meta.url);
const evidenceFile = readFileSync(evidenceURL, 'utf8');
const evidence = JSON.parse(evidenceFile);
const native = Buffer.from(evidence.rawLibraryConstraintBase64, 'base64');
// Independent test expectations, NOT read from evidence.policyPlist or DER.
const expected = () => ({ teamIdentifier: 'ZZZZZZZZZZ', cdHashes: [Buffer.alloc(20, 0x11), Buffer.alloc(20, 0x22)] });
const errorMessage = 'Library constraint policy comparison rejected: unsupported profile, malformed input, or inventory mismatch';
function rejected(bytes, ...supplied) {
  const inventory = supplied.length ? supplied[0] : expected();
  assert.throws(() => compare(bytes, inventory), {
    code: 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_COMPARISON', message: errorMessage,
  });
}

// SYNTHETIC mutation builder. It models the one observed shape, not an Apple
// serializer, not independent DER evidence, and not a signing/enforcement test.
const leaf = (tag, data) => ({ tag, data: Buffer.from(data) });
const int = value => leaf(2, [value]);
const str = text => leaf(12, Buffer.from(text, 'utf8'));
const container = (tag, children) => ({ tag, children });
const pair = (key, value) => container(0x30, [str(key), value]);
function graph(inventory = expected()) {
  const hashes = container(0x30, inventory.cdHashes.map(hash => leaf(4, hash)));
  const inPair = pair('$in', hashes), hashDict = container(0xb0, [inPair]);
  const hashPair = pair('cdhash', hashDict), team = str(inventory.teamIdentifier), category = int(6);
  const reqs = container(0xb0, [hashPair, pair('team-identifier', team), pair('validation-category', category)]);
  const ccat = int(0), comp = int(1), vers = int(1), outerVersion = int(1);
  const envelope = container(0xb0, [pair('ccat', ccat), pair('comp', comp), pair('reqs', reqs), pair('vers', vers)]);
  const root = container(0x70, [outerVersion, envelope]);
  return { root, outerVersion, envelope, ccat, comp, reqs, hashPair, hashDict, inPair, hashes, team, category, vers };
}
function lengthBytes(length) {
  if (length < 128) return Buffer.from([length]);
  if (length < 256) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, length >> 8, length & 255]);
}
function encode(node) {
  const body = node.children ? Buffer.concat(node.children.map(encode)) : node.data;
  return Buffer.concat([Buffer.from([node.tag]), node.lengthEncoding ?? lengthBytes(body.length), body]);
}
function blob(g) {
  const der = encode(g.root), b = Buffer.alloc(8 + der.length);
  b.writeUInt32BE(0xfade8181); b.writeUInt32BE(b.length, 4); der.copy(b, 8); return b;
}
function syntheticInventory(count) {
  return { teamIdentifier: 'A1B2C3D4E5', cdHashes: Array.from({ length: count }, (_, i) => {
    const hash = Buffer.alloc(20); hash.writeUInt32BE(i + 1, 16); return hash;
  }) };
}

test('exact user blob matches independent fake inventory, without authenticating its provenance', () => {
  assert.equal(native.length, 183); assert.equal(native.readUInt32BE(0), 0xfade8181);
  assert.equal(evidence.provenance.macOSBuild, '25G83');
  assert.equal(evidence.provenance.architecture, 'arm64');
  assert.equal(evidence.kernelEvidence, false); assert.equal(evidence.cmsAuthentication, false);
  assert.equal(evidence.executed, false);
  assert.ok(blob(graph()).equals(native)); // builder sanity, NOT new native evidence
  const result = compare(native, expected());
  assert.deepEqual(result, {
    kind: 'observed-policy-comparison', profile: observedLibraryConstraintProfile,
    policyMatchesSuppliedInventory: true, matchedHashCount: 2, productionAuthority: false,
    slotAuthentication: false, kernelAuthentication: false, cmsAuthentication: false,
    loadedImageAuthentication: false, nativeEnforcement: false,
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.values(result).every(value => ['string', 'number', 'boolean'].includes(typeof value)));
  assert.throws(() => { result.productionAuthority = true; }, TypeError);
  assert.throws(() => verifyLibraryConstraintPolicy(result), { code: 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_UNSUPPORTED' });
  assert.ok(readFileSync(evidenceURL, 'utf8') === evidenceFile);
});
test('native array order does not constrain independently supplied inventory order', () => {
  const e = expected(); e.cdHashes.reverse();
  assert.equal(compare(native, e).policyMatchesSuppliedInventory, true);
  const g = graph(); g.hashes.children.reverse(); // synthetic policy order reversal
  assert.equal(compare(blob(g), expected()).policyMatchesSuppliedInventory, true);
});
test('no input aliases or hashes/team returned, input byte buffers unchanged', () => {
  const bytes = Buffer.from(native), e = expected(), before = Buffer.from(bytes);
  const result = compare(bytes, e);
  assert.ok(bytes.equals(before));
  bytes.fill(0); e.cdHashes[0].fill(0); e.cdHashes.length = 0; e.teamIdentifier = 'A1B2C3D4E5';
  assert.equal(result.matchedHashCount, 2);
  assert.ok(!JSON.stringify(result).includes('ZZZZZZZZZZ'));
  assert.ok(!JSON.stringify(result).includes(Buffer.alloc(20, 0x11).toString('hex')));
});
test('independent expectation schema is strict, nonempty, unique, bounded and data-only', () => {
  for (const value of [undefined, null, {}, [], new Map(), evidence, { ...expected(), extra: true },
    { ...expected(), cdHashes: new Set(expected().cdHashes) }, { ...expected(), cdHashes: [] },
    { ...expected(), cdHashes: [Buffer.alloc(20, 0x11), Buffer.alloc(20, 0x11)] },
    { ...expected(), cdHashes: [Buffer.alloc(19)] }, { ...expected(), cdHashes: [Buffer.alloc(21)] },
    { ...expected(), cdHashes: [new Uint8Array(20)] }, { ...expected(), cdHashes: ['11'.repeat(20)] },
    { ...expected(), cdHashes: [Buffer.from(new SharedArrayBuffer(20))] },
    syntheticInventory(policyComparisonLimits.hashes + 1), { ...expected(), cdHashes: new Array(2) },
    ...['', 'ZZZZZZZZZ', 'ZZZZZZZZZZZ', 'zzzzzzzzzz', 'ZZZZZZZZZ\0', 'ＺZZZZZZZZZ', 1234567890].map(teamIdentifier => ({ ...expected(), teamIdentifier })),
  ]) rejected(native, value);
  const getter = expected(); Object.defineProperty(getter, 'teamIdentifier', { get() { assert.fail('getter invoked'); } }); rejected(native, getter);
  const arrayGetter = expected(); Object.defineProperty(arrayGetter.cdHashes, '0', { get() { assert.fail('array getter invoked'); } }); rejected(native, arrayGetter);
  const arrayExtra = expected(); arrayExtra.cdHashes.extra = true; rejected(native, arrayExtra);
  const symbol = expected(); symbol[Symbol('extra')] = true; rejected(native, symbol);
  const inherited = Object.create(expected()); rejected(native, inherited);
});
test('team and inventory must match EXACTLY: neither subset nor superset', () => {
  rejected(native, { ...expected(), teamIdentifier: 'A1B2C3D4E5' });
  rejected(native, { ...expected(), cdHashes: [Buffer.alloc(20, 0x11)] });
  rejected(native, { ...expected(), cdHashes: [...expected().cdHashes, Buffer.alloc(20, 0x33)] });
  rejected(native, { ...expected(), cdHashes: [Buffer.alloc(20, 0x11), Buffer.alloc(20, 0x33)] });
  const fewer = graph(); fewer.hashes.children.pop(); rejected(blob(fewer));
  const more = graph(); more.hashes.children.push(leaf(4, Buffer.alloc(20, 0x33))); rejected(blob(more));
});

for (const field of ['outerVersion', 'ccat', 'comp', 'vers', 'category']) {
  test(`every metadata/category integer must have exact observed value/type: ${field}`, () => {
    const correct = graph()[field].data[0];
    for (const v of [0, 1, 2, 5, 6, 7, 127, 128, 255].filter(v => v !== correct)) {
      const g = graph(); g[field].data = Buffer.from([v]); rejected(blob(g));
    }
    for (const data of [[], [0, correct], [255, correct], [0, 0, 0, correct]]) {
      const g = graph(); g[field].data = Buffer.from(data); rejected(blob(g));
    }
    for (const tag of [1, 4, 12, 0x30, 0xb0]) {
      const g = graph(); g[field].tag = tag; rejected(blob(g));
    }
  });
}
for (const where of ['envelope', 'reqs', 'hashDict']) {
  test(`reject duplicate/extra/missing/reordered dictionary keys: ${where}`, () => {
    const missing = graph(); missing[where].children.pop(); rejected(blob(missing));
    const duplicate = graph(); duplicate[where].children.push(duplicate[where].children[0]); rejected(blob(duplicate));
    const extra = graph(); extra[where].children.push(pair('extra', int(1))); rejected(blob(extra));
    const renamed = graph(); renamed[where].children[0].children[0] = str('unknown'); rejected(blob(renamed));
    const reversed = graph(); reversed[where].children.reverse();
    if (reversed[where].children.length > 1) rejected(blob(reversed));
  });
}
test('every metadata key spelling/order is fixed; reqs is not independently generalized', () => {
  for (let i = 0; i < 4; i++) {
    const renamed = graph(); renamed.envelope.children[i].children[0] = str(['category', 'compatibility', 'requirements', 'version'][i]); rejected(blob(renamed));
    const duplicate = graph(); duplicate.envelope.children.splice(i, 0, duplicate.envelope.children[i]); rejected(blob(duplicate));
    const wrongType = graph(); wrongType.envelope.children[i].children[1] = str('1'); rejected(blob(wrongType));
  }
  const g = graph(); [g.envelope.children[0], g.envelope.children[1]] = [g.envelope.children[1], g.envelope.children[0]]; rejected(blob(g));
});
test('unknown operators and weakening combinations never fall back', () => {
  for (const operator of ['$or', '$optional', '$and', '$or-array', '$and-array', '$query', '$in\0', 'in', '$IN']) {
    const g = graph(); g.inPair.children[0] = str(operator); rejected(blob(g));
    const wrapped = graph(); wrapped.envelope.children[2].children[1] = container(0xb0, [pair(operator, wrapped.reqs)]); rejected(blob(wrapped));
  }
});
test('hash list types/lengths/duplicates/empty and extra pair values reject', () => {
  for (const children of [[], [leaf(4, Buffer.alloc(19))], [leaf(4, Buffer.alloc(21))],
    [leaf(4, Buffer.alloc(20, 0x11)), leaf(4, Buffer.alloc(20, 0x11))],
    [leaf(4, Buffer.alloc(20, 0x11)), str('22222222222222222222')],
    [int(1)], [container(0x30, [leaf(4, Buffer.alloc(20, 0x11))])]]) {
    const g = graph(); g.hashes.children = children; rejected(blob(g));
  }
  const extraValue = graph(); extraValue.inPair.children.push(int(1)); rejected(blob(extraValue));
  const trailingOuter = graph(); trailingOuter.root.children.push(int(1)); rejected(blob(trailingOuter));
  const extraTupleKey = graph(); extraTupleKey.hashPair.children.unshift(str('cdhash')); rejected(blob(extraTupleKey));
});
test('all string bytes are strict ASCII UTF8, never replacement-decoded or normalized', () => {
  for (const bad of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ZZZZZZZZZ\0'), Buffer.from('ＺZZZZZZZZZ'), Buffer.from('ZZZZZZZZZZ\0')]) {
    const key = graph(); key.envelope.children[0].children[0].data = bad; rejected(blob(key));
    const team = graph(); team.team.data = bad; rejected(blob(team));
  }
  for (const tag of [4, 0x13, 0x16, 0x1e]) {
    const g = graph(); g.team.tag = tag; rejected(blob(g));
    const key = graph(); key.envelope.children[0].children[0].tag = tag; rejected(blob(key));
  }
});
test('all container tags are exact; SET, alternate class, high tags, primitive forms reject', () => {
  for (const field of ['root', 'envelope', 'reqs', 'hashDict', 'hashes', 'inPair']) {
    for (const tag of [0, 0x10, 0x31, 0x50, 0x70, 0x90, 0xb0, 0xf0, 0x7f, 0xbf].filter(v => v !== graph()[field].tag)) {
      const g = graph(); g[field].tag = tag; rejected(blob(g));
    }
  }
});
test('DER lengths must be definite, minimal and bounded at every level', () => {
  for (const field of ['root', 'outerVersion', 'envelope', 'ccat', 'reqs', 'hashPair', 'hashDict', 'inPair', 'hashes', 'team', 'category', 'vers']) {
    const original = graph()[field], size = original.children ? Buffer.concat(original.children.map(encode)).length : original.data.length;
    const encodings = [[0x80], [0xff], [0x81, 0], [0x82, 0, size], [0x83, 0, 0, size], [0x82, 0xff, 0xff], [0]];
    if (size < 128) encodings.push([0x81, size]);
    for (const bytes of encodings) { const g = graph(); g[field].lengthEncoding = Buffer.from(bytes); rejected(blob(g)); }
  }
});
for (const count of [1, 2, 4, 5, 6, 10, 11, 12, 64]) {
  test(`synthetic minimal-length transitions and bounded membership (${count} hashes), NOT native evidence`, () => {
    const inventory = syntheticInventory(count), g = graph(inventory);
    const b = blob(g);
    assert.ok(b.length < policyComparisonLimits.bytes);
    assert.equal(compare(b, inventory).matchedHashCount, count);
    assert.ok(encode(g.hashes).subarray(1, 1 + lengthBytes(count * 22).length).equals(lengthBytes(count * 22)));
  });
}
test('over-max inventories, bytes and adversarial nesting cannot expand parser budgets', () => {
  assert.ok(Object.isFrozen(policyComparisonLimits));
  rejected(blob(graph(syntheticInventory(65))), syntheticInventory(64));
  rejected(Buffer.alloc(policyComparisonLimits.bytes + 1));
  const atLimit = Buffer.alloc(policyComparisonLimits.bytes);
  atLimit.writeUInt32BE(0xfade8181); atLimit.writeUInt32BE(atLimit.length, 4);
  rejected(atLimit); // Being within budget does not make an unknown shape valid.
  const depth = graph(); let nested = int(1);
  for (let i = 0; i < 100; i++) nested = container(0x30, [nested]);
  depth.hashes.children = [nested]; rejected(blob(depth));
  const nodes = graph(); nodes.hashes.children = Array.from({ length: 200 }, () => int(1)); rejected(blob(nodes));
});
test('generic header exactness, raw type, extra/trailing content and all truncations', () => {
  for (const bytes of [null, undefined, new Uint8Array(native), native.toString('base64'), evidence,
    { rawBlob: native, kernelAuthentication: true }, Buffer.from(new SharedArrayBuffer(183))]) rejected(bytes);
  for (const at of [0, 3, 4, 7]) { const b = Buffer.from(native); b[at] ^= 1; rejected(b); }
  const appended = Buffer.concat([native, Buffer.from([0])]); rejected(appended);
  appended.writeUInt32BE(appended.length, 4); rejected(appended);
  for (let size = 0; size < native.length; size++) {
    rejected(native.subarray(0, size));
    if (size >= 8) { const b = Buffer.from(native.subarray(0, size)); b.writeUInt32BE(size, 4); rejected(b); }
  }
});
test('independent bit-flip and insertion/deletion corpus on exact native bytes fails closed', () => {
  for (let i = 0; i < native.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const changed = Buffer.from(native); changed[i] ^= 1 << bit; rejected(changed);
    }
    if (i < 8) continue;
    const deleted = Buffer.concat([native.subarray(0, i), native.subarray(i + 1)]); deleted.writeUInt32BE(deleted.length, 4); rejected(deleted);
    const inserted = Buffer.concat([native.subarray(0, i), Buffer.from([0]), native.subarray(i)]); inserted.writeUInt32BE(inserted.length, 4); rejected(inserted);
  }
  assert.ok(readFileSync(evidenceURL, 'utf8') === evidenceFile);
});
test('deterministic arbitrary malformed byte fuzz never leaks native Buffer errors/data', () => {
  let seed = 0xc0ffee;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 500; i++) {
    const bytes = Buffer.alloc(8 + next() % 1024);
    for (let j = 8; j < bytes.length; j++) bytes[j] = next() & 255;
    bytes.writeUInt32BE(0xfade8181); bytes.writeUInt32BE(bytes.length, 4);
    rejected(bytes);
  }
});
test('cross-realm shared backing stores reject, ordinary detached expectations may be null-prototype', () => {
  const sharedHash = Buffer.from(runInNewContext('new SharedArrayBuffer(20)'));
  rejected(native, { ...expected(), cdHashes: [sharedHash] });
  const sharedBlob = Buffer.from(runInNewContext('new SharedArrayBuffer(183)'));
  native.copy(sharedBlob); rejected(sharedBlob);
  const inventory = Object.assign(Object.create(null), expected());
  assert.equal(compare(native, inventory).policyMatchesSuppliedInventory, true);
});

// Caller-data hardening regressions. No claim to sandbox code that can replace
// process-wide intrinsics; these assert that input-owned hooks never execute.
test('Buffer property/coercion hooks are ignored by intrinsic bounded copying', () => {
  let calls = 0;
  const hook = () => { calls++; throw new Error('PRIVATE getter: /Users/example/' + '11'.repeat(20)); };
  const decorate = value => {
    for (const key of ['buffer', 'length', 'byteOffset', 'byteLength', 'valueOf', 'constructor', 'toString', Symbol.iterator, Symbol.toPrimitive]) {
      Object.defineProperty(value, key, { get: hook });
    }
    return value;
  };
  const raw = decorate(Buffer.from(native)), e = expected();
  e.cdHashes = e.cdHashes.map(decorate);
  assert.equal(compare(raw, e).policyMatchesSuppliedInventory, true);
  assert.equal(calls, 0);
});
test('hidden shared backing cannot pass via an own buffer getter or data property', () => {
  let calls = 0;
  for (const getter of [false, true]) {
    const sharedRaw = Buffer.from(new SharedArrayBuffer(native.length)); native.copy(sharedRaw);
    const sharedHash = Buffer.from(new SharedArrayBuffer(20)); sharedHash.fill(0x11);
    const descriptor = getter ? { get() { calls++; return new ArrayBuffer(4096); } } : { value: new ArrayBuffer(4096) };
    Object.defineProperty(sharedRaw, 'buffer', descriptor);
    Object.defineProperty(sharedHash, 'buffer', descriptor);
    rejected(sharedRaw);
    rejected(native, { ...expected(), cdHashes: [sharedHash, Buffer.alloc(20, 0x22)] });
  }
  assert.equal(calls, 0);
});
test('own length cannot evade raw/hash bounds or change between check and copy', () => {
  let calls = 0;
  const changing = () => ++calls === 1 ? native.length : Number.MAX_SAFE_INTEGER;
  const valid = Buffer.from(native); Object.defineProperty(valid, 'length', { get: changing });
  assert.equal(compare(valid, expected()).matchedHashCount, 2);
  for (const size of [0, 7, policyComparisonLimits.bytes + 1]) {
    const raw = Buffer.alloc(size); Object.defineProperty(raw, 'length', { get: changing }); rejected(raw);
  }
  for (const size of [0, 19, 21, 4097]) {
    const hash = Buffer.alloc(size, 0x11); Object.defineProperty(hash, 'length', { get() { calls++; return 20; } });
    rejected(native, { ...expected(), cdHashes: [hash, Buffer.alloc(20, 0x22)] });
  }
  assert.equal(calls, 0);
});
test('native byte-view brand rejects prototype-spoofed non-byte views and plain objects', () => {
  let calls = 0;
  for (const value of [new Uint16Array(20), new Int8Array(20), new Uint8ClampedArray(20), new DataView(new ArrayBuffer(20)), {}]) {
    Object.setPrototypeOf(value, Buffer.prototype);
    // Buffer's prototype check alone accepts these; the native brand must not.
    assert.equal(Buffer.isBuffer(value), true);
    Object.defineProperty(value, 'buffer', { get() { calls++; throw new Error('private'); } });
    rejected(value);
    rejected(native, { ...expected(), cdHashes: [value, Buffer.alloc(20, 0x22)] });
  }
  assert.equal(calls, 0);
});
test('proxy and revoked-proxy inputs reject before ANY reflection/brand/coercion trap', () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error('PRIVATE proxy failure ' + '22'.repeat(20)); };
  const proxied = value => new Proxy(value, { get: trap, ownKeys: trap, getPrototypeOf: trap,
    getOwnPropertyDescriptor: trap, has: trap, apply: trap });
  const revoked = value => { const p = Proxy.revocable(value, {}); p.revoke(); return p.proxy; };
  for (const wrap of [proxied, revoked]) {
    rejected(wrap(Buffer.from(native)));
    rejected(native, wrap(expected()));
    rejected(native, { ...expected(), cdHashes: wrap(expected().cdHashes) });
    rejected(native, { ...expected(), cdHashes: [wrap(Buffer.alloc(20, 0x11)), Buffer.alloc(20, 0x22)] });
    rejected(wrap(new Uint16Array(20)));
  }
  // A genuine byte view with a proxy prototype must not reach instanceof's
  // prototype traversal, which could otherwise execute getPrototypeOf traps.
  const raw = Buffer.from(native); Object.setPrototypeOf(raw, proxied(Buffer.prototype)); rejected(raw);
  const record = Object.create(proxied(Object.prototype)); rejected(native, record);
  assert.equal(calls, 0);
});
test('expectation field/index accessors reject without invoking their code', () => {
  let calls = 0;
  const hook = () => { calls++; throw new Error('PRIVATE accessor error'); };
  for (const key of ['teamIdentifier', 'cdHashes']) {
    const e = expected(); Object.defineProperty(e, key, { get: hook }); rejected(native, e);
  }
  for (const index of ['0', '1']) {
    const e = expected(); Object.defineProperty(e.cdHashes, index, { get: hook }); rejected(native, e);
  }
  const extra = expected(); Object.defineProperty(extra.cdHashes, Symbol.iterator, { get: hook }); rejected(native, extra);
  assert.equal(calls, 0);
});
test('unexpected synchronous validator exceptions become the same value-free failure without cause', () => {
  // Test-only fault injection into internal validation, restored synchronously.
  // This tests error privacy, NOT safety against hostile global monkeypatches.
  const original = Buffer.prototype.readUInt32BE;
  const privateMessage = 'PRIVATE internal error /Users/example ' + '33'.repeat(20);
  let calls = 0, caught;
  try {
    Buffer.prototype.readUInt32BE = () => { calls++; throw new Error(privateMessage); };
    try { compare(native, expected()); } catch (error) { caught = error; }
  } finally { Buffer.prototype.readUInt32BE = original; }
  assert.equal(calls, 1);
  assert.equal(caught?.message, errorMessage);
  assert.equal(caught?.code, 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_COMPARISON');
  assert.equal(Object.hasOwn(caught, 'cause'), false);
  assert.ok(!String(caught.stack).includes(privateMessage));
  assert.ok(!JSON.stringify(caught).includes(privateMessage));
  assert.ok(readFileSync(evidenceURL, 'utf8') === evidenceFile);
});
