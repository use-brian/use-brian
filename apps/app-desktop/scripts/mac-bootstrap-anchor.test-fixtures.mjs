// SYNTHETIC envelope/signature fixtures. No Apple/CMS/native acceptance evidence.
import { createHash } from 'node:crypto';
import { emptyBootstrapApprovalRecord } from './mac-bootstrap-anchor.mjs';
export const anchorOffset = 0x1e00, signatureOffset = 0x3000, signatureSize = 2048;
export const sha = b => createHash('sha256').update(b).digest();
export function approval(count = 2) {
  return { electronVersion: '43.2.0', asarDigest: Buffer.alloc(32, 0x55), libraryCDHashes: Array.from({ length: count }, (_, i) => {
    const b = Buffer.alloc(20); b.writeUInt32BE(i + 1, 16); return b;
  }) };
}
export function component(magic, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(magic); b.writeUInt32BE(b.length, 4); payload.copy(b, 8); return b;
}
export function thin({ signed = true, cpu = 0x0100000c, flags = 0x20002, version = 0x20400,
  page = 12, team = false, special = 0, extra = [] } = {}) {
  const b = Buffer.alloc(signatureOffset + signatureSize);
  b.writeUInt32LE(0xfeedfacf); b.writeUInt32LE(cpu, 4); b.writeUInt32LE(cpu === 0x01000007 ? 3 : 0, 8);
  b.writeUInt32LE(2, 12); b.writeUInt32LE(signed ? 4 : 3, 16); b.writeUInt32LE(signed ? 312 : 296, 20);
  function segment(at, name, offset, size, sections = 0) {
    b.writeUInt32LE(0x19, at); b.writeUInt32LE(72 + sections * 80, at + 4); b.write(name, at + 8);
    b.writeBigUInt64LE(BigInt(offset), at + 24); b.writeBigUInt64LE(BigInt(size), at + 32);
    b.writeBigUInt64LE(BigInt(offset), at + 40); b.writeBigUInt64LE(BigInt(size), at + 48);
    b.writeUInt32LE(3, at + 56); b.writeUInt32LE(3, at + 60); b.writeUInt32LE(sections, at + 64);
  }
  segment(32, '__TEXT', 0, 4096); segment(104, '__DATA_CONST', 4096, 8192, 1); b.writeUInt32LE(0x10, 172);
  b.write('__br_bootstrap', 176); b.write('__DATA_CONST', 192);
  b.writeBigUInt64LE(BigInt(anchorOffset), 208); b.writeBigUInt64LE(1376n, 216); b.writeUInt32LE(anchorOffset, 224);
  b.writeUInt32LE(4, 228); b.writeUInt32LE(0x10000000, 240);
  segment(256, '__LINKEDIT', signatureOffset, signatureSize);
  emptyBootstrapApprovalRecord().copy(b, anchorOffset);
  if (!signed) return b;
  b.writeUInt32LE(0x1d, 328); b.writeUInt32LE(16, 332); b.writeUInt32LE(signatureOffset, 336); b.writeUInt32LE(signatureSize, 340);
  const header = new Map([[0x20400, 88], [0x20500, 96], [0x20600, 108]]).get(version);
  const ident = Buffer.from('synthetic-anchor\0'), teamBytes = team ? Buffer.from('FAKETEAM00\0') : Buffer.alloc(0);
  const hashStart = header + ident.length + teamBytes.length, hashes = hashStart + special * 32, pages = Math.ceil(signatureOffset / 2 ** page);
  const cd = Buffer.alloc(hashes + pages * 32);
  cd.writeUInt32BE(0xfade0c02); cd.writeUInt32BE(cd.length, 4); cd.writeUInt32BE(version, 8); cd.writeUInt32BE(flags, 12);
  cd.writeUInt32BE(hashes, 16); cd.writeUInt32BE(header, 20); cd.writeUInt32BE(special, 24); cd.writeUInt32BE(pages, 28);
  cd.writeUInt32BE(signatureOffset, 32); cd[36] = 32; cd[37] = 2; cd[39] = page;
  if (team) cd.writeUInt32BE(header + ident.length, 48);
  cd.writeBigUInt64BE(4096n, 72); cd.writeBigUInt64BE(1n, 80);
  ident.copy(cd, header); teamBytes.copy(cd, header + ident.length);
  for (const [slot, bytes] of extra) if (slot <= special && slot > 0) sha(bytes).copy(cd, hashes - slot * 32);
  const components = [[0, cd], ...extra], sb = b.subarray(signatureOffset);
  sb.writeUInt32BE(0xfade0cc0); sb.writeUInt32BE(components.length, 8);
  let at = 12 + components.length * 8;
  for (const [i, [slot, data]] of components.entries()) {
    sb.writeUInt32BE(slot, 12 + i * 8); sb.writeUInt32BE(at, 16 + i * 8); data.copy(sb, at); at += data.length;
  }
  sb.writeUInt32BE(at, 4); rehash(b); return b;
}
export function cdOffset(b) { return signatureOffset + b.readUInt32BE(signatureOffset + 16); }
// Synthetic signature-page rehashing, never CMS/signer authentication.
export function rehash(b) {
  const cd = cdOffset(b), hashes = b.readUInt32BE(cd + 16), pages = b.readUInt32BE(cd + 28), page = 2 ** b[cd + 39];
  for (let p = 0; p < pages; p++) sha(b.subarray(p * page, Math.min((p + 1) * page, signatureOffset))).copy(b, cd + hashes + p * 32);
  return b;
}
export function fat(a = thin({ cpu: 0x01000007 }), b = thin(), wide = false) {
  const offsets = [4096, 20480], stride = wide ? 32 : 20, out = Buffer.alloc(offsets[1] + b.length);
  out.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe); out.writeUInt32BE(2, 4);
  for (const [i, part] of [a, b].entries()) {
    const at = 8 + i * stride;
    out.writeUInt32BE(part.readUInt32LE(4), at); out.writeUInt32BE(part.readUInt32LE(8), at + 4);
    if (wide) { out.writeBigUInt64BE(BigInt(offsets[i]), at + 8); out.writeBigUInt64BE(BigInt(part.length), at + 16); }
    else { out.writeUInt32BE(offsets[i], at + 8); out.writeUInt32BE(part.length, at + 12); }
    out.writeUInt32BE(12, at + (wide ? 24 : 16)); part.copy(out, offsets[i]);
  }
  return out;
}
export function fatRehash(bytes) {
  const wide = bytes.readUInt32BE(0) === 0xcafebabf, stride = wide ? 32 : 20;
  for (let i = 0; i < 2; i++) {
    const at = 8 + stride * i;
    const offset = wide ? Number(bytes.readBigUInt64BE(at + 8)) : bytes.readUInt32BE(at + 8);
    const size = wide ? Number(bytes.readBigUInt64BE(at + 16)) : bytes.readUInt32BE(at + 12);
    rehash(bytes.subarray(offset, offset + size));
  }
  return bytes;
}
