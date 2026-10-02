// INTERNAL RELEASE ARTIFACT capture and optional read-only native verification.
// Used by the existing Mac signing hook; no CLI, environment override, credential
// requests, signing operations or runtime authority in this module.
// Capture discovers bytes; only the private CMS receipt can enter stage approval.
// BootstrapApprovalAnchor.h was read: its size is 1376, NOT 3376, and its limit
// is 64 sorted unique CDHashes. Do NOT pass candidateCDHashes to that anchor
// until an independent trusted signing backend authenticates every candidate.
// requireVerifiedCapturedInventory() invokes the fixed native Security backend
// only for a private branded capture. Stage approval checks the fixed R1 package
// roles and ASAR/fuses policy. No supplied boolean/TeamInfo/receipt is authority.
//
// Fixed scope: canonical absolute trusted build root named "Use Brian.app";
// every physical regular file, regardless of extension, is streamed and hashed.
// Leading Mach-O magic is treated as native code, including benign binary test
// resources; unknown/32-bit/swapped profiles, archives and ELF refuse. MZ alone
// is ordinary data, but MZ plus a bounded PE signature refuses. Magic buried in
// ordinary resources is NOT treated as executable content. Mach-O MH_DYLIB and
// MH_BUNDLE must have the EXACT trusted architecture set. MH_EXECUTE is separately
// recorded/excluded (must contain a target slice; extra supported slices are
// allowed, e.g. universal Siri in an arm64 app); its signature is NOT checked
// or included, avoiding circular helper/main/Siri CDHash pins. Other types refuse.
// All physical dylibs/addons are candidates, NOT established non-Apple code.
//
// Capture: ASCII normal path components, no hardlinks or special files; nofollow
// open/fstat/read/fstat/lstat file captures; held nofollow directory descriptors;
// bounded opendir traversal, internal relative symlink resolution/cycle detection,
// physical-file dedup, complete final manifest/descriptor revalidation. Symlink
// directory aliases are recorded as graph edges, never exponentially expanded.
// Limits may only be TIGHTENED. Deadline checks are cooperative around operations
// (synchronous OS I/O cannot be interrupted), never a claim of hard cancellation.
// Node has no portable openat/opendir-at API: directories are enumerated by path
// with ancestor/descriptor checks before and after, NOT an adversarial atomic
// filesystem snapshot. Use a quiescent trusted build tree. Detected replacements
// fail; hostile concurrent mutation/ABA and an adversarial JS realm are NOT solved.
// Capture alone authenticates no signer. Even a separately CMS-checked result
// authenticates no mapped code, exec generation or runtime loads.
//
// capturedTreeSHA256 describes this staging capture including excluded executables;
// it is NOT an anchor pin and changes during later helper/outer-app signing.
// Only independently authenticated final nested-library hashes may flow to the
// anchor, never this tree digest or excluded executable digests (no signing cycle).
// Two content passes bind candidate parsing to the initial full-tree file digest.
// Sidecar slot 1/3 hashes are checked ONLY for the explicit framework/bundle paths
// below. XML/plist/CMS/requirements/entitlement DER semantics are NOT interpreted.
// The optional fixed native adapter checks strict/all-architecture Security
// validity, Developer-ID Application + exact trusted team and fresh CF metadata,
// independently hashes whole files, and binds full parser CD/file/capture digests.
// Offline verification is NOT online revocation/notarization proof. Native SDK
// compile and actual Developer-ID acceptance must still be validated on macOS.
// Dependencies/rpaths/dlopen/JS load policy, libraries outside the captured tree,
// OS-library exceptions and whole-process completeness remain outside this API.
//
// Mach-O/CodeDirectory pins, same Sonoma ABI as the existing anchor extractor:
// https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/EXTERNAL_HEADERS/mach-o/loader.h
// https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/osfmk/kern/cs_blobs.h
// https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/bsd/kern/ubc_subr.c
// https://github.com/apple-oss-distributions/Security/blob/ef677c3d667a44e1737c1b0245e9ed04d11c51c1/OSX/libsecurity_codesigning/lib/codedirectory.cpp
// SHA256 only, primary CD only, v20400/20500/20600, page=4K/16K, no scatter,
// codeLimit64, linkage or pre-encryption. CDHash is first 20 of SHA256(CD), while
// special slots hash the whole generic blob. Extraction/capture alone leaves CMS
// UNAUTHENTICATED; only the separate branded native-verification API checks it.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { verifyCapturedLibrariesNative } from './mac-bootstrap-inventory-verifier.mjs';
import { verifyMacBootstrap } from './electron-fuses.mjs';
import { integrityDictionaryDigest, supportedElectronVersion } from './mac-asar-integrity.mjs';

const privateCaptures = new WeakMap(), verifiedInventories = new WeakMap(), activeCaptures = new WeakSet();

export const canonicalElectronLibrary = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework';
export const inventoryLimits = Object.freeze({ entries: 50000, directories: 2048, links: 1024,
  depth: 48, pathBytes: 2048, fileBytes: 512 * 1024 * 1024, totalReadBytes: 4 * 1024 ** 3,
  nativeFiles: 256, cdHashes: 64, deadlineMs: 30000 });
// Preserve the precise failed invariant in our own stack traces. Filesystem or
// caller exceptions remain sanitized; a forged public error code is not enough.
const inventoryFailures = new WeakSet();
const fail = diagnostics => { const e = new Error('Release library inventory data rejected: unsupported, changed, malformed, or bounded capture failure'); e.code = 'ERR_MAC_BOOTSTRAP_INVENTORY'; if (diagnostics) Object.assign(e, diagnostics); inventoryFailures.add(e); throw e; };
const guard = fn => { try { return fn(); } catch (error) { if (inventoryFailures.has(error)) throw error; fail(); } };
const sha = b => createHash('sha256').update(b).digest();
const { isProxy, isUint8Array, isSharedArrayBuffer } = types;
const { getPrototypeOf, getOwnPropertyDescriptor: prop, getOwnPropertyDescriptors: props } = Object;
const { apply, ownKeys } = Reflect;
const bp = Buffer.prototype, allocate = Buffer.alloc, bufferBrand = Buffer.isBuffer;
const ta = getPrototypeOf(Uint8Array.prototype), taLength = prop(ta, 'length').get, taBuffer = prop(ta, 'buffer').get, taSet = ta.set;
function copy(b, min, max = min) {
  if (isProxy(b) || !isUint8Array(b) || getPrototypeOf(b) !== bp || !bufferBrand(b)) fail();
  const n = apply(taLength, b, []);
  if (isSharedArrayBuffer(apply(taBuffer, b, [])) || n < min || n > max) fail();
  const out = allocate(n); apply(taSet, out, [b]); return out;
}
function recordObject(value) {
  if (!value || isProxy(value) || ![Object.prototype, null].includes(getPrototypeOf(value))) fail();
  const d = props(value);
  if (ownKeys(d).some(k => typeof k !== 'string' || !Object.hasOwn(d[k], 'value'))) fail();
  return d;
}
function architectures(value) {
  if (isProxy(value) || !Array.isArray(value)) fail();
  const n = prop(value, 'length').value;
  if (n < 1 || n > 2 || ownKeys(value).length !== n + 1) fail();
  const set = new Set();
  for (let i = 0; i < n; i++) {
    const d = prop(value, String(i)); if (!d || !Object.hasOwn(d, 'value') || !['arm64', 'x86_64'].includes(d.value) || set.has(d.value)) fail();
    set.add(d.value);
  }
  return [...set].sort();
}
function range(at, length, end) {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 || at > end || length > end - at) fail();
}
function zero(b) { if (b.some(v => v !== 0)) fail(); }
function disjoint(rs) {
  const sorted = rs.filter(r => r.size).sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].size) fail();
}
function architecture(cpu, sub) {
  if (cpu === 0x0100000c && sub === 0) return 'arm64';
  if (cpu === 0x01000007 && sub === 3) return 'x86_64';
  fail();
}
const machoMagics = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
function slices(b) {
  if (b.length < 32) fail();
  const magic = b.readUInt32BE(0), result = [];
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const n = b.readUInt32BE(4), stride = magic === 0xcafebabe ? 20 : 32, end = 8 + n * stride;
    if (n < 1 || n > 2) fail(); range(0, end, b.length);
    for (let i = 0; i < n; i++) {
      const a = 8 + stride * i;
      const offset = stride === 20 ? b.readUInt32BE(a + 8) : Number(b.readBigUInt64BE(a + 8));
      const size = stride === 20 ? b.readUInt32BE(a + 12) : Number(b.readBigUInt64BE(a + 16));
      const align = b.readUInt32BE(a + (stride === 20 ? 16 : 24));
      range(offset, size, b.length);
      if (offset < end || size < 32 || align > 30 || offset % (2 ** align)) fail();
      if (stride === 32) zero(b.subarray(a + 28, a + 32));
      result.push({ offset, size, cpu: b.readUInt32BE(a), subtype: b.readUInt32BE(a + 4) });
    }
    disjoint(result);
  } else result.push({ offset: 0, size: b.length, cpu: b.readUInt32LE(4), subtype: b.readUInt32LE(8) });
  const seen = new Set();
  for (const s of result) { s.architecture = architecture(s.cpu, s.subtype); if (seen.has(s.architecture)) fail(); seen.add(s.architecture); }
  return result;
}
function name(b, at) {
  const raw = b.subarray(at, at + 16), nul = raw.indexOf(0);
  if (nul >= 0) zero(raw.subarray(nul));
  const value = raw.subarray(0, nul < 0 ? 16 : nul);
  if (!value.length || value.some(v => v < 32 || v > 126)) fail();
  return value.toString('ascii');
}
const fixed = new Map([[2, 24], [0xb, 80], [0x1b, 24], [0x24, 16], [0x26, 16], [0x29, 16], [0x2a, 16],
  [0x80000028, 24], [0x22, 48], [0x80000022, 48], [0x80000033, 16], [0x80000034, 16]]);
const strings = new Map([[0xc, 24], [0xd, 24], [0x80000018, 24], [0x8000001f, 24], [0x80000023, 24], [0xe, 12], [0x8000001c, 12]]);
function commands(b, s) {
  if (b.readUInt32LE(0) !== 0xfeedfacf || b.readUInt32LE(4) !== s.cpu || b.readUInt32LE(8) !== s.subtype) fail();
  const type = b.readUInt32LE(12), n = b.readUInt32LE(16), end = 32 + b.readUInt32LE(20);
  if (![2, 6, 8].includes(type) || !n || n > 4096 || end - 32 < n * 8) fail();
  zero(b.subarray(28, 32)); range(32, end - 32, b.length);
  let at = 32, signature, linkedit, headerMappings = 0;
  const segments = [], vm = [], sections = [], sectionVM = [], names = new Set(), sectionNames = new Set();
  for (let i = 0; i < n; i++) {
    range(at, 8, end); const cmd = b.readUInt32LE(at), size = b.readUInt32LE(at + 4);
    if (size < 8 || size % 8) fail(); range(at, size, end);
    if (cmd === 0x19) {
      if (size < 72) fail();
      const segment = name(b, at + 8), count = b.readUInt32LE(at + 64);
      if (names.has(segment) || count > 4096 || size !== 72 + count * 80) fail(); names.add(segment);
      const address = Number(b.readBigUInt64LE(at + 24)), length = Number(b.readBigUInt64LE(at + 32));
      const offset = Number(b.readBigUInt64LE(at + 40)), fileSize = Number(b.readBigUInt64LE(at + 48));
      range(address, length, Number.MAX_SAFE_INTEGER); range(offset, fileSize, b.length);
      const max = b.readUInt32LE(at + 56), prot = b.readUInt32LE(at + 60), flags = b.readUInt32LE(at + 68);
      if (fileSize > length || (max & ~7) || (prot & ~max) || (flags & ~0x1f)) fail();
      segments.push({ offset, size: fileSize }); vm.push({ offset: address, size: length });
      if (segment === '__LINKEDIT') linkedit = { offset, size: fileSize };
      if (fileSize && offset < end) {
        if (segment !== '__TEXT' || offset !== 0 || fileSize < end || !(prot & 1)) fail(); headerMappings++;
      }
      for (let j = 0; j < count; j++) {
        const a = at + 72 + j * 80, section = name(b, a), owner = name(b, a + 16), key = `${owner}/${section}`;
        if (owner !== segment || sectionNames.has(key)) fail(); sectionNames.add(key);
        const va = Number(b.readBigUInt64LE(a + 32)), len = Number(b.readBigUInt64LE(a + 40)), off = b.readUInt32LE(a + 48);
        const align = b.readUInt32LE(a + 52), sf = b.readUInt32LE(a + 64), st = sf & 255;
        range(va, len, address + length);
        if (va < address || align > 30 || va % (2 ** align) || st > 0x16 || (sf & ~0xfe0007ff)) fail();
        sectionVM.push({ offset: va, size: len });
        if (![1, 0xc, 0x12].includes(st)) {
          range(off, len, offset + fileSize);
          if (off < offset || (len && off < end) || off !== offset + va - address || off % (2 ** align)) fail();
          sections.push({ offset: off, size: len });
        }
      }
    } else if (cmd === 0x1d) {
      if (signature || size !== 16) fail();
      signature = { offset: b.readUInt32LE(at + 8), size: b.readUInt32LE(at + 12) };
      range(signature.offset, signature.size, b.length);
      if (signature.offset < end || signature.size < 12 || signature.size > 16 * 1024 * 1024 || signature.offset % 16 || signature.offset + signature.size !== b.length) fail();
    } else if (fixed.has(cmd)) { if (fixed.get(cmd) !== size) fail(); }
    else if (strings.has(cmd)) {
      const min = strings.get(cmd); if (size < min) fail();
      const off = b.readUInt32LE(at + 8); if (off < min || off >= size || b.subarray(at + off, at + size).indexOf(0) < 0) fail();
    } else if (cmd === 0x32) { if (size < 24 || size !== 24 + b.readUInt32LE(at + 20) * 8) fail(); }
    else fail();
    at += size;
  }
  if (at !== end || headerMappings !== 1) fail();
  disjoint(segments); disjoint(vm); disjoint(sections); disjoint(sectionVM);
  if (signature) {
    if (!linkedit || signature.offset < linkedit.offset) fail();
    range(signature.offset, signature.size, linkedit.offset + linkedit.size); disjoint([...sections, signature]);
  }
  return { type, signature };
}
const magics = new Map([[0, 0xfade0c02], [2, 0xfade0c01], [5, 0xfade7171], [7, 0xfade7172],
  [8, 0xfade8181], [9, 0xfade8181], [10, 0xfade8181], [11, 0xfade8181], [0x10000, 0xfade0b01]]);
function directory(b, signature, externalHash, check) {
  if (!signature) fail();
  const sb = b.subarray(signature.offset, signature.offset + signature.size);
  if (sb.readUInt32BE(0) !== 0xfade0cc0) fail();
  const length = sb.readUInt32BE(4), count = sb.readUInt32BE(8), table = 12 + count * 8;
  range(0, length, sb.length); if (!count || count > magics.size || table > length) fail();
  const blobs = new Map(), ranges = [{ offset: 0, size: table }];
  for (let i = 0; i < count; i++) {
    const slot = sb.readUInt32BE(12 + i * 8), offset = sb.readUInt32BE(16 + i * 8);
    if (blobs.has(slot) || !magics.has(slot) || offset < table) fail(); range(offset, 8, length);
    const size = sb.readUInt32BE(offset + 4); range(offset, size, length);
    if (size < 8 || sb.readUInt32BE(offset) !== magics.get(slot)) fail();
    blobs.set(slot, sb.subarray(offset, offset + size)); ranges.push({ offset, size });
  }
  disjoint(ranges); ranges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) zero(sb.subarray(ranges[i - 1].offset + ranges[i - 1].size, ranges[i].offset));
  const last = ranges.at(-1), indexedEnd = last.offset + last.size;
  // LC_CODE_SIGNATURE may reserve more bytes than the embedded SuperBlob uses.
  // Re-signing can leave nonzero bytes in that unused allocation. Never parse
  // them as signature content; indexed blobs and gaps stay within `length`.
  if (sb.subarray(indexedEnd, length).some(value => value !== 0)) fail({
    inventoryCheck: 'signature-tail',
    allocatedSignatureBytes: sb.length, declaredSignatureBytes: length, indexedEnd,
    nonzeroInsideDeclaredSignature: sb.subarray(indexedEnd, length).some(value => value !== 0),
    nonzeroOutsideDeclaredSignature: sb.subarray(length).some(value => value !== 0),
  });
  const cd = blobs.get(0); if (!cd || cd.length < 88) fail();
  const version = cd.readUInt32BE(8), header = new Map([[0x20400, 88], [0x20500, 96], [0x20600, 108]]).get(version);
  if (!header || cd.length < header || cd[36] !== 32 || cd[37] !== 2 || cd[38] !== 0 || ![12, 14].includes(cd[39])) fail();
  zero(cd.subarray(40, 48)); zero(cd.subarray(52, 64));
  if (version >= 0x20500) zero(cd.subarray(92, 96));
  if (version >= 0x20600) zero(cd.subarray(96, 108));
  if ((cd.readUInt32BE(12) & ~0x33f02) || (cd.readBigUInt64BE(80) & ~0x3f1n)) fail();
  range(Number(cd.readBigUInt64BE(64)), Number(cd.readBigUInt64BE(72)), signature.offset);
  const hashes = cd.readUInt32BE(16), special = cd.readUInt32BE(24), pages = cd.readUInt32BE(28), limit = cd.readUInt32BE(32), pageSize = 2 ** cd[39];
  if (special > 11 || limit !== signature.offset || pages !== Math.ceil(limit / pageSize)) fail();
  const start = hashes - special * 32; range(start, (special + pages) * 32, cd.length);
  if (start < header || hashes + pages * 32 !== cd.length) fail();
  const pieces = [{ offset: 0, size: header }, { offset: start, size: cd.length - start }], team = cd.readUInt32BE(48);
  for (const off of [cd.readUInt32BE(20), ...(team ? [team] : [])]) {
    if (off < header || off >= start) fail();
    const nul = cd.indexOf(0, off); if (nul <= off || nul >= start) fail(); pieces.push({ offset: off, size: nul + 1 - off });
  }
  disjoint(pieces); pieces.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < pieces.length; i++) zero(cd.subarray(pieces[i - 1].offset + pieces[i - 1].size, pieces[i].offset));
  const externalSlots = [];
  for (let slot = 1; slot <= 11; slot++) {
    const blob = blobs.get(slot);
    if (slot > special) { if (blob) fail(); continue; }
    const stored = cd.subarray(hashes - slot * 32, hashes - (slot - 1) * 32);
    if (slot === 1 || slot === 3) {
      if (stored.some(v => v !== 0)) {
        if (externalHash(slot) !== stored.toString('hex')) fail(); externalSlots.push(slot);
      }
    } else if (blob ? !sha(blob).equals(stored) : stored.some(v => v !== 0)) fail();
  }
  for (let p = 0; p < pages; p++) {
    check(); if (!sha(b.subarray(p * pageSize, Math.min((p + 1) * pageSize, limit))).equals(cd.subarray(hashes + p * 32, hashes + (p + 1) * 32))) fail();
  }
  const digest = sha(cd);
  return Object.freeze({ codeDirectoryVersion: version, cdHash: digest.subarray(0, 20).toString('hex'), codeDirectorySHA256: digest.toString('hex'),
    signatureContainerSHA256: sha(sb).toString('hex'), externalSlotsChecked: Object.freeze(externalSlots), signerAuthentication: 'unavailable' });
}
function parseMach(b, expected, externalHash, check) {
  const all = slices(b), result = []; let type;
  for (const s of all) {
    check(); const part = b.subarray(s.offset, s.offset + s.size), parsed = commands(part, s);
    if (type !== undefined && parsed.type !== type) fail(); type = parsed.type;
    // Executables are not library pins. The shipped Siri executable is universal
    // even in a single-architecture Electron package; still validate every slice.
    if (type !== 2 && !expected.includes(s.architecture)) fail();
    const data = type === 2 ? {} : directory(part, parsed.signature, externalHash, check);
    result.push(Object.freeze({ architecture: s.architecture, sliceOffset: s.offset, sliceSize: s.size, ...data }));
  }
  if (type === 2 && !result.some(r => expected.includes(r.architecture))) fail();
  if (type !== 2 && (result.length !== expected.length || expected.some(a => !result.some(r => r.architecture === a)))) fail();
  return Object.freeze({ machType: type === 2 ? 'MH_EXECUTE' : type === 6 ? 'MH_DYLIB' : 'MH_BUNDLE',
    architectures: Object.freeze(result.sort((a, b) => a.architecture.localeCompare(b.architecture))) });
}
/** Pure bounded cryptographic DATA extraction, no I/O or signer authentication.
 * Standalone files with nonzero external slots require exact sidecar bytes via
 * keys "1"/"3". The scanner instead obtains those digests from its own capture.
 */
export function extractMachOLibraryData(bytes, expectedArchitectures, externalSidecars = {}) {
  return guard(() => {
    const b = copy(bytes, 32, inventoryLimits.fileBytes), arches = architectures(expectedArchitectures), d = recordObject(externalSidecars), hashes = new Map();
    for (const key of ownKeys(d)) { if (!['1', '3'].includes(key)) fail(); hashes.set(Number(key), sha(copy(d[key].value, 0, inventoryLimits.fileBytes)).toString('hex')); }
    const result = parseMach(b, arches, slot => hashes.get(slot), () => {});
    if (result.machType === 'MH_EXECUTE') fail();
    return Object.freeze({ kind: 'unauthenticated-library-code-data', productionAuthority: false, ...result });
  });
}

function normalName(name) {
  if (typeof name !== 'string' || !name.length || name.length > 255 || name === '.' || name === '..' || name.trim() !== name || !/^[A-Za-z0-9._ @()+-]+$/.test(name)) fail();
}
function same(a, b) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k]);
}
function stat(path) { return fs.lstatSync(path, { bigint: true }); }
function fdstat(fd) { return fs.fstatSync(fd, { bigint: true }); }
function noLinkAncestors(path) {
  let p = path;
  while (true) {
    const s = stat(p); if (!s.isDirectory() || s.isSymbolicLink()) fail();
    const parent = dirname(p); if (parent === p) return; p = parent;
  }
}
const internalOptions = options => {
  const d = recordObject(options);
  if (!Object.hasOwn(d, 'architectures') || ownKeys(d).some(k => !['architectures', 'limits'].includes(k))) fail();
  const limits = { ...inventoryLimits };
  if (d.limits) {
    const l = recordObject(d.limits.value);
    for (const key of ownKeys(l)) {
      const value = l[key].value;
      if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) fail(); limits[key] = value;
    }
  }
  return { arches: architectures(d.architectures.value), limits };
};
/**
 * Root/options are TRUSTED release-build context, not parent/runtime input.
 * Reads only. Does not return any approved/ready-to-stamp or signing claim.
 * No arbitrary candidate file list: completeness is over the full physical tree.
 */
export function captureReleaseLibraryInventoryData(appRoot, options) {
  return guard(() => capture(appRoot, internalOptions(options)));
}
function capture(appRoot, { arches, limits }) {
  const start = performance.now(), check = () => { if (performance.now() - start > limits.deadlineMs) fail(); };
  if (!Number.isInteger(fs.constants.O_NOFOLLOW) || !Number.isInteger(fs.constants.O_DIRECTORY)) fail();
  if (typeof appRoot !== 'string' || !isAbsolute(appRoot) || appRoot !== resolve(appRoot) || basename(appRoot) !== 'Use Brian.app') fail();
  noLinkAncestors(appRoot); if (fs.realpathSync(appRoot) !== appRoot) fail(); check();
  const entries = new Map(), dirs = [], directoryByPath = new Map(), identities = new Set(); let links = 0, bytesRead = 0;
  const absolute = rel => rel ? join(appRoot, ...rel.split('/')) : appRoot;
  function stableDirs(rel) {
    check();
    // Check active ancestors for each operation, then ALL held directories at
    // phase/final boundaries. Avoid O(files*directories) filesystem syscalls.
    let selected = dirs;
    if (rel !== undefined) {
      const prefixes = ['']; let at = '';
      for (const part of rel.split('/').filter(Boolean)) { at = at ? `${at}/${part}` : part; prefixes.push(at); }
      selected = prefixes.map(p => directoryByPath.get(p)).filter(Boolean);
    }
    for (const d of selected) if (!same(d.stat, fdstat(d.fd)) || !same(d.stat, stat(absolute(d.path)))) fail();
  }
  function names(path) {
    check(); const dir = fs.opendirSync(path, { bufferSize: 32 }), result = [], folded = new Set();
    try {
      let ent;
      while ((ent = dir.readSync()) !== null) {
        check(); normalName(ent.name);
        if (folded.has(ent.name.toLowerCase()) || result.length >= limits.entries) fail();
        folded.add(ent.name.toLowerCase()); result.push(ent.name);
      }
    } finally { dir.closeSync(); }
    check(); return result.sort();
  }
  function visit(rel, depth) {
    check(); if (depth > limits.depth || rel.length > limits.pathBytes || entries.size >= limits.entries) fail();
    stableDirs(rel); const path = absolute(rel), s = stat(path), key = `${s.dev}:${s.ino}`;
    if (identities.has(key)) fail(); identities.add(key);
    const e = { path: rel, stat: s }; entries.set(rel, e);
    if (s.isSymbolicLink()) {
      if (s.nlink !== 1n || ++links > limits.links) fail();
      e.type = 'link'; e.target = fs.readlinkSync(path);
      if (e.target.length > limits.pathBytes || !same(s, stat(path))) fail();
    } else if (s.isDirectory()) {
      if (dirs.length >= limits.directories) fail();
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY | fs.constants.O_NONBLOCK);
      e.fd = fd; dirs.push(e); directoryByPath.set(rel, e); e.type = 'directory';
      if (!same(s, fdstat(fd))) fail();
      e.names = names(path); stableDirs(rel);
      for (const name of e.names) visit(rel ? `${rel}/${name}` : name, depth + 1);
      stableDirs(rel);
    } else if (s.isFile()) {
      if (s.nlink !== 1n || s.size > BigInt(limits.fileBytes)) fail(); e.type = 'file';
    } else fail();
  }
  function resolveLink(rel) {
    let pending = rel ? rel.split('/') : [], prefix = [], hops = 0;
    const seen = new Set();
    while (pending.length) {
      check(); const part = pending.shift(); normalName(part); prefix.push(part);
      const key = prefix.join('/'), e = entries.get(key); if (!e) fail();
      if (e.type === 'link') {
        if (++hops > 32 || seen.has(key) || isAbsolute(e.target) || e.target.includes('\\')) fail(); seen.add(key);
        const target = prefix.slice(0, -1);
        for (const p of e.target.split('/')) {
          if (p === '..') { if (!target.length) fail(); target.pop(); }
          else { normalName(p); target.push(p); }
        }
        pending = [...target, ...pending]; prefix = [];
        if (pending.length > limits.depth || pending.join('/').length > limits.pathBytes) fail();
      } else if (pending.length && e.type !== 'directory') fail();
    }
    return prefix.join('/');
  }
  function read(e, retain = false) {
    stableDirs(e.path); const path = absolute(e.path);
    if (!same(e.stat, stat(path))) fail();
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (!same(e.stat, fdstat(fd))) fail();
      const size = Number(e.stat.size), digest = createHash('sha256'), data = retain ? Buffer.alloc(size) : null;
      const scratch = Buffer.alloc(Math.min(65536, Math.max(1, size))), head = Buffer.alloc(Math.min(65536, size)); let at = 0;
      while (at < size) {
        check(); const n = fs.readSync(fd, scratch, 0, Math.min(scratch.length, size - at), at);
        if (n < 1 || (bytesRead += n) > limits.totalReadBytes) fail();
        if (at < head.length) scratch.copy(head, at, 0, Math.min(n, head.length - at));
        digest.update(scratch.subarray(0, n)); if (data) scratch.copy(data, at, 0, n); at += n;
      }
      check();
      if (fs.readSync(fd, scratch, 0, 1, size) !== 0 || !same(e.stat, fdstat(fd)) || !same(e.stat, stat(path))) fail();
      stableDirs(e.path);
      let format = 'resource';
      if (head.length >= 4 && machoMagics.has(head.readUInt32BE(0))) format = 'macho';
      if (head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || head.subarray(0, 8).equals(Buffer.from('!<arch>\n')) || head.subarray(0, 8).equals(Buffer.from('!<thin>\n'))) fail();
      if (head.length >= 64 && head[0] === 0x4d && head[1] === 0x5a) {
        const off = head.readUInt32LE(60);
        if (off <= size - 4) {
          const pe = Buffer.alloc(4); let got = 0;
          while (got < 4) {
            check(); const n = fs.readSync(fd, pe, got, 4 - got, off + got);
            if (n < 1 || (bytesRead += n) > limits.totalReadBytes) fail(); got += n;
          }
          if (pe.equals(Buffer.from([0x50, 0x45, 0, 0]))) fail();
        }
      }
      if (!same(e.stat, fdstat(fd))) fail(); check();
      return { data, format, digest: digest.digest('hex') };
    } finally { fs.closeSync(fd); }
  }
  try {
    visit('', 0);
    const edges = new Map(dirs.map(d => [d.path, new Set()]));
    const parent = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    for (const e of entries.values()) {
      if (e.type === 'directory' && e.path) edges.get(parent(e.path)).add(e.path);
      if (e.type === 'link') {
        e.resolved = resolveLink(e.path); const target = entries.get(e.resolved); if (!target) fail();
        if (target.type === 'directory') edges.get(parent(e.path)).add(e.resolved);
        else if (target.type !== 'file') fail();
      }
    }
    // Includes cycles through directory aliases, not just direct symlink chains.
    const visiting = new Set(), done = new Set();
    function cycle(path, depth) {
      check(); if (visiting.has(path) || depth > limits.depth) fail(); if (done.has(path)) return;
      visiting.add(path); for (const next of edges.get(path)) cycle(next, depth + 1);
      visiting.delete(path); done.add(path);
    }
    cycle('', 0);
    const files = [...entries.values()].filter(e => e.type === 'file').sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const e of files) { const captured = read(e); e.digest = captured.digest; e.format = captured.format; }
    const native = files.filter(e => e.format === 'macho'); if (native.length > limits.nativeFiles) fail();
    const libraries = [], excludedExecutables = [], unique = new Set();
    function sidecar(e, slot) {
      // Only a framework's exact conventional executable or a loadable bundle's
      // Contents/MacOS executable can infer its own sealed sidecar locations.
      let base;
      const fw = /^(.*\/)?([^/]+)\.framework\/(?:Versions\/([^/]+)\/)?([^/]+)$/.exec(e.path);
      if (fw && fw[2] === fw[4]) base = e.path.slice(0, e.path.lastIndexOf('/'));
      const bundle = /^(.*\.bundle\/Contents)\/MacOS\/[^/]+$/.exec(e.path);
      const rel = base ? `${base}/${slot === 1 ? 'Resources/Info.plist' : '_CodeSignature/CodeResources'}` :
        bundle ? `${bundle[1]}/${slot === 1 ? 'Info.plist' : '_CodeSignature/CodeResources'}` : undefined;
      if (!rel) fail(); const file = entries.get(resolveLink(rel));
      if (!file || file.type !== 'file') fail(); return file.digest;
    }
    for (const e of native) {
      const captured = read(e, true); if (captured.digest !== e.digest || captured.format !== 'macho') fail();
      const parsed = parseMach(captured.data, arches, slot => sidecar(e, slot), check);
      const item = Object.freeze({ relativePath: e.path, fileSHA256: e.digest, ...parsed });
      if (parsed.machType === 'MH_EXECUTE') { excludedExecutables.push(item); continue; }
      libraries.push(item);
      for (const a of parsed.architectures) { unique.add(a.cdHash); if (unique.size > limits.cdHashes) fail(); }
    }
    const electron = libraries.find(l => l.relativePath === canonicalElectronLibrary);
    if (!electron || electron.machType !== 'MH_DYLIB') fail();
    // Final complete path/entry/descriptor recheck, including additions/removals.
    stableDirs(); noLinkAncestors(appRoot); if (fs.realpathSync(appRoot) !== appRoot) fail();
    for (const e of entries.values()) {
      check(); if (!same(e.stat, stat(absolute(e.path)))) fail();
      if (e.type === 'directory' && JSON.stringify(names(absolute(e.path))) !== JSON.stringify(e.names)) fail();
      if (e.type === 'link' && fs.readlinkSync(absolute(e.path)) !== e.target) fail();
    }
    stableDirs();
    const digest = createHash('sha256');
    for (const key of [...entries.keys()].sort()) {
      const e = entries.get(key);
      digest.update(`${e.type}\0${key}\0${e.stat.mode}\0${e.stat.size}\0${e.digest ?? e.target ?? ''}\0`);
    }
    check();
    const captured = Object.freeze({ kind: 'captured-release-library-inventory-data', rootName: 'Use Brian.app',
      scope: 'quiescent-captured-product-tree-only', captureChecks: 'descriptor-and-manifest-rechecked',
      productionAuthority: false, eligibleForAnchorStamping: false, signerAuthentication: 'unavailable',
      nonAppleClassification: 'unverified', wholeProcessCompleteness: false,
      expectedArchitectures: Object.freeze([...arches]), capturedTreeSHA256: digest.digest('hex'),
      capturedEntries: entries.size, capturedFiles: files.length, capturedLinks: links, bytesRead,
      libraries: Object.freeze(libraries), excludedExecutables: Object.freeze(excludedExecutables),
      candidateCDHashes: Object.freeze([...unique].sort()) });
    privateCaptures.set(captured, { appRoot, entries, options: { arches: [...arches], limits: { ...limits } } });
    return captured;
  } finally {
    let closeFailed = false;
    for (const d of dirs) { try { fs.closeSync(d.fd); } catch { closeFailed = true; } }
    if (closeFailed) fail();
    check(); // Never return success after cleanup itself overruns the deadline.
  }
}
/** Internal release API, not runtime parent input. Exact team is independent
 * TRUSTED release context, not a value discovered in the candidate signature.
 * A clone, JSON object, proxy, supplied receipt, callback or verified=true flag
 * cannot enter this path. One native attempt, with full capture/stats rechecks
 * bracketing it. No snapshot/online-revocation/notarization/loaded-code claim.
 */
export async function requireVerifiedCapturedInventory(captured, trustedContext) {
  let active = false;
  try {
    const held = privateCaptures.get(captured); if (!held || activeCaptures.has(captured)) fail();
    const d = recordObject(trustedContext);
    if (ownKeys(d).length !== 1 || !d.teamIdentifier || typeof d.teamIdentifier.value !== 'string' || !/^[A-Z0-9]{10}$/.test(d.teamIdentifier.value)) fail();
    const teamIdentifier = d.teamIdentifier.value;
    activeCaptures.add(captured); active = true;
    const recheck = () => recheckCapture(captured, held);
    recheck();
    const libraries = captured.libraries.map(l => ({ relativePath: l.relativePath, fileSize: Number(held.entries.get(l.relativePath).stat.size),
      fileSHA256: l.fileSHA256, architectures: l.architectures.map(a => ({ architecture: a.architecture, sliceOffset: a.sliceOffset,
        sliceSize: a.sliceSize, cdHash: a.cdHash, codeDirectorySHA256: a.codeDirectorySHA256 })) }));
    const native = await verifyCapturedLibrariesNative({ appRoot: held.appRoot, teamIdentifier, architectures: captured.expectedArchitectures,
      capturedTreeSHA256: captured.capturedTreeSHA256, libraries });
    recheck();
    const count = libraries.reduce((n, l) => n + l.architectures.length, 0);
    const nativeFields = recordObject(native);
    if (ownKeys(nativeFields).length !== 4 || !['kind', 'libraries', 'slices', 'requestSHA256'].every(k => Object.hasOwn(nativeFields, k))) fail();
    if (native.kind !== 'native-static-signature-response-data' || native.libraries !== libraries.length || native.slices !== count || !/^[a-f0-9]{64}$/.test(native.requestSHA256)) fail();
    const result = Object.freeze({ kind: 'cms-checked-captured-release-library-inventory', scope: captured.scope,
      productionAuthority: false, eligibleForAnchorStamping: false, wholeProcessCompleteness: false,
      signerAuthentication: 'offline-static-developer-id-application', nonAppleClassification: 'developer-id-application-requirement-only',
      onlineRevocationProven: false, notarizationProven: false, atomicSnapshot: false, trustedTeamIdentifier: teamIdentifier,
      capturedTreeSHA256: captured.capturedTreeSHA256, expectedArchitectures: captured.expectedArchitectures,
      cmsCheckedCDHashes: captured.candidateCDHashes, excludedExecutables: captured.excludedExecutables,
      libraries: Object.freeze(captured.libraries.map(l => Object.freeze({ ...l,
        architectures: Object.freeze(l.architectures.map(a => Object.freeze({ ...a, signerAuthentication: 'offline-static-security' }))) }))),
      nativeVerification: Object.freeze({ ...native }) });
    verifiedInventories.set(result, { captured, held }); return result;
  } catch { const e = new Error('Captured release signing verification unavailable, changed, or refused'); e.code = 'ERR_MAC_BOOTSTRAP_INVENTORY_VERIFICATION'; throw e; }
  finally { if (active) activeCaptures.delete(captured); }
}
// One fixed supported package profile, not a caller-supplied path policy.
// Optional stock roles may be absent; Electron itself is required by capture.
const approvedLibraryRoles = new Set([
  canonicalElectronLibrary,
  ...['libEGL.dylib', 'libGLESv2.dylib', 'libffmpeg.dylib', 'libvk_swiftshader.dylib']
    .map(name => `Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/${name}`),
  ...['Mantle', 'ReactiveObjC', 'Squirrel']
    .map(name => `Contents/Frameworks/${name}.framework/Versions/A/${name}`),
]);
function recheckCapture(captured, held) {
  const fresh = capture(held.appRoot, held.options), state = privateCaptures.get(fresh);
  if (fresh.capturedTreeSHA256 !== captured.capturedTreeSHA256 || state.entries.size !== held.entries.size) fail();
  for (const [path, entry] of held.entries) if (!state.entries.has(path) || !same(entry.stat, state.entries.get(path).stat)) fail();
}
function approvalUnavailable() {
  const e = new Error('Bootstrap inventory approval unavailable: trusted signing, closure, and release-policy conditions are required');
  e.code = 'ERR_MAC_BOOTSTRAP_INVENTORY_SIGNER_UNAVAILABLE'; throw e;
}
/** Internal R1 stage-artifact factory. Only THIS module's exact CMS receipt is
 * accepted (unbranded input throws synchronously). Returns a Promise of the
 * three-key stampBootstrapApproval data, NOT runtime authority or process
 * attestation. Receipt productionAuthority remains false. No appRoot override:
 * verification and both full-tree rechecks use the privately retained root.
 * The trusted tree must stay quiescent through the caller's later stamp/sign.
 */
export function requireApprovedBootstrapInventory(receipt) {
  const state = verifiedInventories.get(receipt);
  if (!state) approvalUnavailable();
  return approveBootstrapInventory(state);
}
async function approveBootstrapInventory({ captured, held }) {
  try {
    if (supportedElectronVersion !== '43.2.0') fail();
    // Reject even non-Mach-O .node placeholders and aliases, not just addons
    // classified by magic. Every physical library must be a reviewed stock role.
    for (const path of held.entries.keys()) if (path.split('/').some(part => /\.node$/i.test(part))) fail();
    for (const library of captured.libraries) {
      if (library.machType !== 'MH_DYLIB' || !approvedLibraryRoles.has(library.relativePath)) fail();
    }
    // Shipped helper/acceptance fixture executables are excluded from library
    // pins (later signing); arbitrary executable resources are not stock roles.
    for (const executable of captured.excludedExecutables) {
      const path = executable.relativePath;
      if (approvedLibraryRoles.has(path) || (path.startsWith('Contents/Resources/') &&
          path !== 'Contents/Resources/computer-control/brian-native-computer-helper' &&
          path !== 'Contents/Resources/computer-control/NativeComputerFixture.app/Contents/MacOS/NativeComputerFixture')) fail();
    }
    recheckCapture(captured, held);
    const info = await verifyMacBootstrap(held.appRoot);
    recheckCapture(captured, held);
    return Object.freeze({ electronVersion: supportedElectronVersion,
      asarDigest: integrityDictionaryDigest(info.ElectronAsarIntegrity),
      libraryCDHashes: Object.freeze(captured.candidateCDHashes.map(hash => Buffer.from(hash, 'hex'))) });
  } catch { approvalUnavailable(); }
}
