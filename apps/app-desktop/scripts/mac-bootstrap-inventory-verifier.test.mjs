import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { encodeVerifierRequest, consumeVerifierChild, verifyCapturedLibrariesNative } from './mac-bootstrap-inventory-verifier.mjs';
import { extractMachOLibraryData, canonicalElectronLibrary } from './mac-bootstrap-inventory.mjs';
import { nativeFile, universal } from './mac-bootstrap-inventory.test-fixtures.mjs';
const hash = b => createHash('sha256').update(b).digest();
function context(bytes = nativeFile()) {
  const architectures = bytes.readUInt32BE(0) === 0xcafebabe ? ['arm64', 'x86_64'] : ['arm64'];
  const parsed = extractMachOLibraryData(bytes, architectures);
  return { appRoot: '/private/release/Use Brian.app', teamIdentifier: 'ABCDEFGHIJ', architectures, capturedTreeSHA256: '12'.repeat(32),
    libraries: [{ relativePath: canonicalElectronLibrary, fileSize: bytes.length, fileSHA256: hash(bytes).toString('hex'),
      architectures: parsed.architectures.map(a => ({ architecture: a.architecture, sliceOffset: a.sliceOffset, sliceSize: a.sliceSize,
        cdHash: a.cdHash, codeDirectorySHA256: a.codeDirectorySHA256 })) }] };
}
function success(encoded) {
  const b = Buffer.alloc(88); b.write('BRINVRES'); b.writeUInt16BE(1, 8); b.writeUInt16BE(88, 10);
  b.writeUInt16BE(encoded.libraries, 16); b.writeUInt16BE(encoded.slices, 18); hash(encoded.request).copy(b, 24); encoded.request.copy(b, 56, 32, 64); return b;
}
function child() {
  const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.unref = () => { c.unreferenced = true; };
  c.input = []; c.stdin = new Writable({ write(b, encoding, next) { c.input.push(Buffer.from(b)); next(); } }); return c;
}
const refused = { code: 'ERR_MAC_BOOTSTRAP_NATIVE_VERIFIER', message: 'Native release signing verification unavailable or refused' };
test('canonical binary request: complete digests, exact architecture set, canonical framework target/version, fresh nonce', () => {
  const a = encodeVerifierRequest(context(universal())), b = encodeVerifierRequest(context(universal()));
  assert.equal(a.request.readUInt32BE(12), a.request.length); assert.equal(a.request[18], 3); assert.equal(a.libraries, 1); assert.equal(a.slices, 2);
  assert.notDeepEqual(a.request.subarray(32, 64), b.request.subarray(32, 64));
  const start = 96 + a.request.readUInt16BE(20), leaf = a.request.readUInt16BE(start + 4), target = a.request.readUInt16BE(start + 6);
  assert.equal(a.request[start + 11], 1); assert.equal(a.request.subarray(start + 52 + leaf, start + 52 + leaf + target).toString(), 'Contents/Frameworks/Electron Framework.framework');
  assert.equal(a.request[start + 52 + leaf + target], 65);
});
for (const [name, mutate] of [
  ['root alias', c => { c.appRoot = '/private/release/../release/Use Brian.app'; }],
  ['root NUL', c => { c.appRoot = '/private/\0/Use Brian.app'; }],
  ['team injection', c => { c.teamIdentifier = 'BAD\"TEAM!!'; }],
  ['team case', c => { c.teamIdentifier = 'abcdefghij'; }],
  ['unknown field', c => { c.verified = true; }],
  ['missing arch', c => { c.architectures.push('x86_64'); }],
  ['duplicate arch', c => { c.architectures.push('arm64'); }],
  ['unknown arch', c => { c.architectures = ['arm64e']; }],
  ['execute fields', c => { c.libraries[0].machType = 'MH_EXECUTE'; }],
  ['relative traversal', c => { c.libraries[0].relativePath = '../library'; }],
  ['file size', c => { c.libraries[0].fileSize = 512 * 1024 ** 2 + 1; }],
  ['duplicate leaf', c => { c.libraries.push(c.libraries[0]); }],
  ['offset INT_MAX overflow', c => { c.libraries[0].architectures[0].sliceOffset = 0x80000000; }],
  ['CDF prefix mismatch', c => { c.libraries[0].architectures[0].codeDirectorySHA256 = 'ff'.repeat(32); }],
  ['fractional offset', c => { c.libraries[0].architectures[0].sliceOffset = 0.5; }],
  ['oversized slice', c => { c.libraries[0].architectures[0].sliceSize++; }],
]) test(`request refuses ${name}`, () => { const c = context(); mutate(c); assert.throws(() => encodeVerifierRequest(c), refused); });
test('hostile input proxies/accessors never invoked', () => {
  let hits = 0; const c = context(); Object.defineProperty(c, 'teamIdentifier', { get() { hits++; throw Error('private'); } });
  assert.throws(() => encodeVerifierRequest(c), refused);
  assert.throws(() => encodeVerifierRequest(new Proxy({}, { ownKeys() { hits++; throw Error('private'); } })), refused); assert.equal(hits, 0);
});
test('pipe protocol only succeeds at actual close, not exit; stdin is exact bytes plus EOF', async () => {
  const e = encodeVerifierRequest(context()), c = child(); let settled = false;
  const result = consumeVerifierChild(c, e).then(x => { settled = true; return x; });
  const b = success(e); for (const byte of b) c.stdout.write(Buffer.from([byte]));
  c.emit('exit', 0, null); await Promise.resolve(); assert.equal(settled, false); assert.ok(c.stdin.writableEnded);
  assert.deepEqual(Buffer.concat(c.input), e.request); c.emit('close', 0, null);
  assert.equal((await result).requestSHA256, hash(e.request).toString('hex')); assert.equal(settled, true);
});
for (const [name, mutate, code, signal, stderr] of [
  ['nonzero status', b => b, 1, null], ['signal', b => b, null, 'SIGTERM'], ['missing status', b => b, undefined, null],
  ['missing signal', b => b, 0, undefined], ['short output', b => b.subarray(0, 87), 0, null],
  ['trailing output', b => Buffer.concat([b, Buffer.alloc(1)]), 0, null], ['text output', () => Buffer.from('verified=true'), 0, null],
  ['stderr on success', b => b, 0, null, Buffer.from('private error')],
  ...[0, 8, 10, 12, 16, 18, 20, 24, 56, 87].map(i => [`modified response byte ${i}`, b => { b[i] ^= 1; return b; }, 0, null]),
]) test(`pipe refuses ${name} with private normalized failure`, async () => {
  const e = encodeVerifierRequest(context()), c = child(), p = consumeVerifierChild(c, e), rejected = assert.rejects(p, refused);
  c.stdout.write(mutate(success(e))); if (stderr) c.stderr.write(stderr); c.emit('close', code, signal); await rejected;
});
for (const which of ['error', 'stdin', 'stdout', 'stderr']) test(`child ${which} failure cannot become a successful receipt`, async () => {
  const e = encodeVerifierRequest(context()), c = child(), p = consumeVerifierChild(c, e), rejected = assert.rejects(p, refused);
  (which === 'error' ? c : c[which]).emit('error', Error('PRIVATE_PATH_HASH')); c.stdout.write(success(e)); c.emit('close', 0, null); await rejected;
});
test('nonce/request digest prevents stale response replay', async () => {
  const old = encodeVerifierRequest(context()), fresh = encodeVerifierRequest(context()), c = child();
  const rejected = assert.rejects(consumeVerifierChild(c, fresh), refused); c.stdout.write(success(old)); c.emit('close', 0, null); await rejected;
});
// Isolated CODE EXTRACTION changes ONLY deadlines/tool literal for tests. Never a
// production environment switch, callback, alternate verifier path or fake Mac claim.
async function isolated(extra = '') {
  let text = fs.readFileSync(new URL('./mac-bootstrap-inventory-verifier.mjs', import.meta.url), 'utf8');
  text = text.replace(/const tool = fileURLToPath\(new URL\([^\n]+\);/, "const tool = '/does-not-exist-inventory-test/verifier';");
  text = text.replace('deadlineMs: 120000, closeGraceMs: 2000', 'deadlineMs: 5, closeGraceMs: 5');
  if (extra) text = text.replace("process.platform !== 'darwin'", 'false').replace('process.getuid() === 0', 'false');
  return import(`data:text/javascript,${encodeURIComponent(text)}#${extra}`);
}
test('timeout without close refuses, destroys private pipes; known exit prevents group signals', async () => {
  const mod = await isolated(), c = child(); c.pid = 123456;
  const original = process.kill; let signals = 0; process.kill = () => { signals++; return true; };
  try {
    const p = mod.consumeVerifierChild(c, encodeVerifierRequest(context())); c.emit('exit', 0, null);
    await assert.rejects(p, refused); assert.equal(signals, 0); assert.equal(c.unreferenced, true); assert.equal(c.stdout.destroyed, true);
  } finally { process.kill = original; }
});
test('timeout kills group only once before known exit, never accepts late valid response', async () => {
  const mod = await isolated(), c = child(); c.pid = 123456;
  const original = process.kill; const signals = []; process.kill = (...args) => { signals.push(args); return true; };
  try {
    const e = encodeVerifierRequest(context()); await assert.rejects(mod.consumeVerifierChild(c, e), refused);
    c.emit('close', 0, null); assert.deepEqual(signals, [[-123456, 'SIGKILL']]);
  } finally { process.kill = original; }
});
test('bounded stderr flood cannot turn into success', async () => {
  const c = child(), e = encodeVerifierRequest(context()), p = assert.rejects(consumeVerifierChild(c, e), refused);
  c.stderr.write(Buffer.alloc(4097)); c.stdout.write(success(e)); c.emit('close', 0, null); await p;
});
test('missing native tool refuses in isolated platform-gate test; never spawns a replacement', async () => {
  const mod = await isolated('missing-tool'); await assert.rejects(mod.verifyCapturedLibrariesNative(context()), refused);
});
test('real non-Darwin entry point refuses without spawning/signing', { skip: process.platform === 'darwin' }, async () => {
  await assert.rejects(verifyCapturedLibrariesNative(context()), refused);
});

test('late close cannot beat the deadline when the event loop delayed its timer', async () => {
  const mod = await isolated(), c = child(), e = encodeVerifierRequest(context());
  const p = assert.rejects(mod.consumeVerifierChild(c, e), refused);
  const until = performance.now() + 15; while (performance.now() < until) { /* test-only event-loop stall */ }
  c.stdout.write(success(e)); c.emit('exit', 0, null); c.emit('close', 0, null); await p;
});
test('64 unique CDHash bound and ambiguous full-digest aliases are rejected in protocol construction', () => {
  const c = context(), template = c.libraries[0];
  c.libraries = Array.from({ length: 65 }, (_, i) => {
    const full = (i + 1).toString(16).padStart(40, '0') + 'aa'.repeat(12);
    return { ...template, relativePath: `Contents/Libraries/lib${String(i).padStart(3, '0')}.dylib`,
      architectures: [{ ...template.architectures[0], cdHash: full.slice(0, 40), codeDirectorySHA256: full }] };
  });
  assert.throws(() => encodeVerifierRequest(c), refused); c.libraries.pop(); assert.equal(encodeVerifierRequest(c).libraries, 64);
  c.libraries[1].architectures[0].cdHash = c.libraries[0].architectures[0].cdHash;
  c.libraries[1].architectures[0].codeDirectorySHA256 = c.libraries[0].architectures[0].cdHash + 'bb'.repeat(12);
  assert.throws(() => encodeVerifierRequest(c), refused);
});
test('source boundary: fixed read-only native API, no candidate execution/signing hooks or dynamic verifier override', () => {
  const native = fs.readFileSync(new URL('../native/computer-control/BootstrapInventoryVerifier.c', import.meta.url), 'utf8');
  assert.match(native, /SecStaticCodeCreateWithPathAndAttributes/); assert.match(native, /kSecCSNoNetworkAccess/);
  assert.match(native, /kSecCSStrictValidate \| kSecCSCheckAllArchitectures \| kSecCSNoNetworkAccess/);
  assert.match(native, /1\.2\.840\.113635\.100\.6\.2\.6/); assert.match(native, /1\.2\.840\.113635\.100\.6\.1\.13/);
  assert.doesNotMatch(native, /\b(?:getenv|system|popen|execv|execve|dlopen|SecCodeCopyGuestWithAttributes|SecCodeSignerAddSignature|SecKeyCreateSignature)\s*\(/);
  assert.doesNotMatch(native, /\bO_WRONLY\b|\bO_RDWR\b|\bkSecCSDoNotValidateExecutable\b|\bkSecCSDoNotValidateResources\b/);
});
test('explicit separate build script refuses non-Darwin before any compiler/build output', { skip: process.platform === 'darwin' }, () => {
  const script = new URL('./build-bootstrap-inventory-verifier.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, '--build-read-only-verifier'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'Read-only inventory verifier build refused.\n');
});
