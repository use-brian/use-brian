import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { canonicalElectronLibrary as electron, inventoryLimits, captureReleaseLibraryInventoryData as capture,
  extractMachOLibraryData as extract, requireApprovedBootstrapInventory, requireVerifiedCapturedInventory } from './mac-bootstrap-inventory.mjs';
import { integrityDictionaryDigest } from './mac-asar-integrity.mjs';
import { encodeBootstrapApprovalRecord } from './mac-bootstrap-anchor.mjs';
import { nativeFile, universal, blob, codeDirectory, digest, rehash, signatureOffset as sig } from './mac-bootstrap-inventory.test-fixtures.mjs';
const options = { architectures: ['arm64'] };
const rejection = fn => assert.throws(fn, { code: 'ERR_MAC_BOOTSTRAP_INVENTORY',
  message: 'Release library inventory data rejected: unsupported, changed, malformed, or bounded capture failure' });
function tree(t, binary = nativeFile(), tempParent = tmpdir()) {
  const temp = fs.realpathSync(fs.mkdtempSync(join(tempParent, 'bootstrap-inventory-test-'))), root = join(temp, 'Use Brian.app');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(root, { mode: 0o700 });
  const put = (rel, data) => { const path = join(root, rel); fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); fs.writeFileSync(path, data, { mode: 0o600 }); return path; };
  const path = put(electron, binary), framework = dirname(dirname(dirname(path)));
  fs.symlinkSync('A', join(framework, 'Versions/Current'));
  fs.symlinkSync('Versions/Current/Electron Framework', join(framework, 'Electron Framework'));
  return { root, temp, put, path, framework };
}
function patched(name, implementation, action) {
  const original = fs[name]; fs[name] = implementation(original);
  try { return action(); } finally { fs[name] = original; }
}

test('inventory failures retain the actual internal check without exposing foreign error text', t => {
  assert.throws(() => extract(Buffer.alloc(0), ['arm64']), error => {
    assert.equal(error.code, 'ERR_MAC_BOOTSTRAP_INVENTORY');
    assert.match(error.stack, /at copy \(/);
    return true;
  });
  const f = tree(t);
  const foreign = Object.assign(new Error('PRIVATE_FILESYSTEM_DIAGNOSTIC'), { code: 'ERR_MAC_BOOTSTRAP_INVENTORY' });
  patched('lstatSync', () => () => { throw foreign; }, () => {
    assert.throws(() => capture(f.root, options), error => {
      assert.notEqual(error, foreign);
      assert.equal(error.code, 'ERR_MAC_BOOTSTRAP_INVENTORY');
      assert.ok(!error.stack.includes('PRIVATE_FILESYSTEM_DIAGNOSTIC'));
      return true;
    });
  });
});

test('unused signature allocation is captured but is not interpreted as signature content', t => {
  const bytes = nativeFile(), declared = bytes.readUInt32BE(sig + 4);
  const f = tree(t, bytes), before = capture(f.root, options);
  const original = extract(bytes, ['arm64']);
  bytes.fill(0xa5, sig + declared);
  const padded = extract(bytes, ['arm64']);
  assert.equal(padded.productionAuthority, false);
  assert.equal(padded.architectures[0].cdHash, original.architectures[0].cdHash);
  assert.equal(padded.architectures[0].codeDirectorySHA256, original.architectures[0].codeDirectorySHA256);
  assert.notEqual(padded.architectures[0].signatureContainerSHA256, original.architectures[0].signatureContainerSHA256);
  f.put(electron, bytes);
  const after = capture(f.root, options);
  assert.deepEqual(after.candidateCDHashes, before.candidateCDHashes);
  assert.notEqual(after.libraries[0].fileSHA256, before.libraries[0].fileSHA256);

  // The identical nonzero byte becomes invalid if included in the declared body.
  bytes.writeUInt32BE(declared + 1, sig + 4);
  assert.throws(() => extract(bytes, ['arm64']), error => {
    assert.equal(error.code, 'ERR_MAC_BOOTSTRAP_INVENTORY');
    assert.equal(error.inventoryCheck, 'signature-tail');
    assert.equal(error.allocatedSignatureBytes, bytes.length - sig);
    assert.equal(error.declaredSignatureBytes, declared + 1);
    assert.equal(error.indexedEnd, declared);
    assert.equal(error.nonzeroInsideDeclaredSignature, true);
    assert.equal(error.nonzeroOutsideDeclaredSignature, true);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'inventoryCheck', 'allocatedSignatureBytes',
      'declaredSignatureBytes', 'indexedEnd', 'nonzeroInsideDeclaredSignature', 'nonzeroOutsideDeclaredSignature'].sort());
    return true;
  });
  bytes.writeUInt32BE(declared - 1, sig + 4);
  rejection(() => extract(bytes, ['arm64'])); // Indexed blob cannot extend into unused allocation.
});

test('pure extraction binds CDHash to complete SHA256 CodeDirectory and pages, never authenticates opaque CMS', () => {
  for (const version of [0x20400, 0x20500, 0x20600]) for (const page of [12, 14]) {
    const bytes = nativeFile({ version, page, team: true, extra: [[0x10000, blob(0xfade0b01, Buffer.from('NOT CMS'))]] });
    const result = extract(bytes, ['arm64']), cd = codeDirectory(bytes), expected = digest(cd);
    assert.equal(result.kind, 'unauthenticated-library-code-data'); assert.equal(result.productionAuthority, false);
    assert.equal(result.architectures[0].cdHash, expected.subarray(0, 20).toString('hex'));
    assert.equal(result.architectures[0].codeDirectorySHA256, expected.toString('hex'));
    assert.equal(result.architectures[0].signerAuthentication, 'unavailable');
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.architectures));
    const cms = sig + bytes.readUInt32BE(sig + 24); bytes[cms + 8] ^= 1;
    assert.equal(extract(bytes, ['arm64']).architectures[0].signerAuthentication, 'unavailable');
  }
});
test('actual private filesystem: content discovery, all files captured, symlink aliases dedup, executables excluded', t => {
  const f = tree(t);
  f.put('Contents/Resources/native.no-extension', nativeFile({ type: 8, id: 'addon' }));
  f.put('Contents/Resources/not-native.node', Buffer.from('ordinary JS resource'));
  f.put('Contents/Resources/embedded-magic.bin', Buffer.concat([Buffer.from('resource-prefix'), nativeFile()]));
  f.put('Contents/MacOS/Use Brian', nativeFile({ type: 2, signed: false }));
  f.put('Contents/Resources/computer-control/helper', nativeFile({ type: 2, id: 'helper', flags: 0x20002 }));
  f.put('Contents/Extensions/Brian Siri.appex/Contents/MacOS/Siri', nativeFile({ type: 2, id: 'siri' }));
  f.put('Contents/Resources/empty', Buffer.alloc(0));
  fs.symlinkSync('Versions/Current', join(f.framework, 'Alias'));
  const first = capture(f.root, options), second = capture(f.root, options);
  assert.equal(first.capturedTreeSHA256, second.capturedTreeSHA256);
  assert.equal(first.kind, 'captured-release-library-inventory-data');
  assert.equal(first.eligibleForAnchorStamping, false); assert.equal(first.productionAuthority, false);
  assert.equal(first.signerAuthentication, 'unavailable'); assert.equal(first.wholeProcessCompleteness, false);
  assert.equal(first.nonAppleClassification, 'unverified');
  assert.equal(first.capturedLinks, 3); assert.equal(first.capturedFiles, 8);
  assert.deepEqual(first.libraries.map(x => x.relativePath), [electron, 'Contents/Resources/native.no-extension']);
  assert.equal(first.excludedExecutables.length, 3);
  assert.ok(first.excludedExecutables.every(x => x.machType === 'MH_EXECUTE' && x.architectures.every(a => !Object.hasOwn(a, 'cdHash'))));
  assert.equal(first.candidateCDHashes.length, 2);
  assert.deepEqual([...first.candidateCDHashes].sort(), first.candidateCDHashes);
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.libraries)); assert.ok(Object.isFrozen(first.candidateCDHashes));
  assert.ok(!JSON.stringify(first).includes(f.temp));
  for (const candidate of [undefined, first, { ...first, signerAuthentication: true, eligibleForAnchorStamping: true }]) {
    assert.throws(() => requireApprovedBootstrapInventory(candidate), { code: 'ERR_MAC_BOOTSTRAP_INVENTORY_SIGNER_UNAVAILABLE' });
  }
});
test('resources starting MZ alone remain resources; native magic at offset zero is conservatively code', t => {
  const f = tree(t); f.put('Contents/Resources/text', Buffer.from('MZ is a benign string in a resource'));
  assert.equal(capture(f.root, options).libraries.length, 1);
  const java = Buffer.alloc(64); java.writeUInt32BE(0xcafebabe); java.writeUInt32BE(61, 4);
  f.put('Contents/Resources/test.class', java); rejection(() => capture(f.root, options));
});
for (const [kind, bytes] of [
  ['archive', Buffer.from('!<arch>\nordinary archive')], ['thin archive', Buffer.from('!<thin>\narchive')],
  ['ELF', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  ['PE', (() => { const b = Buffer.alloc(128); b.write('MZ'); b.writeUInt32LE(64, 60); b.write('PE\0\0', 64); return b; })()],
]) test(`fixed release profile rejects ${kind} by content`, t => {
  const f = tree(t); f.put('Contents/Resources/no-extension', bytes); rejection(() => capture(f.root, options));
});
test('exact library architecture set is trusted, never inferred; excludes executables without requiring their later signatures', t => {
  const f = tree(t, universal());
  const all = { architectures: ['x86_64', 'arm64'] };
  f.put('Contents/MacOS/helper', nativeFile({ type: 2, signed: false }));
  assert.equal(capture(f.root, all).candidateCDHashes.length, 2);
  rejection(() => capture(f.root, options));
  f.put('Contents/Resources/addon.node', nativeFile({ type: 8 })); rejection(() => capture(f.root, all));
  for (const expected of [[], ['arm64', 'arm64'], ['arm64e'], ['x86_64'], ['arm64', 'x86_64', 'arm64']]) rejection(() => extract(nativeFile(), expected));
  for (const wide of [false, true]) assert.equal(extract(universal(undefined, undefined, wide), ['arm64', 'x86_64']).architectures.length, 2);
});
test('arm64 package permits universal Siri only as an excluded executable, never as library pins', t => {
  const f = tree(t);
  const siri = 'Contents/Extensions/Brian Siri.appex/Contents/MacOS/Brian Siri';
  const arm = nativeFile({ type: 2, signed: false });
  const intel = nativeFile({ type: 2, cpu: 0x01000007, signed: false });
  const baseline = capture(f.root, options).candidateCDHashes;
  for (const wide of [false, true]) {
    f.put(siri, universal(arm, intel, wide));
    const result = capture(f.root, options);
    assert.deepEqual(result.candidateCDHashes, baseline);
    const excluded = result.excludedExecutables.find(file => file.relativePath === siri);
    assert.equal(excluded.machType, 'MH_EXECUTE');
    assert.deepEqual(excluded.architectures.map(slice => slice.architecture), ['arm64', 'x86_64']);
    assert.ok(excluded.architectures.every(slice => !Object.hasOwn(slice, 'cdHash')));
    rejection(() => extract(universal(arm, intel, wide), ['arm64']));
  }
  f.put(siri, intel); // An executable with no target-compatible slice still refuses.
  rejection(() => capture(f.root, options));
  f.put(siri, arm);
  for (const type of [6, 8]) {
    f.put('Contents/Frameworks/extra.dylib', universal(nativeFile({ type }), nativeFile({ type, cpu: 0x01000007 })));
    rejection(() => capture(f.root, options));
  }
  f.put(siri, universal(arm, nativeFile({ type: 6, cpu: 0x01000007 })));
  fs.rmSync(join(f.root, 'Contents/Frameworks/extra.dylib'));
  rejection(() => capture(f.root, options)); // Mixed executable/library slices remain invalid.
});

test('pinned physical Electron framework path must exist and be MH_DYLIB, not an alias or executable', t => {
  for (const bytes of [Buffer.from('resource'), nativeFile({ type: 2 }), nativeFile({ type: 8 })]) {
    const f = tree(t, bytes); rejection(() => capture(f.root, options));
  }
  const f = tree(t); fs.renameSync(f.path, join(dirname(f.path), 'Alternate'));
  fs.symlinkSync('Alternate', f.path); rejection(() => capture(f.root, options));
});
test('all embedded special slot blobs and exact external captured Info.plist/CodeResources are checked', t => {
  const info = Buffer.from('synthetic opaque plist'), resources = Buffer.from('synthetic opaque CodeResources');
  const b = nativeFile({ special: 11, external: { 1: info, 3: resources }, extra: [
    [2, blob(0xfade0c01, Buffer.alloc(4))], [5, blob(0xfade7171, Buffer.from('opaque XML'))],
    [7, blob(0xfade7172, Buffer.from('opaque DER'))], [8, blob(0xfade8181, Buffer.from('self'))],
    [9, blob(0xfade8181, Buffer.from('parent'))], [10, blob(0xfade8181, Buffer.from('responsible'))],
    [11, blob(0xfade8181, Buffer.from('library'))], [0x10000, blob(0xfade0b01, Buffer.from('NOT CMS'))],
  ] });
  rejection(() => extract(b, ['arm64']));
  assert.deepEqual(extract(b, ['arm64'], { 1: info, 3: resources }).architectures[0].externalSlotsChecked, [1, 3]);
  const f = tree(t, b), prefix = electron.slice(0, electron.lastIndexOf('/'));
  f.put(`${prefix}/Resources/Info.plist`, info); f.put(`${prefix}/_CodeSignature/CodeResources`, resources);
  fs.symlinkSync('Versions/Current/Resources', join(f.framework, 'Resources'));
  assert.equal(capture(f.root, options).libraries.length, 1);
  f.put(`${prefix}/Resources/Info.plist`, Buffer.from('different captured bytes')); rejection(() => capture(f.root, options));
  const mutated = Buffer.from(b); mutated[sig + mutated.readUInt32BE(sig + 24) + 8] ^= 1;
  rejection(() => extract(mutated, ['arm64'], { 1: info, 3: resources }));
});
test('loadable bundle sidecars are bound, loose dylibs cannot borrow parent bundle seals', t => {
  const f = tree(t), info = Buffer.from('info'), resources = Buffer.from('resources');
  const b = nativeFile({ type: 8, special: 3, external: { 1: info, 3: resources } });
  f.put('Contents/PlugIns/Add.bundle/Contents/MacOS/Add', b);
  f.put('Contents/PlugIns/Add.bundle/Contents/Info.plist', info);
  f.put('Contents/PlugIns/Add.bundle/Contents/_CodeSignature/CodeResources', resources);
  assert.equal(capture(f.root, options).libraries.length, 2);
  f.put('Contents/Resources/loose.node', b); f.put('Contents/Info.plist', info); f.put('Contents/_CodeSignature/CodeResources', resources);
  rejection(() => capture(f.root, options));
});
test('64 unique hashes boundary, dedup copies, no caller-provided positive approval receipts', t => {
  const f = tree(t);
  for (let i = 1; i < 64; i++) f.put(`Contents/Resources/${i}.data`, nativeFile({ id: `unique-${i}` }));
  assert.equal(capture(f.root, options).candidateCDHashes.length, 64);
  f.put('Contents/Resources/duplicate', nativeFile()); assert.equal(capture(f.root, options).candidateCDHashes.length, 64);
  f.put('Contents/Resources/extra', nativeFile({ id: 'unique-extra' })); rejection(() => capture(f.root, options));
});

test('root must be canonical fixed-product directory, not symlink/non-product/relative', t => {
  const f = tree(t), alias = join(f.temp, 'alias'); fs.symlinkSync(f.root, alias);
  for (const root of [alias, 'Use Brian.app', f.root + '/', join(f.temp, 'Other.app')]) rejection(() => capture(root, options));
  const parentAlias = join(f.temp, 'parent-link'); fs.symlinkSync(f.temp, parentAlias);
  rejection(() => capture(join(parentAlias, 'Use Brian.app'), options));
});
test('relative symlink aliases resolve internally; external/absolute/dangling escapes refuse', t => {
  for (const target of ['../../../outside', '/dev/null', 'missing', './missing']) {
    const f = tree(t); fs.symlinkSync(target, join(f.root, 'bad')); rejection(() => capture(f.root, options));
  }
  const f = tree(t); fs.symlinkSync(f.path, join(f.root, 'absolute-internal')); rejection(() => capture(f.root, options));
});
test('direct cycles, alias-directory graph cycles, root recursion and long alias chains refuse', t => {
  const a = tree(t); fs.symlinkSync('b', join(a.root, 'a')); fs.symlinkSync('a', join(a.root, 'b')); rejection(() => capture(a.root, options));
  const b = tree(t); b.put('A/item', 'x'); b.put('B/item', 'x');
  fs.symlinkSync('../B', join(b.root, 'A/toB')); fs.symlinkSync('../A', join(b.root, 'B/toA')); rejection(() => capture(b.root, options));
  const c = tree(t); c.put('A/item', 'x'); fs.symlinkSync('..', join(c.root, 'A/up')); rejection(() => capture(c.root, options));
  const d = tree(t);
  for (let i = 0; i < 33; i++) fs.symlinkSync(i === 32 ? electron : `link${i + 1}`, join(d.root, `link${i}`));
  rejection(() => capture(d.root, options));
});
test('ambiguous hardlinks, case aliases and noncanonical physical names refuse', t => {
  const hard = tree(t); fs.linkSync(hard.path, join(hard.root, 'hardlinked')); rejection(() => capture(hard.root, options));
  const outside = tree(t); fs.linkSync(outside.path, join(outside.temp, 'outside-link')); rejection(() => capture(outside.root, options));
  const names = ['bad\\name', 'trailing ', 'non-ASCII-λ'];
  for (const name of names) { const f = tree(t); f.put(name, 'resource'); rejection(() => capture(f.root, options)); }
  // Real case-sensitive host test only; insensitive hosts alias the same path.
  const f = tree(t); f.put('case', 'a'); f.put('CASE', 'b');
  if (fs.readdirSync(f.root).includes('case') && fs.readdirSync(f.root).includes('CASE')) rejection(() => capture(f.root, options));
});
test('real Unix-domain socket special file refuses (local filesystem endpoint, no network traffic)', async t => {
  // macOS's default /var/folders temp paths can exceed sockaddr_un's path bound.
  // Use a fresh PRIVATE directory under canonical /tmp for this one local test.
  const f = tree(t, nativeFile(), fs.realpathSync('/tmp')), server = createServer();
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(join(f.root, 'socket'), ok); });
  try { rejection(() => capture(f.root, options)); } finally { await new Promise(resolve => server.close(resolve)); }
});
test('all resource files and native rereads count toward lower-only limits', t => {
  const f = tree(t);
  for (const limits of [{ entries: 2 }, { directories: 1 }, { depth: 1 }, { pathBytes: 5 },
    { links: 1 }, { fileBytes: 8191 }, { totalReadBytes: 100 }]) rejection(() => capture(f.root, { ...options, limits }));
  f.put('Contents/Resources/addon.node', nativeFile({ type: 8 }));
  rejection(() => capture(f.root, { ...options, limits: { nativeFiles: 1 } }));
  rejection(() => capture(f.root, { ...options, limits: { cdHashes: 1 } }));
  for (const limits of [{ entries: 0 }, { entries: inventoryLimits.entries + 1 }, { deadlineMs: Infinity }, { unknown: 1 }]) rejection(() => capture(f.root, { ...options, limits }));
});
test('deadline failure after slow I/O cannot return a capture result', t => {
  const f = tree(t); let delayed = false;
  patched('readSync', original => (...args) => {
    const n = original(...args);
    if (!delayed) { delayed = true; const until = performance.now() + 80; while (performance.now() < until) { /* injected slow local I/O */ } }
    return n;
  }, () => rejection(() => capture(f.root, { ...options, limits: { deadlineMs: 50 } })));
});
test('legal short reads cannot hide leading Mach-O magic', t => {
  const f = tree(t);
  patched('readSync', original => (fd, b, off, length, position) => original(fd, b, off, Math.min(length, 2), position), () => {
    assert.equal(capture(f.root, options).libraries.length, 1);
  });
});

for (const event of ['in-place-write', 'replacement', 'symlink-replacement', 'ancestor-replacement', 'addition', 'alias-retarget']) {
  test(`actual private tree change detected: ${event}`, t => {
    const f = tree(t); let changed = false;
    const trigger = () => {
      if (changed) return; changed = true;
      if (event === 'in-place-write') { const b = fs.readFileSync(f.path); b[500] ^= 1; fs.writeFileSync(f.path, b); }
      if (event === 'replacement' || event === 'symlink-replacement') {
        const outside = join(f.temp, 'replacement'); fs.writeFileSync(outside, nativeFile());
        fs.renameSync(f.path, join(f.temp, 'original'));
        if (event === 'replacement') fs.copyFileSync(outside, f.path); else fs.symlinkSync(outside, f.path);
      }
      if (event === 'ancestor-replacement') {
        const outside = join(f.temp, 'outside-dir'); fs.mkdirSync(outside); fs.writeFileSync(join(outside, 'Electron Framework'), nativeFile());
        fs.renameSync(dirname(f.path), join(f.temp, 'original-dir')); fs.symlinkSync(outside, dirname(f.path));
      }
      if (event === 'addition') fs.writeFileSync(join(f.root, 'new-resource'), 'new');
      if (event === 'alias-retarget') { const alias = join(f.framework, 'Versions/Current'); fs.unlinkSync(alias); fs.symlinkSync('missing', alias); }
    };
    patched('readSync', original => (...args) => { const n = original(...args); if (n > 0) trigger(); return n; }, () => rejection(() => capture(f.root, options)));
    assert.equal(changed, true);
  });
}
test('candidate reread is bound to initial file digest even if stat checks were insufficient', t => {
  const f = tree(t); let opened = 0;
  patched('openSync', originalOpen => (path, flags, ...rest) => {
    const fd = originalOpen(path, flags, ...rest);
    if (path === f.path && ++opened === 2) {
      // Inject changed read bytes only on the candidate pass, with unchanged fd
      // metadata. This tests the independent content binding, not an OS race.
      const originalRead = fs.readSync;
      fs.readSync = (...args) => { const n = originalRead(...args); if (args[0] === fd && n > 500) args[1][args[2] + 500] ^= 1; return n; };
    }
    return fd;
  }, () => {
    const originalRead = fs.readSync;
    try { rejection(() => capture(f.root, options)); } finally { fs.readSync = originalRead; }
  });
  assert.equal(opened, 2);
});
test('owned file/directory descriptors close on success and every bounded failure', t => {
  const f = tree(t), opened = new Set();
  patched('openSync', original => (...args) => { const fd = original(...args); opened.add(fd); return fd; }, () => {
    patched('closeSync', original => fd => { const r = original(fd); opened.delete(fd); return r; }, () => {
      capture(f.root, options); assert.equal(opened.size, 0);
      for (const limits of [{ entries: 2 }, { fileBytes: 1 }, { totalReadBytes: 100 }, { links: 1 }]) {
        rejection(() => capture(f.root, { ...options, limits })); assert.equal(opened.size, 0);
      }
    });
  });
});

const changes = {
  magic: b => b.writeUInt32LE(0xfeedface), type: b => b.writeUInt32LE(1, 12), cpu: b => b.writeUInt32LE(7, 4), subtype: b => b.writeUInt32LE(2, 8),
  reserved: b => b[28] = 1, commandCount: b => b.writeUInt32LE(2, 16), commandBytes: b => b.writeUInt32LE(0xffffffff, 20),
  unknownCommand: b => b.writeUInt32LE(0x12345678, 32), badCommandSize: b => b.writeUInt32LE(71, 36),
  segmentOverlap: b => b.writeBigUInt64LE(0n, 144), vmOverlap: b => b.writeBigUInt64LE(0n, 128),
  segmentOverflow: b => b.writeBigUInt64LE(2n ** 63n, 144), sectionTable: b => b.writeUInt32LE(1, 96),
  signatureBeforeHeader: b => b.writeUInt32LE(0, 184), signatureExtent: b => b.writeUInt32LE(1, 188),
  unsignedTrailingData: b => { const end = b.readUInt32BE(sig + 4); b[sig + end] = 1; b.writeUInt32BE(end + 1, sig + 4); },
  containerMagic: b => b.writeUInt32BE(0xfade0cc1, sig),
  containerLength: b => b.writeUInt32BE(0xffffffff, sig + 4), count: b => b.writeUInt32BE(66, sig + 8),
  alternateCD: b => b.writeUInt32BE(0x1000, sig + 12), unknownSlot: b => b.writeUInt32BE(99, sig + 12),
  componentOverlap: b => b.writeUInt32BE(12, sig + 16), componentOverflow: b => b.writeUInt32BE(0xffffffff, sig + 16),
};
for (const [name, mutate] of Object.entries(changes)) test(`synthetic Mach-O negative: ${name}`, () => {
  const b = nativeFile(); mutate(b); rejection(() => extract(b, ['arm64']));
});
const cdChanges = {
  version: cd => cd.writeUInt32BE(0x20700, 8), old: cd => cd.writeUInt32BE(0x20300, 8),
  SHA1: cd => cd[37] = 1, SHA256truncated: cd => cd[37] = 3, SHA384: cd => cd[37] = 4,
  width: cd => cd[36] = 20, platform: cd => cd[38] = 1, page: cd => cd[39] = 0,
  scatter: cd => cd.writeUInt32BE(88, 44), spare2: cd => cd[40] = 1, spare3: cd => cd[52] = 1,
  codeLimit64: cd => cd.writeBigUInt64BE(4096n, 56), flags: cd => cd.writeUInt32BE(0x80000000, 12),
  hashOffset: cd => cd.writeUInt32BE(0xffffffff, 16), hashOverlap: cd => cd.writeUInt32BE(4, 16),
  special: cd => cd.writeUInt32BE(12, 24), pages: cd => cd.writeUInt32BE(0xffffffff, 28), limit: cd => cd.writeUInt32BE(2048, 32),
  identifier: cd => cd.writeUInt32BE(1, 20), teamAlias: cd => cd.writeUInt32BE(cd.readUInt32BE(20), 48),
  execRange: cd => cd.writeBigUInt64BE(8192n, 72), execFlags: cd => cd.writeBigUInt64BE(0x400n, 80),
  preEncrypt: cd => cd.writeUInt32BE(1, 92),
};
for (const [name, mutate] of Object.entries(cdChanges)) test(`synthetic CodeDirectory negative: ${name}`, () => {
  const b = nativeFile(); mutate(codeDirectory(b)); rejection(() => extract(b, ['arm64']));
});
test('all code pages, including header mapping, are checked; duplicate components/unknown special data refuse', () => {
  for (const at of [24, 400, 4095]) { const b = nativeFile(); b[at] ^= 1; rejection(() => extract(b, ['arm64'])); }
  const unknownSpecial = nativeFile({ special: 6 }); const cd = codeDirectory(unknownSpecial); cd[cd.readUInt32BE(16) - 6 * 32] = 1;
  rejection(() => extract(unknownSpecial, ['arm64']));
  const duplicate = nativeFile({ extra: [[0, blob(0xfade0c02, Buffer.alloc(100))]] }); rejection(() => extract(duplicate, ['arm64']));
  const overlap = nativeFile({ extra: [[0x10000, blob(0xfade0b01)]] }); overlap.writeUInt32BE(overlap.readUInt32BE(sig + 16), sig + 24);
  rejection(() => extract(overlap, ['arm64']));
  for (const field of [96, 100, 104]) { const b = nativeFile({ version: 0x20600 }); codeDirectory(b)[field] = 1; rejection(() => extract(b, ['arm64'])); }
});
test('fat unknown/duplicate/mixed-type/overlap/truncated slices refuse', () => {
  rejection(() => extract(universal(nativeFile(), nativeFile()), ['arm64', 'x86_64']));
  rejection(() => extract(universal(nativeFile(), nativeFile({ cpu: 0x01000007, type: 2 })), ['arm64', 'x86_64']));
  for (const wide of [false, true]) {
    const b = universal(undefined, undefined, wide), stride = wide ? 32 : 20;
    for (const change of [
      x => x.writeUInt32BE(3, 4), x => x.writeUInt32BE(7, 8), x => x.writeUInt32BE(31, 8 + (wide ? 24 : 16)),
      x => wide ? x.writeBigUInt64BE(16384n, 16 + stride) : x.writeUInt32BE(16384, 16 + stride),
      x => wide ? x.writeBigUInt64BE(2n ** 63n, 16) : x.writeUInt32BE(0xffffffff, 16),
    ]) { const changed = Buffer.from(b); change(changed); rejection(() => extract(changed, ['arm64', 'x86_64'])); }
    if (wide) { const changed = Buffer.from(b); changed.writeUInt32BE(1, 36); rejection(() => extract(changed, ['arm64', 'x86_64'])); }
    for (const n of [32, 64, 16384, 16400, 32768, b.length - 1]) rejection(() => extract(b.subarray(0, n), ['arm64', 'x86_64']));
  }
});
test('every truncated synthetic file, no signer slot, and bounded deterministic mutation corpus are honest DATA tests', () => {
  const original = nativeFile();
  for (let n = 0; n < original.length; n++) rejection(() => extract(original.subarray(0, n), ['arm64']));
  rejection(() => extract(nativeFile({ signed: false }), ['arm64']));
  let seed = 0x12345678;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 500; i++) {
    const b = Buffer.from(original); b[next() % b.length] ^= 1 << (next() % 8);
    // Not every CodeDirectory mutation is malformed: no CMS authentication is
    // claimed. Accepted data must STILL remain explicitly unauthenticated.
    try { assert.equal(extract(b, ['arm64']).productionAuthority, false); }
    catch (e) { assert.equal(e.code, 'ERR_MAC_BOOTSTRAP_INVENTORY'); }
  }
});
test('data-only API rejects caller accessors/proxies/shared backing without running hooks or exposing errors', t => {
  const f = tree(t); let called = 0;
  const hook = () => { called++; throw new Error('/private/path secret'); };
  const o = { ...options }; Object.defineProperty(o, 'architectures', { get: hook }); rejection(() => capture(f.root, o));
  const proxy = new Proxy(options, { ownKeys: hook, get: hook, getPrototypeOf: hook }); rejection(() => capture(f.root, proxy));
  const b = nativeFile(); for (const name of ['length', 'buffer', 'valueOf', Symbol.iterator]) Object.defineProperty(b, name, { get: hook });
  assert.equal(extract(b, ['arm64']).productionAuthority, false);
  const shared = Buffer.from(new SharedArrayBuffer(8192)); nativeFile().copy(shared); Object.defineProperty(shared, 'buffer', { get: hook });
  rejection(() => extract(shared, ['arm64'])); assert.equal(called, 0);
});

test('post-capture modification of an ordinary resource is detected by the final manifest check', t => {
  const f = tree(t), resource = f.put('Contents/Resources/ordinary.txt', 'before');
  let opens = 0, target, changed = false;
  patched('openSync', original => (path, ...args) => {
    const fd = original(path, ...args);
    if (path === f.path && ++opens === 2) target = fd;
    return fd;
  }, () => patched('closeSync', original => fd => {
    const result = original(fd);
    if (fd === target && !changed) { changed = true; target = undefined; fs.writeFileSync(resource, 'after!'); }
    return result;
  }, () => rejection(() => capture(f.root, options))));
  assert.equal(changed, true);
});
test('all held directories are closed even if a close operation reports an error', t => {
  const f = tree(t), directoryFDs = new Set(); let injected = false;
  patched('openSync', original => (path, flags, ...args) => {
    const fd = original(path, flags, ...args); if (flags & fs.constants.O_DIRECTORY) directoryFDs.add(fd); return fd;
  }, () => patched('closeSync', original => fd => {
    const wasDirectory = directoryFDs.delete(fd), result = original(fd);
    if (wasDirectory && !injected) { injected = true; throw new Error('PRIVATE close diagnostic'); }
    return result;
  }, () => rejection(() => capture(f.root, options))));
  assert.equal(injected, true); assert.equal(directoryFDs.size, 0);
});
function withSection() {
  const b = nativeFile();
  b.copy(b, 184, 104, 192); b.fill(0, 104, 184);
  b.writeUInt32LE(152, 36); b.writeUInt32LE(1, 96); b.writeUInt32LE(240, 20);
  b.write('__const', 104); b.write('__TEXT', 120);
  b.writeBigUInt64LE(1024n, 136); b.writeBigUInt64LE(128n, 144); b.writeUInt32LE(1024, 152); b.writeUInt32LE(4, 156);
  return rehash(b);
}
test('section mapping and duplicate/overlap guards do not rely solely on stale page hashes', () => {
  assert.equal(extract(withSection(), ['arm64']).machType, 'MH_DYLIB');
  for (const mutate of [
    b => b[120] = 65, b => b.writeBigUInt64LE(8192n, 136), b => b.writeBigUInt64LE(4096n, 144),
    b => b.writeUInt32LE(1032, 152), b => b.writeUInt32LE(32, 156), b => b.writeUInt32LE(0xff, 168),
    b => b.writeUInt32LE(0x01000000, 168),
  ]) { const b = withSection(); mutate(b); rehash(b); rejection(() => extract(b, ['arm64'])); }
  for (const renamed of [false, true]) {
    const b = withSection(); b.copy(b, 264, 184, 272); b.copy(b, 184, 104, 184);
    b.writeUInt32LE(232, 36); b.writeUInt32LE(2, 96); b.writeUInt32LE(320, 20);
    if (renamed) { b.fill(0, 184, 200); b.write('__alias', 184); }
    rehash(b); rejection(() => extract(b, ['arm64']));
  }
});
test('multiple code pages and a partial final page are all checked', () => {
  // Independent synthetic reconstruction with a new codeLimit; not native data.
  const original = nativeFile(), cd = Buffer.concat([codeDirectory(original), Buffer.alloc(64)]), limit = 9008;
  cd.writeUInt32BE(cd.length, 4); cd.writeUInt32BE(3, 28); cd.writeUInt32BE(limit, 32);
  const b = Buffer.alloc(limit + 4096); original.copy(b, 0, 0, sig);
  b.writeBigUInt64LE(BigInt(limit), 64); b.writeBigUInt64LE(BigInt(limit), 80);
  b.writeBigUInt64LE(BigInt(limit), 128); b.writeBigUInt64LE(BigInt(limit), 144); b.writeUInt32LE(limit, 184);
  const hashOffset = cd.readUInt32BE(16);
  for (let i = 0; i < 3; i++) digest(b.subarray(i * 4096, Math.min((i + 1) * 4096, limit))).copy(cd, hashOffset + i * 32);
  const sb = b.subarray(limit); sb.writeUInt32BE(0xfade0cc0); sb.writeUInt32BE(20 + cd.length, 4); sb.writeUInt32BE(1, 8); sb.writeUInt32BE(20, 16); cd.copy(sb, 20);
  assert.equal(extract(b, ['arm64']).architectures[0].codeDirectorySHA256, digest(cd).toString('hex'));
  for (const at of [400, 5000, 9007]) { const changed = Buffer.from(b); changed[at] ^= 1; rejection(() => extract(changed, ['arm64'])); }
});
test('module is an explicit data-only scanner, not a signer/CLI/production integration', () => {
  const source = fs.readFileSync(new URL('./mac-bootstrap-inventory.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:child_process|process\.env|process\.argv/);
  assert.match(source, /eligibleForAnchorStamping: false/);
  assert.match(source, /signerAuthentication: 'unavailable'/);
  assert.throws(() => requireApprovedBootstrapInventory({ verified: true, cmsVerified: true, trustedTeam: 'FAKETEAM00' }),
    { code: 'ERR_MAC_BOOTSTRAP_INVENTORY_SIGNER_UNAVAILABLE' });
});

// Isolated source-injected backend: private factory/data flow ONLY, not CMS or
// macOS acceptance. Production exposes no injection callback or environment flag.
async function factoryFixture(body = '', bootstrapBody) {
  const source = fs.readFileSync(new URL('./mac-bootstrap-inventory.mjs', import.meta.url), 'utf8');
  const line = "import { verifyCapturedLibrariesNative } from './mac-bootstrap-inventory-verifier.mjs';";
  assert.ok(source.includes(line));
  const replacement = `export const testTrace = []; const verifyCapturedLibrariesNative = async context => {
    testTrace.push(context); ${body}
    return Object.freeze({ kind: 'native-static-signature-response-data', requestSHA256: 'ab'.repeat(32),
      libraries: context.libraries.length, slices: context.libraries.reduce((n,l) => n+l.architectures.length,0) }); };`;
  let isolated = source.replace(line, replacement);
  if (bootstrapBody !== undefined) isolated = isolated.replace(
    "import { verifyMacBootstrap } from './electron-fuses.mjs';",
    `export const bootstrapTrace = []; const verifyMacBootstrap = async appRoot => { bootstrapTrace.push(appRoot); ${bootstrapBody} };`);
  isolated = isolated.replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, import.meta.url).href}'`);
  return import(`data:text/javascript,${encodeURIComponent(isolated)}#${Math.random()}`);
}
const verificationRejected = { code: 'ERR_MAC_BOOTSTRAP_INVENTORY_VERIFICATION', message: 'Captured release signing verification unavailable, changed, or refused' };
test('real non-Darwin verified-inventory API refuses without a fake boolean fallback', { skip: process.platform === 'darwin' }, async t => {
  const f = tree(t), c = capture(f.root, options);
  await assert.rejects(requireVerifiedCapturedInventory(c, { teamIdentifier: 'ABCDEFGHIJ' }), verificationRejected);
});
test('isolated factory: private capture plus backend success produces immutable scoped receipt, never final approval', async t => {
  const f = tree(t, universal()), api = await factoryFixture();
  f.put('Contents/MacOS/Use Brian', nativeFile({ type: 2, signed: false }));
  const c = api.captureReleaseLibraryInventoryData(f.root, { architectures: ['arm64', 'x86_64'] });
  for (const fake of [undefined, { ...c }, JSON.parse(JSON.stringify(c)), new Proxy(c, {}), { ...c, verified: true }])
    await assert.rejects(api.requireVerifiedCapturedInventory(fake, { teamIdentifier: 'ABCDEFGHIJ' }), verificationRejected);
  assert.equal(api.testTrace.length, 0);
  const result = await api.requireVerifiedCapturedInventory(c, { teamIdentifier: 'ABCDEFGHIJ' });
  assert.equal(api.testTrace.length, 1); const sent = api.testTrace[0];
  assert.equal(sent.libraries.length, 1); assert.equal(sent.libraries[0].fileSize, fs.statSync(f.path).size);
  assert.equal(sent.libraries[0].fileSHA256, c.libraries[0].fileSHA256);
  assert.equal(sent.libraries[0].architectures[1].codeDirectorySHA256, c.libraries[0].architectures[1].codeDirectorySHA256);
  assert.equal(sent.teamIdentifier, 'ABCDEFGHIJ'); assert.equal(result.signerAuthentication, 'offline-static-developer-id-application');
  for (const field of ['eligibleForAnchorStamping', 'productionAuthority', 'wholeProcessCompleteness', 'onlineRevocationProven', 'notarizationProven', 'atomicSnapshot']) assert.equal(result[field], false);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.libraries[0].architectures[0])); assert.ok(Object.isFrozen(result.cmsCheckedCDHashes));
  assert.ok(!JSON.stringify(result).includes(f.temp)); assert.equal(result.excludedExecutables.length, 1);
  await assert.rejects(api.requireApprovedBootstrapInventory(result), { code: 'ERR_MAC_BOOTSTRAP_INVENTORY_SIGNER_UNAVAILABLE' });
  await assert.rejects(api.requireVerifiedCapturedInventory(result, { teamIdentifier: 'ABCDEFGHIJ' }), verificationRejected);
});
test('isolated factory rejects getters, bad team, extra authority fields and callbacks without calling backend', async t => {
  const f = tree(t), api = await factoryFixture(), c = api.captureReleaseLibraryInventoryData(f.root, options); let hits = 0;
  for (const context of [{ get teamIdentifier() { hits++; return 'ABCDEFGHIJ'; } }, { teamIdentifier: 'abcdefghij' },
    { teamIdentifier: 'ABCDEFGHIJ', verified: true }, { teamIdentifier: 'ABCDEFGHIJ', verifier() { hits++; } },
    new Proxy({}, { ownKeys() { hits++; return []; } })])
    await assert.rejects(api.requireVerifiedCapturedInventory(c, context), verificationRejected);
  assert.equal(hits, 0); assert.equal(api.testTrace.length, 0);
});
test('isolated factory detects stale capture and resource mutation during verification', async t => {
  const f = tree(t), resource = f.put('Contents/Resources/policy.js', Buffer.from('old'));
  const api = await factoryFixture(`fs.writeFileSync(${JSON.stringify(resource)}, 'new');`), c = api.captureReleaseLibraryInventoryData(f.root, options);
  await assert.rejects(api.requireVerifiedCapturedInventory(c, { teamIdentifier: 'ABCDEFGHIJ' }), verificationRejected); assert.equal(api.testTrace.length, 1);
  await assert.rejects(api.requireVerifiedCapturedInventory(c, { teamIdentifier: 'ABCDEFGHIJ' }), verificationRejected); assert.equal(api.testTrace.length, 1);
});
test('isolated factory normalizes private errors, never retries, rejects partial counts', async t => {
  const f = tree(t);
  for (const body of ["throw Error('PRIVATE_PATH_HASH');", "return {kind:'native-static-signature-response-data',libraries:0,slices:0,requestSHA256:'ab'.repeat(32)};",
    "return {kind:'native-static-signature-response-data',libraries:1,slices:1,requestSHA256:'ab'.repeat(32),verified:true};"]) {
    const api = await factoryFixture(body), c = api.captureReleaseLibraryInventoryData(f.root, options);
    await assert.rejects(api.requireVerifiedCapturedInventory(c, { teamIdentifier: 'ABCDEFGHIJ' }), verificationRejected); assert.equal(api.testTrace.length, 1);
  }
});

const approvalRejected = { code: 'ERR_MAC_BOOTSTRAP_INVENTORY_SIGNER_UNAVAILABLE' };
const approvalDictionary = { 'Resources/app.asar': { algorithm: 'SHA256', hash: 'ab'.repeat(32) } };
const goodBootstrap = `return ${JSON.stringify({ ElectronAsarIntegrity: approvalDictionary })};`;
async function checked(api, f, opts = options) {
  return api.requireVerifiedCapturedInventory(api.captureReleaseLibraryInventoryData(f.root, opts), { teamIdentifier: 'ABCDEFGHIJ' });
}
test('stage approval composes exactly three anchor keys from private CMS hashes and bootstrap info', async t => {
  const f = tree(t, universal()), api = await factoryFixture('', goodBootstrap);
  const paths = [
    ...['libEGL.dylib', 'libGLESv2.dylib', 'libffmpeg.dylib', 'libvk_swiftshader.dylib']
      .map(n => `Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/${n}`),
    ...['Mantle', 'ReactiveObjC', 'Squirrel'].map(n => `Contents/Frameworks/${n}.framework/Versions/A/${n}`),
  ];
  for (const path of paths) f.put(path, universal(nativeFile({ id: path }), nativeFile({ id: path, cpu: 0x01000007 })));
  f.put('Contents/MacOS/Use Brian', nativeFile({ type: 2, signed: false }));
  f.put('Contents/Resources/computer-control/brian-native-computer-helper', nativeFile({ type: 2, signed: false }));
  f.put('Contents/Resources/computer-control/NativeComputerFixture.app/Contents/MacOS/NativeComputerFixture', nativeFile({ type: 2, signed: false }));
  const receipt = await checked(api, f, { architectures: ['arm64', 'x86_64'] });
  const data = await api.requireApprovedBootstrapInventory(receipt);
  assert.deepEqual(Object.keys(data).sort(), ['asarDigest', 'electronVersion', 'libraryCDHashes']);
  assert.equal(data.electronVersion, '43.2.0');
  assert.deepEqual(data.asarDigest, integrityDictionaryDigest(approvalDictionary));
  assert.deepEqual(data.libraryCDHashes.map(b => b.toString('hex')), receipt.cmsCheckedCDHashes);
  assert.equal(encodeBootstrapApprovalRecord(data).length, 1376);
  assert.deepEqual(api.bootstrapTrace, [f.root]);
  assert.equal(receipt.productionAuthority, false); assert.equal(receipt.wholeProcessCompleteness, false);
  data.asarDigest.fill(0); data.libraryCDHashes[0].fill(0);
  const again = await api.requireApprovedBootstrapInventory(receipt);
  assert.deepEqual(again.asarDigest, integrityDictionaryDigest(approvalDictionary));
  assert.deepEqual(again.libraryCDHashes.map(b => b.toString('hex')), receipt.cmsCheckedCDHashes);
});
test('stage approval synchronously rejects fake, cloned, proxied and other-module receipts', async t => {
  const f = tree(t), api = await factoryFixture('', goodBootstrap), other = await factoryFixture('', goodBootstrap);
  const receipt = await checked(api, f);
  for (const fake of [null, undefined, true, {}, { ...receipt }, JSON.parse(JSON.stringify(receipt)),
    new Proxy(receipt, {}), await checked(other, f), { verified: true }, api.captureReleaseLibraryInventoryData(f.root, options)])
    assert.throws(() => api.requireApprovedBootstrapInventory(fake), approvalRejected);
  assert.deepEqual(api.bootstrapTrace, []);
});
test('stage approval refuses unreviewed physical libraries, wrong roles, addons and .node aliases', async t => {
  for (const [path, bytes] of [
    ['Contents/Resources/native', nativeFile()], ['Contents/Resources/executable', nativeFile({ type: 2 })], ['Contents/Resources/addon.node', nativeFile({ type: 8 })],
    ['Contents/Resources/not-native.node', Buffer.from('JS')],
    ['Contents/Frameworks/Other.framework/Versions/A/Other', nativeFile()],
    ['Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/new.dylib', nativeFile()],
    ['Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib', nativeFile({ type: 8 })],
    ['Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib', nativeFile({ type: 2 })],
  ]) {
    const f = tree(t), api = await factoryFixture('', goodBootstrap); f.put(path, bytes);
    await assert.rejects(api.requireApprovedBootstrapInventory(await checked(api, f)), approvalRejected);
    assert.deepEqual(api.bootstrapTrace, []);
  }
  const f = tree(t), api = await factoryFixture('', goodBootstrap);
  fs.symlinkSync('Versions/A/Electron Framework', join(f.framework, 'alias.node'));
  await assert.rejects(api.requireApprovedBootstrapInventory(await checked(api, f)), approvalRejected);
});
test('stage approval rechecks stale resources and additions before bootstrap and mutations after it', async t => {
  for (const mode of ['stale', 'addition', 'during']) {
    const f = tree(t), resource = f.put('Contents/Resources/policy.js', 'before');
    const api = await factoryFixture('', (mode === 'during' ? `fs.writeFileSync(${JSON.stringify(resource)}, 'after!');` : '') + goodBootstrap);
    const receipt = await checked(api, f);
    if (mode === 'stale') fs.writeFileSync(resource, 'after!');
    if (mode === 'addition') f.put('Contents/Resources/new', 'new');
    await assert.rejects(api.requireApprovedBootstrapInventory(receipt), approvalRejected);
    assert.equal(api.bootstrapTrace.length, mode === 'during' ? 1 : 0);
  }
});
test('stage approval fails closed on bootstrap/version refusal and invalid integrity data', async t => {
  for (const body of ["throw Error('unsafe fuse');", "throw Error('unsupported Electron version');",
    "throw Error('ASAR header hash mismatch');", "throw Error('page hash mismatch');", 'return {};',
    "return {ElectronAsarIntegrity: {}};"]) {
    const f = tree(t), api = await factoryFixture('', body);
    await assert.rejects(api.requireApprovedBootstrapInventory(await checked(api, f)), approvalRejected);
    assert.deepEqual(api.bootstrapTrace, [f.root]);
  }
});
