// Synthetic Mach-O/CodeDirectory fixtures ONLY: no CMS, signer or native execution.
import { createHash } from 'node:crypto';
import { integritySentinel, integritySlots } from './mac-asar-integrity.mjs';
export const fuseOffset = 512, digestOffset = 4352, signatureOffset = 8192;
export function thinFramework(cpu = 0x0100000c, wire = '101100011') {
  const b = Buffer.alloc(8704);
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4); b.writeUInt32LE(cpu === 0x01000007 ? 3 : 0, 8);
  b.writeUInt32LE(6, 12); b.writeUInt32LE(4, 16); b.writeUInt32LE(312, 20);
  function segment(at, name, offset, size, sections = 0) {
    b.writeUInt32LE(0x19, at); b.writeUInt32LE(72 + 80 * sections, at + 4); b.write(name, at + 8);
    b.writeBigUInt64LE(BigInt(offset), at + 24); b.writeBigUInt64LE(BigInt(size), at + 32);
    b.writeBigUInt64LE(BigInt(offset), at + 40); b.writeBigUInt64LE(BigInt(size), at + 48);
    b.writeUInt32LE(3, at + 56); b.writeUInt32LE(3, at + 60); b.writeUInt32LE(sections, at + 64);
  }
  segment(32, '__TEXT', 0, 4096);
  segment(104, '__DATA_CONST', 4096, 4096, 1);
  b.write('__asar_integrity', 176); b.write('__DATA_CONST', 192);
  b.writeBigUInt64LE(BigInt(digestOffset), 208); b.writeBigUInt64LE(66n, 216); b.writeUInt32LE(digestOffset, 224);
  segment(256, '__LINKEDIT', signatureOffset, 512);
  b.writeUInt32LE(0x1d, 328); b.writeUInt32LE(16, 332); b.writeUInt32LE(signatureOffset, 336); b.writeUInt32LE(512, 340);
  Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX').copy(b, fuseOffset);
  b[fuseOffset + 32] = 1; b[fuseOffset + 33] = wire.length; b.write(wire, fuseOffset + 34);
  integritySentinel.copy(b, digestOffset);
  // An intentionally unauthenticated SHA256 CodeDirectory with two page hashes.
  b.writeUInt32BE(0xfade0cc0, signatureOffset); b.writeUInt32BE(184, signatureOffset + 4); b.writeUInt32BE(1, signatureOffset + 8);
  b.writeUInt32BE(0, signatureOffset + 12); b.writeUInt32BE(20, signatureOffset + 16);
  const cd = signatureOffset + 20;
  b.writeUInt32BE(0xfade0c02, cd); b.writeUInt32BE(164, cd + 4); b.writeUInt32BE(0x20500, cd + 8);
  b.writeUInt32BE(0x10000, cd + 12); b.writeUInt32BE(100, cd + 16); b.writeUInt32BE(96, cd + 20);
  b.writeUInt32BE(2, cd + 28); b.writeUInt32BE(signatureOffset, cd + 32); b[cd + 36] = 32; b[cd + 37] = 2; b[cd + 39] = 12;
  b.write('id\0', cd + 96); // No CMS: this never constitutes an authentic signature.
  for (let p = 0; p < 2; p++) createHash('sha256').update(b.subarray(p * 4096, (p + 1) * 4096)).digest().copy(b, cd + 100 + p * 32);
  return b;
}
export function universalFramework(a = thinFramework(0x01000007), b = thinFramework(), fat64 = false) {
  const offsets = [4096, Math.ceil((4096 + a.length) / 4096) * 4096];
  const out = Buffer.alloc(offsets[1] + b.length), stride = fat64 ? 32 : 20;
  out.writeUInt32BE(fat64 ? 0xcafebabf : 0xcafebabe, 0); out.writeUInt32BE(2, 4);
  for (const [i, part] of [a, b].entries()) {
    const base = 8 + i * stride;
    out.writeUInt32BE(part.readUInt32LE(4), base); out.writeUInt32BE(part.readUInt32LE(8), base + 4);
    if (fat64) { out.writeBigUInt64BE(BigInt(offsets[i]), base + 8); out.writeBigUInt64BE(BigInt(part.length), base + 16); }
    else { out.writeUInt32BE(offsets[i], base + 8); out.writeUInt32BE(part.length, base + 12); }
    out.writeUInt32BE(12, base + (fat64 ? 24 : 16)); part.copy(out, offsets[i]);
  }
  return out;
}
export function syntheticPageHashes(bytes) {
  const out = Buffer.from(bytes);
  for (const s of integritySlots(out)) {
    const cd = s.offset + s.signature.offset + 20;
    for (let p = 0; p < 2; p++) createHash('sha256').update(out.subarray(s.offset + p * 4096, s.offset + (p + 1) * 4096)).digest().copy(out, cd + 100 + p * 32);
  }
  return out;
}
