// Pinned ABI/algorithm: electron/electron v43.2.0, shell/common/asar/integrity_digest.mm.
// Static packaging checks only, NOT loaded-image attestation or CMS validation.
import { createHash } from 'node:crypto';

export const supportedElectronVersion = '43.2.0';
export const integritySentinel = Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A');
const SLOT_SIZE = 66, MAX_BYTES = 1024 ** 3;
const fail = message => { throw new Error(`macOS ASAR digest: ${message}`); };
const hash = bytes => createHash('sha256').update(bytes).digest();
export function requireElectronVersion(version) {
  if (version !== supportedElectronVersion) fail('unsupported Electron version');
}
const dictionary = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);

export function integrityDictionaryDigest(value) {
  if (!dictionary(value)) fail('invalid integrity dictionary');
  const keys = Object.keys(value);
  if (!keys.length || keys.length > 128 || Reflect.ownKeys(value).length !== keys.length) fail('invalid dictionary size/keys');
  const digest = createHash('sha256');
  // Deliberately support ASCII resource paths only. Their ordinal ordering agrees
  // with NSString NSLiteralSearch; do not approximate arbitrary Unicode collation.
  for (const key of keys.sort()) {
    if (key.length > 1024 || !/^Resources\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.asar$/.test(key)) fail('unsupported archive path');
    const item = value[key];
    if (!dictionary(item) || Reflect.ownKeys(item).length !== 2 || !Object.hasOwn(item, 'algorithm') || !Object.hasOwn(item, 'hash') ||
        item.algorithm !== 'SHA256' || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) fail('invalid integrity entry');
    // Exact Electron order, with NO separators and NO decoding of the hex hash.
    digest.update(key, 'utf8').update(item.algorithm, 'utf8').update(item.hash, 'utf8');
  }
  return digest.digest();
}

function range(start, size, limit) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start > limit || size > limit - start) fail('out-of-bounds range');
}
function disjoint(ranges) {
  const sorted = ranges.filter(r => r.size).sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].size) fail('overlapping ranges');
}
function name(bytes, offset) {
  const field = bytes.subarray(offset, offset + 16), nul = field.indexOf(0);
  if (nul >= 0 && field.subarray(nul).some(b => b !== 0)) fail('noncanonical Mach-O name');
  const text = field.subarray(0, nul < 0 ? 16 : nul);
  if (!text.length || text.some(b => b < 0x20 || b > 0x7e)) fail('unsupported Mach-O name');
  return text.toString('ascii');
}

export function integritySlots(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_BYTES) fail('invalid framework size');
  const slices = [], magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = bytes.readUInt32BE(4), stride = magic === 0xcafebabe ? 20 : 32;
    if (count < 1 || count > 2) fail('unsupported architecture count');
    const tableEnd = 8 + count * stride;
    range(0, tableEnd, bytes.length);
    for (let i = 0; i < count; i++) {
      const at = 8 + i * stride;
      const offset = stride === 20 ? bytes.readUInt32BE(at + 8) : Number(bytes.readBigUInt64BE(at + 8));
      const size = stride === 20 ? bytes.readUInt32BE(at + 12) : Number(bytes.readBigUInt64BE(at + 16));
      const alignment = bytes.readUInt32BE(at + (stride === 20 ? 16 : 24));
      range(offset, size, bytes.length);
      if (offset < tableEnd || size < 32 || alignment > 30 || offset % (2 ** alignment) || (stride === 32 && bytes.readUInt32BE(at + 28) !== 0)) fail('invalid fat slice');
      slices.push({ offset, size, cpu: bytes.readUInt32BE(at), subtype: bytes.readUInt32BE(at + 4) });
    }
    disjoint(slices);
  } else slices.push({ offset: 0, size: bytes.length, cpu: bytes.readUInt32LE(4), subtype: bytes.readUInt32LE(8) });
  const cpus = new Set(), slots = [];
  for (const slice of slices) {
    const b = bytes.subarray(slice.offset, slice.offset + slice.size);
    if (![0x01000007, 0x0100000c].includes(slice.cpu) || cpus.has(slice.cpu) ||
        !((slice.cpu === 0x01000007 && slice.subtype === 3) || (slice.cpu === 0x0100000c && slice.subtype === 0)) ||
        b.readUInt32LE(0) !== 0xfeedfacf || b.readUInt32LE(4) !== slice.cpu || b.readUInt32LE(8) !== slice.subtype || b.readUInt32LE(12) !== 6) fail('unsupported/duplicate framework architecture');
    cpus.add(slice.cpu);
    const count = b.readUInt32LE(16), commandBytes = b.readUInt32LE(20), commandEnd = 32 + commandBytes;
    range(32, commandBytes, b.length);
    if (!count || count > 4096 || commandBytes < count * 8) fail('invalid load commands');
    let cursor = 32, slot, signature;
    const segments = [], vmSegments = [], sections = [], segmentNames = new Set();
    let linkedit;
    for (let i = 0; i < count; i++) {
      range(cursor, 8, commandEnd);
      const command = b.readUInt32LE(cursor), size = b.readUInt32LE(cursor + 4);
      if (size < 8 || size % 8) fail('invalid load command size');
      range(cursor, size, commandEnd);
      if (command === 1) fail('32-bit segment in 64-bit framework');
      if (command === 0x19) { // LC_SEGMENT_64
        if (size < 72) fail('truncated segment');
        const segment = name(b, cursor + 8);
        if (segmentNames.has(segment)) fail('duplicate segment');
        segmentNames.add(segment);
        const vmaddr = Number(b.readBigUInt64LE(cursor + 24)), vmsize = Number(b.readBigUInt64LE(cursor + 32));
        const fileoff = Number(b.readBigUInt64LE(cursor + 40)), filesize = Number(b.readBigUInt64LE(cursor + 48));
        range(vmaddr, vmsize, Number.MAX_SAFE_INTEGER); range(fileoff, filesize, b.length);
        if (filesize > vmsize) fail('segment filesize exceeds vmsize');
        if (segment === '__LINKEDIT') linkedit = { offset: fileoff, size: filesize };
        const maxprot = b.readUInt32LE(cursor + 56), initprot = b.readUInt32LE(cursor + 60);
        if ((maxprot & ~7) || (initprot & ~maxprot)) fail('invalid segment protections');
        segments.push({ offset: fileoff, size: filesize }); vmSegments.push({ offset: vmaddr, size: vmsize });
        const nsects = b.readUInt32LE(cursor + 64);
        if (nsects > 4096 || size !== 72 + nsects * 80) fail('invalid section table');
        for (let j = 0; j < nsects; j++) {
          const at = cursor + 72 + j * 80;
          const section = name(b, at), owner = name(b, at + 16);
          const address = Number(b.readBigUInt64LE(at + 32)), length = Number(b.readBigUInt64LE(at + 40));
          const offset = b.readUInt32LE(at + 48), align = b.readUInt32LE(at + 52), flags = b.readUInt32LE(at + 64);
          range(address, length, vmaddr + vmsize);
          if (owner !== segment || address < vmaddr || align > 30 || address % (2 ** align)) fail('invalid section address/owner');
          const zeroFill = [1, 0xc, 0x12].includes(flags & 0xff);
          if (!zeroFill) {
            range(offset, length, fileoff + filesize);
            if (offset < fileoff || (length && offset < commandEnd) || offset !== fileoff + address - vmaddr || offset % (2 ** align)) fail('invalid file-backed section');
            sections.push({ offset, size: length });
          }
          if (section === '__asar_integrity') {
            if (slot !== undefined || segment !== '__DATA_CONST' || flags !== 0 || length !== SLOT_SIZE || zeroFill ||
                !(b.readUInt32LE(cursor + 60) & 1) || (b.readUInt32LE(cursor + 60) & 4) ||
                b.readUInt32LE(at + 60) !== 0 || b.readUInt32LE(at + 56) !== 0 ||
                b.readUInt32LE(at + 68) !== 0 || b.readUInt32LE(at + 72) !== 0 || b.readUInt32LE(at + 76) !== 0) fail('invalid/duplicate integrity section');
            if (!b.subarray(offset, offset + 32).equals(integritySentinel)) fail('missing integrity sentinel');
            slot = offset;
          }
        }
      } else if (command === 0x1d) { // LC_CODE_SIGNATURE
        if (signature || size !== 16) fail('duplicate/invalid signature command');
        signature = { offset: b.readUInt32LE(cursor + 8), size: b.readUInt32LE(cursor + 12) };
        range(signature.offset, signature.size, b.length);
        if (signature.offset < commandEnd || signature.size < 12) fail('invalid signature range');
      }
      cursor += size;
    }
    if (cursor !== commandEnd || slot === undefined) fail('missing section or inconsistent load command count');
    disjoint(segments); disjoint(vmSegments); disjoint(sections);
    if (signature) {
      if (!linkedit || signature.offset < linkedit.offset) fail('signature outside LINKEDIT');
      range(signature.offset, signature.size, linkedit.offset + linkedit.size);
      disjoint([...sections, signature]);
    }
    slots.push({ ...slice, slot: slice.offset + slot, signature });
  }
  const positions = []; let at = -1;
  while ((at = bytes.indexOf(integritySentinel, at + 1)) !== -1) {
    positions.push(at); if (positions.length > slots.length) fail('extra integrity sentinel');
  }
  if (positions.length !== slots.length || slots.some(s => !positions.includes(s.slot))) fail('missing/ambiguous integrity sentinel coverage');
  return slots;
}

// Verify signature *coverage and page hashes*, not signer/CMS authenticity. The
// afterSign hook must additionally run codesign --verify --strict on the bundle.
function signatureCoverage(bytes, slice) {
  const signature = slice.signature;
  if (!signature) fail('missing final code signature');
  const b = bytes.subarray(slice.offset, slice.offset + slice.size);
  const sb = b.subarray(signature.offset, signature.offset + signature.size);
  if (sb.readUInt32BE(0) !== 0xfade0cc0) fail('unsupported signature container');
  const length = sb.readUInt32BE(4), count = sb.readUInt32BE(8);
  range(0, length, sb.length);
  if (!count || count > 64 || 12 + count * 8 > length) fail('invalid signature index');
  const ranges = [], types = new Set(); let directories = 0;
  for (let i = 0; i < count; i++) {
    const type = sb.readUInt32BE(12 + i * 8), offset = sb.readUInt32BE(16 + i * 8);
    if (types.has(type) || offset < 12 + count * 8) fail('duplicate/invalid signature slot');
    types.add(type); range(offset, 8, length);
    const size = sb.readUInt32BE(offset + 4); range(offset, size, length);
    if (size < 8) fail('invalid signature component');
    ranges.push({ offset, size });
    if (type !== 0 && !(type >= 0x1000 && type < 0x1005)) continue;
    directories++;
    const cd = sb.subarray(offset, offset + size);
    if (size < 88 || cd.readUInt32BE(0) !== 0xfade0c02) fail('invalid CodeDirectory');
    const version = cd.readUInt32BE(8);
    const headerSize = new Map([[0x20400, 88], [0x20500, 96], [0x20600, 108]]).get(version);
    if (!headerSize || size < headerSize || cd[37] !== 2 || cd[36] !== 32 || ![12, 14].includes(cd[39]) || cd.readUInt32BE(44) !== 0) fail('unsupported CodeDirectory profile');
    if (version >= 0x20500 && cd.readUInt32BE(92) !== 0) fail('unsupported pre-encrypted hashes');
    if (version >= 0x20600 && cd.subarray(96, 108).some(b => b !== 0)) fail('unsupported linkage profile');
    const limit64 = Number(cd.readBigUInt64BE(56));
    const codeLimit = limit64 || cd.readUInt32BE(32), pageSize = 2 ** cd[39];
    const hashes = cd.readUInt32BE(16), special = cd.readUInt32BE(24), pages = cd.readUInt32BE(28);
    if (special > 64 || hashes - special * 32 < headerSize || codeLimit !== signature.offset || pages !== Math.ceil(codeLimit / pageSize)) fail('invalid signature coverage');
    range(hashes, pages * 32, cd.length);
    const start = slice.slot - slice.offset;
    range(start, SLOT_SIZE, codeLimit);
    for (let p = Math.floor(start / pageSize); p <= Math.floor((start + SLOT_SIZE - 1) / pageSize); p++) {
      const actual = hash(b.subarray(p * pageSize, Math.min((p + 1) * pageSize, codeLimit)));
      if (!actual.equals(cd.subarray(hashes + p * 32, hashes + (p + 1) * 32))) fail('integrity slot page hash mismatch');
    }
  }
  disjoint(ranges);
  if (!types.has(0) || !directories) fail('missing CodeDirectory');
}

export function verifyIntegrityDigest(bytes, dictionary, { requireSignatureCoverage = true } = {}) {
  const digest = integrityDictionaryDigest(dictionary), slots = integritySlots(bytes);
  for (const slice of slots) {
    const at = slice.slot + 32;
    if (bytes[at] !== 1 || bytes[at + 1] !== 1 || !bytes.subarray(at + 2, at + 34).equals(digest)) fail('unused/unknown/incorrect integrity digest');
    if (requireSignatureCoverage) signatureCoverage(bytes, slice);
  }
  return slots.length;
}

export function populateIntegrityDigest(bytes, dictionary) {
  const digest = integrityDictionaryDigest(dictionary), slots = integritySlots(bytes);
  // Validate ALL architectures before changing any bytes. Recognize pristine
  // Electron or an already-populated v1 slot only; never repair unknown ABIs.
  for (const { slot } of slots) {
    const at = slot + 32;
    if (!((bytes[at] === 0 && bytes[at + 1] === 0 && bytes.subarray(at + 2, at + 34).every(b => b === 0)) ||
          (bytes[at] === 1 && bytes[at + 1] === 1))) fail('unknown/non-pristine integrity slot');
  }
  const result = Buffer.from(bytes);
  for (const { slot } of slots) {
    result[slot + 32] = 1; result[slot + 33] = 1; digest.copy(result, slot + 34);
  }
  verifyIntegrityDigest(result, dictionary, { requireSignatureCoverage: false });
  return result; // Existing signatures are now stale. No signing or ad-hoc repair.
}
