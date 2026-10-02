// INTERNAL artifact-data APIs only; no CLI, I/O, signer invocation or authority.
// BootstrapApprovalAnchor.h defines this project's wire ABI (NOT an Apple ABI).
// Trusted release input must be independent of the parent being inspected.
// Exact signing order: finalize nested libraries -> collect complete non-Apple
// library CDHashes across approved arches + pinned Electron ASAR dictionary digest
// -> stamp empty helper -> final helper signature -> final outer app signature.
// No main/helper final CDHash in this record: that would create a signing cycle.
//
// Pre-sign accepts ONLY unsigned or intact linker-only ad-hoc SHA256 artifacts
// (flags exactly CS_ADHOC|CS_LINKER_SIGNED, no special slots/CMS/team). It never
// patches ordinary ad-hoc, runtime, Developer-ID or CMS-bearing artifacts. The
// linker flag is a structural pre-sign profile, NOT authenticated linker origin.
// It does NOT repair/remove signatures: linker hashes become STALE after stamping.
// Existing build.sh signs immediately; future integration MUST insert stamping
// before that signing step, not run this on its already signed release output.
// No build/signing hook is changed here. Post-sign verification is READ ONLY.
//
// Pins: https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/EXTERNAL_HEADERS/mach-o/loader.h
// LC_SEGMENT_64, section_64, LC_CODE_SIGNATURE, SG_READ_ONLY, S_ATTR_NO_DEAD_STRIP.
// https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/osfmk/kern/cs_blobs.h
// https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/bsd/kern/ubc_subr.c
// SHA256 CodeDirectory layout, linker/ad-hoc flags, special-slot whole-blob hashes.
// mac-asar-integrity.mjs was read for the page-coverage/section mapping pattern.
// Here ALL code pages including header/load commands are checked, not just data.
// Narrow little-endian arm64/x86_64 MH_EXECUTE only, 1..2 thin/fat32/fat64 slices.
// Unknown signature components/alternates/CD profiles/load commands fail closed.
// Known non-segment commands are FRAMED only, not a full dyld/relocation verifier.
//
// Inventory finality, completeness, and non-Apple classification cannot be
// inferred from a list of hashes; the trusted release pipeline must establish
// them independently, including approved architecture/dependency coverage.
// Static page-hash self-consistency is NOT CMS/signer/kernel/mapped-code proof.
// Runtime must use C's own volatile mapped symbol, never parent/disk expectations;
// future own-helper kernel/signature/page/exec-generation validation is mandatory.
// Team trust must independently come from the helper's valid Apple-issued
// signature. No Developer ID or native linker/layout acceptance is claimed here.
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const bootstrapAnchorSize = 1376;
export const bootstrapElectronVersion = '43.2.0';
const MARKER = Buffer.from('425249414e5f424f4f5453545241505f414e43484f525f56318ca1d3f9b76042', 'hex');
const SECTION = '__br_bootstrap', MAX_BYTES = 128 * 1024 * 1024;
const fail = () => { const e = new Error('Bootstrap anchor: unsupported, malformed, unsealed, or mismatched data'); e.code = 'ERR_MAC_BOOTSTRAP_ANCHOR'; throw e; };
const guard = action => { try { return action(); } catch { fail(); } };
const { isProxy, isUint8Array, isSharedArrayBuffer } = types;
const { getPrototypeOf, getOwnPropertyDescriptor: descriptor, getOwnPropertyDescriptors: descriptors } = Object;
const { apply, ownKeys } = Reflect;
const bufferPrototype = Buffer.prototype, alloc = Buffer.alloc, isBuffer = Buffer.isBuffer;
const ta = getPrototypeOf(Uint8Array.prototype), getLength = descriptor(ta, 'length').get, getBuffer = descriptor(ta, 'buffer').get, set = ta.set;
function copy(value, minimum, maximum = minimum) {
  if (isProxy(value) || !isUint8Array(value) || getPrototypeOf(value) !== bufferPrototype || !isBuffer(value)) fail();
  const length = apply(getLength, value, []);
  if (isSharedArrayBuffer(apply(getBuffer, value, [])) || length < minimum || length > maximum) fail();
  const b = alloc(length); apply(set, b, [value]); return b;
}
const hash = b => createHash('sha256').update(b).digest();
const zero = b => b.every(v => v === 0);
function requireZero(b) { if (!zero(b)) fail(); }
function range(offset, size, limit) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > limit || size > limit - offset) fail();
}
function disjoint(ranges) {
  const sorted = ranges.filter(r => r.size).sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].size) fail();
}
export function emptyBootstrapApprovalRecord() {
  const b = Buffer.alloc(bootstrapAnchorSize);
  MARKER.copy(b); b.writeUInt16BE(1, 32); b.writeUInt32BE(b.length, 36);
  b[46] = 20; b[47] = 32; b.write(bootstrapElectronVersion, 48, 'ascii'); return b;
}
function record(b, allowEmpty = false) {
  const base = emptyBootstrapApprovalRecord();
  if (b.length !== base.length || !b.subarray(0, 34).equals(base.subarray(0, 34)) || b[34] > 1 || b[35] !== 0 ||
      !b.subarray(36, 40).equals(base.subarray(36, 40)) || !b.subarray(46, 64).equals(base.subarray(46, 64))) fail();
  if (!b[34]) { if (!b.equals(base) || !allowEmpty) fail(); return null; }
  const count = b.readUInt16BE(44);
  if (!count || count > 64 || b.readUInt32BE(40) !== 96 + count * 20 || zero(b.subarray(64, 96))) fail();
  const hashes = [];
  for (let i = 0; i < count; i++) {
    const h = b.subarray(96 + i * 20, 116 + i * 20);
    if (zero(h) || (i && Buffer.compare(hashes[i - 1], h) >= 0)) fail();
    hashes.push(Buffer.from(h));
  }
  requireZero(b.subarray(96 + count * 20));
  // Detached internal data copies; Buffer contents remain mutable to the caller,
  // but can never change the input artifact/mapped anchor or any other result.
  return Object.freeze({ kind: 'bootstrap-approval-data', productionAuthority: false,
    electronVersion: bootstrapElectronVersion, asarDigest: Buffer.from(b.subarray(64, 96)), libraryCDHashes: Object.freeze(hashes) });
}
export function decodeBootstrapApprovalRecord(bytes) { return guard(() => record(copy(bytes, bootstrapAnchorSize))); }
function encode(approval) {
  if (!approval || isProxy(approval) || ![Object.prototype, null].includes(getPrototypeOf(approval))) fail();
  const keys = ownKeys(approval), d = descriptors(approval);
  if (keys.length !== 3 || !['electronVersion', 'asarDigest', 'libraryCDHashes'].every(k => keys.includes(k) && Object.hasOwn(d[k], 'value'))) fail();
  const list = d.libraryCDHashes.value;
  if (d.electronVersion.value !== bootstrapElectronVersion || isProxy(list) || !Array.isArray(list)) fail();
  const count = descriptor(list, 'length').value;
  if (count < 1 || count > 64 || ownKeys(list).length !== count + 1) fail();
  const b = emptyBootstrapApprovalRecord();
  b[34] = 1; b.writeUInt32BE(96 + count * 20, 40); b.writeUInt16BE(count, 44);
  copy(d.asarDigest.value, 32).copy(b, 64);
  for (let i = 0; i < count; i++) {
    const item = descriptor(list, String(i));
    if (!item || !Object.hasOwn(item, 'value')) fail();
    copy(item.value, 20).copy(b, 96 + i * 20);
  }
  record(b); return b; // Never sort, deduplicate, fill in or repair expectations.
}
export function encodeBootstrapApprovalRecord(approval) { return guard(() => encode(approval)); }
function name(b, offset) {
  const field = b.subarray(offset, offset + 16), nul = field.indexOf(0);
  if (nul >= 0) requireZero(field.subarray(nul));
  const text = field.subarray(0, nul < 0 ? 16 : nul);
  if (!text.length || text.some(v => v < 0x20 || v > 0x7e)) fail();
  return text.toString('ascii');
}
const fixed = new Map([[2, 24], [0xb, 80], [0x1b, 24], [0x24, 16], [0x26, 16], [0x29, 16], [0x2a, 16],
  [0x80000028, 24], [0x22, 48], [0x80000022, 48], [0x80000033, 16], [0x80000034, 16]]);
const strings = new Map([[0xc, 24], [0xd, 24], [0x80000018, 24], [0x8000001f, 24], [0x80000023, 24], [0xe, 12], [0x8000001c, 12]]);
function slots(bytes) {
  const slices = [], magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = bytes.readUInt32BE(4), stride = magic === 0xcafebabe ? 20 : 32, end = 8 + count * stride;
    if (count < 1 || count > 2) fail(); range(0, end, bytes.length);
    for (let i = 0; i < count; i++) {
      const at = 8 + i * stride;
      const offset = stride === 20 ? bytes.readUInt32BE(at + 8) : Number(bytes.readBigUInt64BE(at + 8));
      const size = stride === 20 ? bytes.readUInt32BE(at + 12) : Number(bytes.readBigUInt64BE(at + 16));
      const align = bytes.readUInt32BE(at + (stride === 20 ? 16 : 24));
      range(offset, size, bytes.length);
      if (offset < end || size < 32 || align > 30 || offset % (2 ** align)) fail();
      if (stride === 32) requireZero(bytes.subarray(at + 28, at + 32));
      slices.push({ offset, size, cpu: bytes.readUInt32BE(at), subtype: bytes.readUInt32BE(at + 4) });
    }
    disjoint(slices);
  } else slices.push({ offset: 0, size: bytes.length, cpu: bytes.readUInt32LE(4), subtype: bytes.readUInt32LE(8) });
  const cpus = new Set();
  for (const s of slices) {
    const b = bytes.subarray(s.offset, s.offset + s.size);
    if (cpus.has(s.cpu) || !((s.cpu === 0x01000007 && s.subtype === 3) || (s.cpu === 0x0100000c && s.subtype === 0)) ||
        b.readUInt32LE(0) !== 0xfeedfacf || b.readUInt32LE(4) !== s.cpu || b.readUInt32LE(8) !== s.subtype || b.readUInt32LE(12) !== 2) fail();
    cpus.add(s.cpu); requireZero(b.subarray(28, 32));
    const count = b.readUInt32LE(16), end = 32 + b.readUInt32LE(20);
    range(32, end - 32, b.length);
    if (!count || count > 4096 || end - 32 < count * 8) fail();
    let at = 32, anchor, signature, linkedit, headerMappings = 0;
    const segments = [], vmSegments = [], sections = [], vmSections = [], names = new Set(), sectionNames = new Set();
    for (let i = 0; i < count; i++) {
      range(at, 8, end);
      const cmd = b.readUInt32LE(at), size = b.readUInt32LE(at + 4);
      if (size < 8 || size % 8) fail(); range(at, size, end);
      if (cmd === 0x19) {
        if (size < 72) fail();
        const segment = name(b, at + 8), nsects = b.readUInt32LE(at + 64);
        if (names.has(segment) || nsects > 4096 || size !== 72 + nsects * 80) fail(); names.add(segment);
        const vmaddr = Number(b.readBigUInt64LE(at + 24)), vmsize = Number(b.readBigUInt64LE(at + 32));
        const fileoff = Number(b.readBigUInt64LE(at + 40)), filesize = Number(b.readBigUInt64LE(at + 48));
        const maxprot = b.readUInt32LE(at + 56), initprot = b.readUInt32LE(at + 60), segflags = b.readUInt32LE(at + 68);
        range(vmaddr, vmsize, Number.MAX_SAFE_INTEGER); range(fileoff, filesize, b.length);
        if (filesize > vmsize || (maxprot & ~7) || (initprot & ~maxprot) || (segflags & ~0x1f)) fail();
        segments.push({ offset: fileoff, size: filesize }); vmSegments.push({ offset: vmaddr, size: vmsize });
        if (segment === '__LINKEDIT') linkedit = { offset: fileoff, size: filesize };
        if (filesize && fileoff < end) {
          if (segment !== '__TEXT' || fileoff !== 0 || filesize < end || !(initprot & 1)) fail(); headerMappings++;
        }
        for (let j = 0; j < nsects; j++) {
          const a = at + 72 + j * 80, section = name(b, a), owner = name(b, a + 16), key = `${owner}/${section}`;
          if (sectionNames.has(key)) fail(); sectionNames.add(key);
          const address = Number(b.readBigUInt64LE(a + 32)), length = Number(b.readBigUInt64LE(a + 40));
          const offset = b.readUInt32LE(a + 48), align = b.readUInt32LE(a + 52), flags = b.readUInt32LE(a + 64), type = flags & 0xff;
          range(address, length, vmaddr + vmsize);
          if (owner !== segment || address < vmaddr || align > 30 || address % (2 ** align) || type > 0x16 || (flags & ~0xfe0007ff)) fail();
          vmSections.push({ offset: address, size: length });
          const zeroFill = [1, 0xc, 0x12].includes(type);
          if (!zeroFill) {
            range(offset, length, fileoff + filesize);
            if (offset < fileoff || (length && offset < end) || offset !== fileoff + address - vmaddr || offset % (2 ** align)) fail();
            sections.push({ offset, size: length });
          }
          if (section === SECTION) {
            if (anchor !== undefined || segment !== '__DATA_CONST' || flags !== 0x10000000 || length !== bootstrapAnchorSize || align !== 4 || zeroFill ||
                segflags !== 0x10 || !(initprot & 1) || (maxprot & 4) || b.readUInt32LE(a + 56) || b.readUInt32LE(a + 60) ||
                b.readUInt32LE(a + 68) || b.readUInt32LE(a + 72) || b.readUInt32LE(a + 76)) fail();
            record(b.subarray(offset, offset + bootstrapAnchorSize), true); anchor = offset;
          }
        }
      } else if (cmd === 0x1d) {
        if (signature || size !== 16) fail();
        signature = { offset: b.readUInt32LE(at + 8), size: b.readUInt32LE(at + 12) };
        range(signature.offset, signature.size, b.length);
        if (signature.offset < end || signature.size < 12 || signature.size > 8 * 1024 * 1024 || signature.offset % 16 || signature.offset + signature.size !== b.length) fail();
      } else if (fixed.has(cmd)) { if (size !== fixed.get(cmd)) fail(); }
      else if (strings.has(cmd)) {
        const minimum = strings.get(cmd); if (size < minimum) fail();
        const off = b.readUInt32LE(at + 8);
        if (off < minimum || off >= size || b.subarray(at + off, at + size).indexOf(0) < 0) fail();
      } else if (cmd === 0x32) { if (size < 24 || size !== 24 + b.readUInt32LE(at + 20) * 8) fail(); }
      else fail();
      at += size;
    }
    if (at !== end || anchor === undefined || headerMappings !== 1) fail();
    disjoint(segments); disjoint(vmSegments); disjoint(sections); disjoint(vmSections);
    if (signature) {
      if (!linkedit || signature.offset < linkedit.offset) fail();
      range(signature.offset, signature.size, linkedit.offset + linkedit.size); disjoint([...sections, signature]);
    }
    s.anchor = s.offset + anchor; s.signature = signature;
  }
  const positions = []; let at = -1;
  while ((at = bytes.indexOf(MARKER, at + 1)) !== -1) { positions.push(at); if (positions.length > slices.length) fail(); }
  if (positions.length !== slices.length || slices.some(s => !positions.includes(s.anchor))) fail();
  return slices;
}
const magicBySlot = new Map([[0, 0xfade0c02], [2, 0xfade0c01], [5, 0xfade7171], [7, 0xfade7172],
  [8, 0xfade8181], [9, 0xfade8181], [10, 0xfade8181], [11, 0xfade8181], [0x10000, 0xfade0b01]]);
function coverage(bytes, slice, linkerOnly = false) {
  if (!slice.signature) fail();
  const b = bytes.subarray(slice.offset, slice.offset + slice.size), sig = slice.signature, sb = b.subarray(sig.offset, sig.offset + sig.size);
  if (sb.readUInt32BE(0) !== 0xfade0cc0) fail();
  const length = sb.readUInt32BE(4), count = sb.readUInt32BE(8), end = 12 + count * 8;
  range(0, length, sb.length);
  if (!count || count > magicBySlot.size || end > length) fail();
  const components = new Map(), ranges = [{ offset: 0, size: end }];
  for (let i = 0; i < count; i++) {
    const slot = sb.readUInt32BE(12 + 8 * i), off = sb.readUInt32BE(16 + 8 * i);
    if (!magicBySlot.has(slot) || components.has(slot) || off < end) fail();
    range(off, 8, length);
    const size = sb.readUInt32BE(off + 4); range(off, size, length);
    if (size < 8 || sb.readUInt32BE(off) !== magicBySlot.get(slot)) fail();
    ranges.push({ offset: off, size }); components.set(slot, sb.subarray(off, off + size));
  }
  disjoint(ranges); ranges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) requireZero(sb.subarray(ranges[i - 1].offset + ranges[i - 1].size, ranges[i].offset));
  const last = ranges.at(-1); requireZero(sb.subarray(last.offset + last.size));
  const cd = components.get(0); if (!cd || cd.length < 88) fail();
  const version = cd.readUInt32BE(8), header = new Map([[0x20400, 88], [0x20500, 96], [0x20600, 108]]).get(version);
  if (!header || cd.length < header || cd[36] !== 32 || cd[37] !== 2 || cd[38] !== 0 || ![12, 14].includes(cd[39])) fail();
  requireZero(cd.subarray(40, 48)); requireZero(cd.subarray(52, 64));
  if (version >= 0x20500) requireZero(cd.subarray(92, 96));
  if (version >= 0x20600) requireZero(cd.subarray(96, 108));
  const flags = cd.readUInt32BE(12), team = cd.readUInt32BE(48), special = cd.readUInt32BE(24);
  if ((flags & ~0x33f02) || (cd.readBigUInt64BE(80) & ~0x3f1n)) fail();
  range(Number(cd.readBigUInt64BE(64)), Number(cd.readBigUInt64BE(72)), sig.offset);
  if (linkerOnly && (flags !== 0x20002 || team || special || components.size !== 1)) fail();
  const hashes = cd.readUInt32BE(16), pages = cd.readUInt32BE(28), limit = cd.readUInt32BE(32), pageSize = 2 ** cd[39];
  if (special > 11 || limit !== sig.offset || pages !== Math.ceil(limit / pageSize)) fail();
  const start = hashes - special * 32;
  range(start, (special + pages) * 32, cd.length);
  if (start < header || hashes + pages * 32 !== cd.length) fail();
  const parts = [{ offset: 0, size: header }, { offset: start, size: cd.length - start }];
  for (const off of [cd.readUInt32BE(20), ...(team ? [team] : [])]) {
    if (off < header || off >= start) fail();
    const nul = cd.indexOf(0, off); if (nul <= off || nul >= start) fail();
    parts.push({ offset: off, size: nul + 1 - off });
  }
  disjoint(parts); parts.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < parts.length; i++) requireZero(cd.subarray(parts[i - 1].offset + parts[i - 1].size, parts[i].offset));
  for (const slot of [2, 4, 5, 6, 7, 8, 9, 10, 11]) {
    const blob = components.get(slot);
    if (slot > special) { if (blob) fail(); continue; }
    const stored = cd.subarray(hashes - slot * 32, hashes - (slot - 1) * 32);
    if (blob ? !hash(blob).equals(stored) : !zero(stored)) fail();
  }
  // Slots 1/3 seal external Info.plist/resources, not interpreted here. CMS
  // wrapper contents are also opaque: a valid header/page table does NOT prove
  // a signature, certificate, team, Apple issuance or even CMS well-formedness.
  range(slice.anchor - slice.offset, bootstrapAnchorSize, limit);
  for (let p = 0; p < pages; p++) {
    if (!hash(b.subarray(p * pageSize, Math.min((p + 1) * pageSize, limit))).equals(cd.subarray(hashes + p * 32, hashes + (p + 1) * 32))) fail();
  }
}
function sameRecords(bytes, locations, expected) {
  let first;
  for (const s of locations) {
    const b = bytes.subarray(s.anchor, s.anchor + bootstrapAnchorSize); record(b);
    if ((first && !first.equals(b)) || (expected && !expected.equals(b))) fail();
    first = b;
  }
  return first;
}
/** Artifact readback only. NEVER substitute this for C's self/mapped read. */
export function readBootstrapApproval(bytes) {
  return guard(() => { const b = copy(bytes, 32, MAX_BYTES); return record(sameRecords(b, slots(b))); });
}
/** Empty anchor only; ALL slices validated before changing a detached copy. */
export function stampBootstrapApproval(bytes, approval) {
  return guard(() => {
    const b = copy(bytes, 32, MAX_BYTES), expected = encode(approval), locations = slots(b), empty = emptyBootstrapApprovalRecord();
    for (const s of locations) {
      if (!b.subarray(s.anchor, s.anchor + bootstrapAnchorSize).equals(empty)) fail();
      if (s.signature) coverage(b, s, true);
    }
    for (const s of locations) expected.copy(b, s.anchor);
    sameRecords(b, slots(b), expected);
    return b; // Signature is STALE if linker-signed. Final signing is mandatory.
  });
}
/** Static coverage only; expected approval must come from trusted build inputs. */
export function verifyBootstrapApprovalCoverage(bytes, approval) {
  return guard(() => {
    const b = copy(bytes, 32, MAX_BYTES), expected = encode(approval), locations = slots(b);
    sameRecords(b, locations, expected);
    for (const s of locations) coverage(b, s);
    return Object.freeze({ kind: 'static-bootstrap-anchor-coverage', slices: locations.length,
      pageHashCoverage: true, signatureAuthentication: false, productionAuthority: false });
  });
}
