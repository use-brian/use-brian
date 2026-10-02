// INTERNAL read-only native Security adapter. No candidate is ever executed.
// Fixed repo-owned verifier path; no CLI/env/tool override, signer callback or
// caller-provided verification boolean. Public protocol helpers return DATA,
// never a branded inventory. Only inventory.mjs can issue that scoped receipt.
// Trusts this JS realm, normal-user build account and reviewed build tree; not a
// sandbox against arbitrary same-account code. Offline checks are not online
// revocation/notarization proof or whole-process/bootstrap admission evidence.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const tool = fileURLToPath(new URL('../native/computer-control/build/brian-bootstrap-inventory-verifier', import.meta.url));
const MAX_REQUEST = 1024 * 1024, RESPONSE_SIZE = 88, MAX_FILE = 512 * 1024 * 1024;
const REQUEST_MAGIC = Buffer.from('BRINVREQ'), RESPONSE_MAGIC = Buffer.from('BRINVRES');
export const verifierProtocolLimits = Object.freeze({ requestBytes: MAX_REQUEST, responseBytes: RESPONSE_SIZE,
  stderrBytes: 4096, deadlineMs: 120000, closeGraceMs: 2000 });
const fail = () => { const e = new Error('Native release signing verification unavailable or refused'); e.code = 'ERR_MAC_BOOTSTRAP_NATIVE_VERIFIER'; throw e; };
const sha = b => createHash('sha256').update(b).digest();
function data(value, keys) {
  if (!value || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const d = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(d);
  if (names.length !== keys.length || !keys.every(k => names.includes(k) && Object.hasOwn(d[k], 'value'))) fail();
  return Object.fromEntries(keys.map(k => [k, d[k].value]));
}
function list(value, max) {
  if (types.isProxy(value) || !Array.isArray(value)) fail();
  const n = Object.getOwnPropertyDescriptor(value, 'length').value;
  if (n < 1 || n > max || Reflect.ownKeys(value).length !== n + 1) fail();
  return Array.from({ length: n }, (_, i) => { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !Object.hasOwn(d, 'value')) fail(); return d.value; });
}
function hex(value, bytes) { if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value)) fail(); return Buffer.from(value, 'hex'); }
function relative(path) {
  if (typeof path !== 'string' || !path.length || path.length > 2048 || path.split('/').length > 48) fail();
  for (const p of path.split('/')) if (!p.length || p === '.' || p === '..' || p.length > 255 || p.trim() !== p || !/^[A-Za-z0-9._ @()+-]+$/.test(p)) fail();
  return path;
}
function targetFor(path) {
  relative(path);
  const framework = /^(.*\/)?([^/]+)\.framework\/(?:Versions\/([^/]+)\/)?([^/]+)$/.exec(path);
  if (framework && framework[2] === framework[4]) return { target: `${framework[1] ?? ''}${framework[2]}.framework`, version: framework[3] ?? '', kind: 1 };
  const bundle = /^(.*\.bundle)\/Contents\/MacOS\/[^/]+$/.exec(path);
  if (bundle) return { target: bundle[1], version: '', kind: 2 };
  return { target: path, version: '', kind: 0 };
}
/** Canonical v1 binary protocol, no duplicate keys/JSON decoding/native ambiguity.
 * Header96: magic8/version16/headerSize16/total32/count16/archMask8/reserved8/
 * rootLength16/teamASCII10/nonce32/captureSHA25632; then root UTF8 (no NUL).
 * Each entry: length32/leafLength16/targetLength16/versionLength16/slices8/kind8/
 * fileSize64/fileSHA25632 (52 bytes), strings, and 72-byte slice records:
 * arch8/reserved24/offset64/size64/CDHash20/fullCDSHA25632, all integers BE.
 * Offsets <= INT_MAX: pinned Security's attribute parser uses a C int.
 */
export function encodeVerifierRequest(context) {
  try {
    const c = data(context, ['appRoot', 'teamIdentifier', 'architectures', 'capturedTreeSHA256', 'libraries']);
    if (typeof c.appRoot !== 'string' || !isAbsolute(c.appRoot) || resolve(c.appRoot) !== c.appRoot || basename(c.appRoot) !== 'Use Brian.app' || c.appRoot.includes('\0')) fail();
    if (typeof c.teamIdentifier !== 'string' || !/^[A-Z0-9]{10}$/.test(c.teamIdentifier)) fail();
    const root = Buffer.from(c.appRoot, 'utf8'); if (root.length > 4096) fail();
    const arches = list(c.architectures, 2);
    if (arches.some(a => !['arm64', 'x86_64'].includes(a)) || new Set(arches).size !== arches.length) fail();
    const mask = arches.reduce((v, a) => v | (a === 'arm64' ? 1 : 2), 0), entries = list(c.libraries, 256), parts = [], unique = new Map();
    let previous = '', slices = 0, total = 96 + root.length, fileBytes = 0;
    for (const entry of entries) {
      const e = data(entry, ['relativePath', 'fileSize', 'fileSHA256', 'architectures']);
      const leaf = relative(e.relativePath); if (leaf <= previous) fail(); previous = leaf;
      const target = targetFor(leaf), leafBytes = Buffer.from(leaf), targetBytes = Buffer.from(target.target), version = Buffer.from(target.version);
      if (!Number.isSafeInteger(e.fileSize) || e.fileSize < 32 || e.fileSize > MAX_FILE || (fileBytes += e.fileSize) > 2 * 1024 ** 3) fail();
      const records = list(e.architectures, 2); if (records.length !== arches.length) fail();
      const seen = new Set(), sliceParts = [], ranges = []; let previousArch = 0;
      for (const record of records) {
        const a = data(record, ['architecture', 'sliceOffset', 'sliceSize', 'cdHash', 'codeDirectorySHA256']);
        const code = a.architecture === 'arm64' ? 1 : a.architecture === 'x86_64' ? 2 : 0;
        if (!code || code <= previousArch || !arches.includes(a.architecture) || seen.has(code)) fail(); previousArch = code; seen.add(code);
        if (!Number.isSafeInteger(a.sliceOffset) || a.sliceOffset < 0 || a.sliceOffset > 0x7fffffff || !Number.isSafeInteger(a.sliceSize) || a.sliceSize < 32 || a.sliceSize > e.fileSize - a.sliceOffset) fail();
        const short = hex(a.cdHash, 20), full = hex(a.codeDirectorySHA256, 32);
        if (!full.subarray(0, 20).equals(short) || short.every(v => v === 0) || (unique.has(a.cdHash) && unique.get(a.cdHash) !== a.codeDirectorySHA256)) fail();
        unique.set(a.cdHash, a.codeDirectorySHA256); if (unique.size > 64) fail();
        const s = Buffer.alloc(72); s[0] = code; s.writeBigUInt64BE(BigInt(a.sliceOffset), 4); s.writeBigUInt64BE(BigInt(a.sliceSize), 12);
        short.copy(s, 20); full.copy(s, 40); sliceParts.push(s); ranges.push([a.sliceOffset, a.sliceSize]); slices++;
      }
      ranges.sort((a, b) => a[0] - b[0]); if (ranges.length === 2 && ranges[1][0] < ranges[0][0] + ranges[0][1]) fail();
      const length = 52 + leafBytes.length + targetBytes.length + version.length + records.length * 72, header = Buffer.alloc(52);
      header.writeUInt32BE(length); header.writeUInt16BE(leafBytes.length, 4); header.writeUInt16BE(targetBytes.length, 6); header.writeUInt16BE(version.length, 8);
      header[10] = records.length; header[11] = target.kind; header.writeBigUInt64BE(BigInt(e.fileSize), 12); hex(e.fileSHA256, 32).copy(header, 20);
      total += length; if (total > MAX_REQUEST) fail(); parts.push(header, leafBytes, targetBytes, version, ...sliceParts);
    }
    const header = Buffer.alloc(96); REQUEST_MAGIC.copy(header); header.writeUInt16BE(1, 8); header.writeUInt16BE(96, 10); header.writeUInt32BE(total, 12);
    header.writeUInt16BE(entries.length, 16); header[18] = mask; header.writeUInt16BE(root.length, 20); header.write(c.teamIdentifier, 22, 'ascii');
    randomBytes(32).copy(header, 32); hex(c.capturedTreeSHA256, 32).copy(header, 64);
    const request = Buffer.concat([header, root, ...parts]);
    return { request, libraries: entries.length, slices };
  } catch { fail(); }
}
function response(bytes, request, libraries, slices) {
  if (bytes.length !== RESPONSE_SIZE || !bytes.subarray(0, 8).equals(RESPONSE_MAGIC) || bytes.readUInt16BE(8) !== 1 ||
      bytes.readUInt16BE(10) !== RESPONSE_SIZE || bytes.readUInt32BE(12) !== 0 || bytes.readUInt16BE(16) !== libraries ||
      bytes.readUInt16BE(18) !== slices || bytes.readUInt32BE(20) !== 0 || !bytes.subarray(24, 56).equals(sha(request)) ||
      !bytes.subarray(56).equals(request.subarray(32, 64))) fail();
  return Object.freeze({ kind: 'native-static-signature-response-data', requestSHA256: sha(request).toString('hex'), libraries, slices });
}
/** Testable pipe state machine only. Calling this with a fake child CANNOT issue
 * a branded CMS-checked inventory; the production entry point spawns privately.
 * Fixed 120s deadline/2s close grace, 88-byte stdout/4096-byte stderr caps. No
 * retries; exit is NOT close; a known exit forbids later group signalling.
 */
export function consumeVerifierChild(child, encoded) {
  return new Promise((resolveResult, reject) => {
    let done = false, failure = false, exited = false, stopped = false, timer, grace, outputBytes = 0, errorBytes = 0;
    const chunks = [], started = performance.now();
    const finish = (code, signal, closed) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(grace);
      if (!closed) { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
      try {
        if (!closed || failure || performance.now() - started > verifierProtocolLimits.deadlineMs || code !== 0 || signal !== null || errorBytes !== 0) fail();
        resolveResult(response(Buffer.concat(chunks), encoded.request, encoded.libraries, encoded.slices));
      } catch { try { fail(); } catch (e) { reject(e); } }
    };
    const stop = () => {
      failure = true; if (done || stopped) return; stopped = true;
      // Never signal a process group after a known exit (PID/group reuse risk).
      if (!exited && Number.isSafeInteger(child.pid) && child.pid > 0) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not termination proof */ }
      }
      grace = setTimeout(() => finish(null, null, false), verifierProtocolLimits.closeGraceMs);
    };
    try {
      child.once('exit', () => { exited = true; });
      child.once('close', (code, signal) => finish(code, signal, true));
      child.on('error', stop); child.stdin.on('error', stop); child.stdout.on('error', stop); child.stderr.on('error', stop);
      child.stdout.on('data', data => {
        if (done) return; outputBytes += data.length;
        if (outputBytes > RESPONSE_SIZE) { stop(); return; } chunks.push(Buffer.from(data));
      });
      child.stderr.on('data', data => { if (!done) { errorBytes += data.length; if (errorBytes > verifierProtocolLimits.stderrBytes) stop(); } });
      timer = setTimeout(stop, verifierProtocolLimits.deadlineMs);
      child.stdin.end(encoded.request); // Request is bounded; EOF is part of framing.
    } catch { stop(); }
  });
}
function fingerprint(s) { return [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs].join(':'); }
function trustedTool() {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 20 || typeof process.getuid !== 'function' || process.getuid() === 0 ||
      process.getuid() !== process.geteuid() || process.getgid() !== process.getegid()) fail();
  const uid = BigInt(process.getuid()); let path = tool, initial;
  while (true) {
    const st = fs.lstatSync(path, { bigint: true });
    if (st.isSymbolicLink() || (st.mode & 0o022n) || (st.uid !== uid && st.uid !== 0n)) fail();
    if (path === tool) {
      if (!st.isFile() || st.uid !== uid || st.nlink !== 1n || (st.mode & 0o6000n) || st.size < 1n || st.size > 32n * 1024n * 1024n || !(st.mode & 0o100n)) fail();
      initial = fingerprint(st);
    } else if (!st.isDirectory()) fail();
    const parent = dirname(path); if (parent === path) break; path = parent;
  }
  if (fs.realpathSync(tool) !== tool) fail();
  const fd = fs.openSync(tool, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (fingerprint(st) !== initial || fingerprint(fs.lstatSync(tool, { bigint: true })) !== initial) fail();
    return { fd, stat: fingerprint(st) };
  } catch { try { fs.closeSync(fd); } catch { /* normalize below */ } fail(); }
}
/** Production path: no caller-selected executable or injectable backend. Returns
 * protocol DATA only, consumed privately by inventory.mjs's branded factory.
 */
export async function verifyCapturedLibrariesNative(context) {
  let held;
  try {
    held = trustedTool(); const encoded = encodeVerifierRequest(context);
    const child = spawn(tool, [], { cwd: dirname(tool), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: '/var/empty', LANG: 'C', LC_ALL: 'C' } });
    const result = await consumeVerifierChild(child, encoded);
    if (fingerprint(fs.fstatSync(held.fd, { bigint: true })) !== held.stat || fingerprint(fs.lstatSync(tool, { bigint: true })) !== held.stat) fail();
    return result;
  } catch { fail(); }
  finally { if (held) { try { fs.closeSync(held.fd); } catch { fail(); } } }
}
