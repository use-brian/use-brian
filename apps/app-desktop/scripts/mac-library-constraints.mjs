import { createHash } from 'node:crypto';

/**
 * INTERNAL signer building block; no authority, telemetry, I/O, CMS verification,
 * DER policy evaluation, or loaded-image attestation. Never log returned bytes.
 *
 * Source pins (Apple Sonoma; paths relative to github.com/apple-oss-distributions):
 * xnu/1031c584a5e37aff177559b9f69dbd3c8c3fd30a (xnu-10002.1.13):
 *   EXTERNAL_HEADERS/mach-o/loader.h: LC_CODE_SIGNATURE/linkedit_data_command;
 *   osfmk/kern/cs_blobs.h: CodeDirectory layout, SHA256=2, CDHASH_LEN=20,
 *     CSSLOT_LIBRARY_CONSTRAINT=11, EMBEDDED_LAUNCH_CONSTRAINT=0xfade8181;
 *   bsd/kern/ubc_subr.c: find_special_slot, csblob_find_special_slot_blob
 *     hash the WHOLE generic blob, including its big-endian magic/length.
 *   EXTERNAL_HEADERS/CoreEntitlements/{Serialization.h,der_vm.h}: public
 *     serialization/query interfaces, NOT a complete LWCR DER wire grammar.
 * Security/ef677c3d667a44e1737c1b0245e9ed04d11c51c1 (Security-61040.1.3):
 *   OSX/libsecurity_codesigning/lib/{codedirectory.h,codedirectory.cpp,signer.cpp,
 *     LWCRHelper.mm}: specialSlot/validateSlot; Developer-ID, team-identifier,
 *     cdhash/$in dictionary construction. Classic requirement byte arrays there
 *     are NOT library-constraint DER fixtures. libCoreEntitlements implementation
 *     and TLE wire normal form were not found in these public source pins.
 *
 * Therefore production policy verification below is deliberately unsupported.
 * The user has supplied fixtures/mac-library-constraint.arm64-macos26.v1.json
 * (ad-hoc, never executed, macOS26.6.2/25G83). A separate policy-only comparator
 * accepts that exact observed envelope; it is not a production verifier or a
 * substitute for this module's kernel/slot binding. This extractor's container
 * tests use synthetic opaque payloads, not native enforcement evidence. Before
 * integration: establish envelope semantics and native negative/positive tests. Developer-ID/team semantics
 * additionally need native signed evidence. No independent Apple DER library
 * constraint fixture with established provenance/license was obtained.
 *
 * Caller must supply fresh kernel CDHash AND actual slice identity tied to one
 * exec generation, not a path-derived hash or guessed host architecture. This
 * module cannot establish that provenance or close exec/file races. Native
 * enforcement of the exact framework membership policy, no bypass paths, and
 * old-same-team-loaded/disk-restored negative tests remain required. ASAR/fuses
 * checks are separate. Raw extraction success must NEVER authorize control.
 *
 * Deliberately narrow envelope profile: little-endian 64-bit x86_64/arm64,
 * thin or big-endian fat32/fat64 (at most two unique architectures); primary
 * SHA256 CodeDirectory only, versions 0x20400/0x20500/0x20600, 4K/16K pages,
 * no scatter, codeLimit64, pre-encryption or linkage. Unknown signature slots,
 * alternate directories, duplicate/overlapping components fail closed. Standard
 * non-signature load commands are framed only, NOT a full dyld/section parser.
 * Other embedded components are opaque and are not CMS/requirements/DER-checked.
 */
const MAX_BYTES = 512 * 1024 * 1024, MAX_SIGNATURE = 16 * 1024 * 1024;
const fail = reason => { throw new Error(`macOS library constraint: ${reason}`); };
const sha256 = b => createHash('sha256').update(b).digest();
function range(offset, size, limit) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > limit || size > limit - offset) fail('out-of-bounds range');
}
function disjoint(ranges) {
  const sorted = ranges.filter(r => r.size).sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].size) fail('overlapping ranges');
}
function zero(b) { if (b.some(v => v !== 0)) fail('unsupported nonzero padding/field'); }
function arch(cpuType, cpuSubtype) {
  if (!((cpuType === 0x01000007 && cpuSubtype === 3) || (cpuType === 0x0100000c && cpuSubtype === 0))) fail('unsupported architecture');
}
function slices(bytes) {
  const magic = bytes.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) {
    return [{ offset: 0, size: bytes.length, cpuType: bytes.readUInt32LE(4), cpuSubtype: bytes.readUInt32LE(8) }];
  }
  const count = bytes.readUInt32BE(4), stride = magic === 0xcafebabe ? 20 : 32;
  if (count < 1 || count > 2) fail('unsupported fat count');
  const end = 8 + count * stride, result = [], cpus = new Set();
  range(0, end, bytes.length);
  for (let i = 0; i < count; i++) {
    const at = 8 + i * stride, cpuType = bytes.readUInt32BE(at), cpuSubtype = bytes.readUInt32BE(at + 4);
    arch(cpuType, cpuSubtype);
    if (cpus.has(cpuType)) fail('duplicate architecture');
    cpus.add(cpuType);
    const offset = stride === 20 ? bytes.readUInt32BE(at + 8) : Number(bytes.readBigUInt64BE(at + 8));
    const size = stride === 20 ? bytes.readUInt32BE(at + 12) : Number(bytes.readBigUInt64BE(at + 16));
    const alignment = bytes.readUInt32BE(at + (stride === 20 ? 16 : 24));
    range(offset, size, bytes.length);
    if (size < 32 || offset < end || alignment > 30 || offset % (2 ** alignment)) fail('invalid fat slice');
    if (stride === 32) zero(bytes.subarray(at + 28, at + 32));
    result.push({ offset, size, cpuType, cpuSubtype });
  }
  disjoint(result);
  return result;
}
// Known Sonoma command framing only. Unknown commands are NOT silently skipped.
const fixedCommands = new Map([[2, 24], [0xb, 80], [0x1b, 24], [0x24, 16],
  [0x26, 16], [0x29, 16], [0x2a, 16], [0x80000028, 24],
  [0x22, 48], [0x80000022, 48], [0x80000033, 16], [0x80000034, 16]]);
const stringCommands = new Map([[0xc, 24], [0xd, 24], [0x80000018, 24],
  [0x8000001f, 24], [0x80000023, 24], [0xe, 12], [0x8000001c, 12]]);
function signatureRange(b, slice) {
  arch(slice.cpuType, slice.cpuSubtype);
  if (b.readUInt32LE(0) !== 0xfeedfacf || b.readUInt32LE(4) !== slice.cpuType || b.readUInt32LE(8) !== slice.cpuSubtype || ![2, 6, 8].includes(b.readUInt32LE(12))) fail('unsupported Mach-O header');
  zero(b.subarray(28, 32));
  const count = b.readUInt32LE(16), end = 32 + b.readUInt32LE(20);
  range(32, end - 32, b.length);
  if (!count || count > 4096 || count * 8 > end - 32) fail('invalid command count');
  let at = 32, signature, linkedit;
  const segments = [], names = new Set();
  for (let i = 0; i < count; i++) {
    range(at, 8, end);
    const cmd = b.readUInt32LE(at), size = b.readUInt32LE(at + 4);
    if (size < 8 || size % 8) fail('invalid command size');
    range(at, size, end);
    if (cmd === 0x1d) {
      if (signature || size !== 16) fail('duplicate/invalid signature command');
      signature = { offset: b.readUInt32LE(at + 8), size: b.readUInt32LE(at + 12) };
    } else if (cmd === 0x19) {
      if (size < 72 || size !== 72 + b.readUInt32LE(at + 64) * 80) fail('invalid segment framing');
      const raw = b.subarray(at + 8, at + 24), nul = raw.indexOf(0);
      const name = raw.subarray(0, nul < 0 ? 16 : nul).toString('hex');
      if (nul >= 0) zero(raw.subarray(nul));
      if (names.has(name)) fail('duplicate segment');
      names.add(name);
      const segment = { offset: Number(b.readBigUInt64LE(at + 40)), size: Number(b.readBigUInt64LE(at + 48)) };
      range(segment.offset, segment.size, b.length); segments.push(segment);
      if (raw.equals(Buffer.from('__LINKEDIT\0\0\0\0\0\0'))) linkedit = segment;
    } else if (fixedCommands.has(cmd)) {
      if (size !== fixedCommands.get(cmd)) fail('invalid fixed command');
    } else if (stringCommands.has(cmd)) {
      const minimum = stringCommands.get(cmd);
      if (size < minimum) fail('invalid string command');
      const offset = b.readUInt32LE(at + 8);
      if (offset < minimum || offset >= size || b.subarray(at + offset, at + size).indexOf(0) < 0) fail('invalid command string');
    } else if (cmd === 0x32) {
      if (size < 24 || size !== 24 + b.readUInt32LE(at + 20) * 8) fail('invalid build command');
    } else fail('unsupported load command');
    at += size;
  }
  disjoint(segments);
  if (at !== end || !signature || !linkedit) fail('missing signature/LINKEDIT or command count mismatch');
  range(signature.offset, signature.size, b.length);
  if (signature.offset < end || signature.size < 12 || signature.size > MAX_SIGNATURE || signature.offset + signature.size !== b.length || signature.offset < linkedit.offset) fail('invalid signature extent');
  range(signature.offset, signature.size, linkedit.offset + linkedit.size);
  return signature;
}
const slotMagic = new Map([[0, 0xfade0c02], [2, 0xfade0c01], [5, 0xfade7171],
  [7, 0xfade7172], [8, 0xfade8181], [9, 0xfade8181], [10, 0xfade8181],
  [11, 0xfade8181], [0x10000, 0xfade0b01]]);
function components(sb) {
  if (sb.readUInt32BE(0) !== 0xfade0cc0) fail('unsupported SuperBlob');
  const length = sb.readUInt32BE(4), count = sb.readUInt32BE(8), end = 12 + count * 8;
  range(0, length, sb.length);
  if (!count || count > slotMagic.size || end > length) fail('invalid signature index');
  const result = new Map(), ranges = [{ offset: 0, size: end }];
  for (let i = 0; i < count; i++) {
    const type = sb.readUInt32BE(12 + i * 8), offset = sb.readUInt32BE(16 + i * 8);
    if (!slotMagic.has(type) || result.has(type)) fail('unsupported/duplicate signature slot');
    range(offset, 8, length);
    const size = sb.readUInt32BE(offset + 4);
    if (offset < end || size < 8 || sb.readUInt32BE(offset) !== slotMagic.get(type)) fail('invalid signature component');
    range(offset, size, length);
    ranges.push({ offset, size }); result.set(type, sb.subarray(offset, offset + size));
  }
  disjoint(ranges);
  // Permit zero alignment/allocation padding only, not hidden unindexed blobs.
  ranges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) zero(sb.subarray(ranges[i - 1].offset + ranges[i - 1].size, ranges[i].offset));
  const last = ranges.at(-1); zero(sb.subarray(last.offset + last.size));
  if (!result.has(0) || !result.has(11) || result.get(11).length <= 8) fail('missing CodeDirectory/library constraint');
  return result;
}
function directory(b, signature, blobs) {
  const cd = blobs.get(0);
  if (cd.length < 88) fail('truncated CodeDirectory');
  const version = cd.readUInt32BE(8), header = new Map([[0x20400, 88], [0x20500, 96], [0x20600, 108]]).get(version);
  if (!header || cd.length < header || cd[36] !== 32 || cd[37] !== 2 || cd[38] !== 0 || ![12, 14].includes(cd[39])) fail('unsupported CodeDirectory profile');
  zero(cd.subarray(40, 48)); zero(cd.subarray(52, 64));
  if (version >= 0x20500) zero(cd.subarray(92, 96));
  if (version >= 0x20600) zero(cd.subarray(96, 108));
  const hashes = cd.readUInt32BE(16), special = cd.readUInt32BE(24), pages = cd.readUInt32BE(28), limit = cd.readUInt32BE(32), pageSize = 2 ** cd[39];
  // CS_ALLOWED_MACHO and CS_EXECSEG_* from the pinned cs_blobs.h. These
  // are framing restrictions, NOT an assertion that any mode grants authority.
  if ((cd.readUInt32BE(12) & ~0x00033f02) !== 0 || (cd.readBigUInt64BE(80) & ~0x3f1n) !== 0n) fail('unsupported CodeDirectory flags');
  range(Number(cd.readBigUInt64BE(64)), Number(cd.readBigUInt64BE(72)), limit);
  if (special !== 11 || limit !== signature.offset || pages !== Math.ceil(limit / pageSize)) fail('unsupported special slots/coverage');
  const hashStart = hashes - special * 32;
  range(hashStart, (special + pages) * 32, cd.length);
  if (hashStart < header || hashes + pages * 32 !== cd.length) fail('invalid hash table');
  const ranges = [{ offset: 0, size: header }, { offset: hashStart, size: cd.length - hashStart }];
  for (const [field, required] of [[20, true], [48, false]]) {
    const offset = cd.readUInt32BE(field);
    if (!offset && !required) continue;
    if (offset < header || offset >= hashStart) fail('invalid CodeDirectory string');
    const nul = cd.indexOf(0, offset);
    if (nul <= offset || nul >= hashStart) fail('unterminated CodeDirectory string');
    ranges.push({ offset, size: nul + 1 - offset });
  }
  disjoint(ranges); ranges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) zero(cd.subarray(ranges[i - 1].offset + ranges[i - 1].size, ranges[i].offset));
  // Slot 6 is not defined in this profile; slot 4 application data unsupported.
  for (const slot of [4, 6]) zero(cd.subarray(hashes - slot * 32, hashes - (slot - 1) * 32));
  for (const slot of [2, 5, 7, 8, 9, 10, 11]) {
    const embedded = cd.subarray(hashes - slot * 32, hashes - (slot - 1) * 32), blob = blobs.get(slot);
    if (blob ? !sha256(blob).equals(embedded) : embedded.some(v => v !== 0)) fail('special slot hash mismatch');
  }
  // Bind the actual load commands/slice bytes too, not merely an appended CD.
  for (let i = 0; i < pages; i++) if (!sha256(b.subarray(i * pageSize, Math.min((i + 1) * pageSize, limit))).equals(cd.subarray(hashes + i * 32, hashes + (i + 1) * 32))) fail('code page hash mismatch');
  return { cdHash: sha256(cd).subarray(0, 20), codeDirectoryVersion: version };
}

/**
 * expected = { cdHash: Buffer(20), slice: {offset, size, cpuType, cpuSubtype} }.
 * All fat slices must satisfy the supported envelope profile; only the selected
 * slice is kernel-bound. No architecture fallback, guessed slice, or hex coercion.
 * Returned rawBlob includes the authenticated 8-byte generic-blob header. It is
 * a detached copy. policyStatus is ALWAYS unsupported, even for plausible DER.
 * Input buffers must not be concurrently mutated; SharedArrayBuffer is rejected.
 */
export function extractAuthenticatedLibraryConstraint(bytes, expected) {
  if (!Buffer.isBuffer(bytes) || bytes.buffer instanceof SharedArrayBuffer || bytes.length < 32 || bytes.length > MAX_BYTES) fail('invalid artifact bytes');
  if (!Buffer.isBuffer(expected?.cdHash) || expected.cdHash.buffer instanceof SharedArrayBuffer || expected.cdHash.length !== 20 || !expected.slice) fail('missing kernel evidence');
  const keys = ['offset', 'size', 'cpuType', 'cpuSubtype'];
  if (keys.some(k => !Number.isSafeInteger(expected.slice[k]) || expected.slice[k] < 0)) fail('invalid expected slice');
  const all = slices(bytes), selected = all.find(s => keys.every(k => s[k] === expected.slice[k]));
  if (!selected) fail('kernel slice mismatch');
  let result;
  for (const slice of all) {
    const b = bytes.subarray(slice.offset, slice.offset + slice.size), signature = signatureRange(b, slice);
    const blobs = components(b.subarray(signature.offset, signature.offset + signature.size));
    const metadata = directory(b, signature, blobs);
    if (slice === selected) {
      if (!metadata.cdHash.equals(expected.cdHash)) fail('kernel CDHash mismatch');
      result = { rawBlob: Buffer.from(blobs.get(11)), slice: { ...slice },
        codeDirectoryVersion: metadata.codeDirectoryVersion, policyStatus: 'unsupported' };
    }
  }
  return result;
}

/**
 * Read-only, NON-AUTHORIZING packaged-parent data extraction. The packaging
 * caller must separately codesign-verify the actual signed parent artifact
 * before calling, and ensure these bytes are from that same artifact. This
 * function cannot establish that provenance or close file races.
 *
 * Returns an array in fat-table order (one entry for thin Mach-O), each with
 * { rawBlob, slice, codeDirectoryVersion, policyStatus: 'unsupported',
 *   productionAuthority: false }. rawBlob is a detached whole slot-11 blob;
 * slice is { offset, size, cpuType, cpuSubtype }. Every slice must pass before
 * anything is returned. Only MH_EXECUTE and the existing narrow profile apply.
 *
 * CMS is opaque DATA, not verified here; hash checks establish self-consistency
 * only. No CDHash is accepted as kernel evidence or exported, and no signer,
 * policy, or loaded-code authority is claimed (even if CMS is present).
 * Input must not be concurrently mutated; SharedArrayBuffer is rejected.
 */
export function extractPackagedParentLibraryConstraints(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.buffer instanceof SharedArrayBuffer || bytes.length < 32 || bytes.length > MAX_BYTES) fail('invalid artifact bytes');
  return slices(bytes).map(slice => {
    const b = bytes.subarray(slice.offset, slice.offset + slice.size);
    if (b.readUInt32LE(12) !== 2) fail('packaged parent must be MH_EXECUTE');
    const signature = signatureRange(b, slice);
    const blobs = components(b.subarray(signature.offset, signature.offset + signature.size));
    const metadata = directory(b, signature, blobs);
    return { rawBlob: Buffer.from(blobs.get(11)), slice: { ...slice },
      codeDirectoryVersion: metadata.codeDirectoryVersion, policyStatus: 'unsupported',
      productionAuthority: false };
  });
}

/**
 * Separate NON-AUTHORIZING collector for a never-executed ad-hoc format fixture.
 * No expected/kernel CDHash is fabricated. SHA256(CodeDirectory) is computed by
 * directory() for self-consistency metadata only and discarded, never exported.
 * Thin Mach-O only; fixed collector checks its architecture separately. This
 * proves neither DER semantics nor kernel/CMS/signer/loaded-image provenance.
 */
export function extractStaticLibraryConstraintFormat(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.buffer instanceof SharedArrayBuffer || bytes.length < 32 || bytes.length > 4 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0xfeedfacf) fail('unsupported static fixture');
  const slice = { offset: 0, size: bytes.length, cpuType: bytes.readUInt32LE(4), cpuSubtype: bytes.readUInt32LE(8) };
  const signature = signatureRange(bytes, slice);
  const blobs = components(bytes.subarray(signature.offset, signature.offset + signature.size));
  const metadata = directory(bytes, signature, blobs);
  // Ad-hoc, hardened-runtime executable only. The pinned Security signer.cpp
  // signCodeDirectoryWithIdentity returns zero-length CFData for kCFNull; the
  // Mach-O signing path still wraps it in cdSignatureSlot/BlobWrapper. Permit
  // that header-only wrapper (or no wrapper), never actual CMS content.
  if (bytes.readUInt32LE(12) !== 2 || (blobs.get(0).readUInt32BE(12) & 0x10002) !== 0x10002 ||
      (blobs.has(0x10000) && blobs.get(0x10000).length !== 8) || blobs.get(11).length > 16 * 1024) fail('unsupported static fixture signature');
  return { kind: 'static-format-fixture', rawBlob: Buffer.from(blobs.get(11)),
    codeDirectoryVersion: metadata.codeDirectoryVersion, policyStatus: 'unsupported' };
}

/** No path, team-only, static-signature, or raw-extraction fallback is safe. */
export function verifyLibraryConstraintPolicy() {
  const error = new Error('macOS library constraint: DER policy validation unsupported; native format evidence required');
  error.code = 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_UNSUPPORTED';
  throw error;
}
