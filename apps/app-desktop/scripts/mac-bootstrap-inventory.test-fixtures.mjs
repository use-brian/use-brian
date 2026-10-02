// Independently constructed synthetic Mach-O/CD envelopes; NOT native signing
// evidence, NOT CMS/Developer-ID fixtures. No subprocess, signing or credentials.
import { createHash } from 'node:crypto';
export const signatureOffset = 4096, signatureSize = 4096;
export const digest = b => createHash('sha256').update(b).digest();
export function blob(magic, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(magic); b.writeUInt32BE(b.length, 4); payload.copy(b, 8); return b;
}
export function nativeFile({ cpu = 0x0100000c, type = 6, id = 'inventory-fixture', version = 0x20500, signed = true,
  flags = 0x10000, special = 0, extra = [], external = {}, page = 12, team = false } = {}) {
  const b = Buffer.alloc(signatureOffset + signatureSize);
  b.writeUInt32LE(0xfeedfacf); b.writeUInt32LE(cpu, 4); b.writeUInt32LE(cpu === 0x01000007 ? 3 : 0, 8);
  b.writeUInt32LE(type, 12); b.writeUInt32LE(signed ? 3 : 2, 16); b.writeUInt32LE(signed ? 160 : 144, 20);
  for (const [at, name, off, size] of [[32, '__TEXT', 0, signatureOffset], [104, '__LINKEDIT', signatureOffset, signatureSize]]) {
    b.writeUInt32LE(0x19, at); b.writeUInt32LE(72, at + 4); b.write(name, at + 8);
    b.writeBigUInt64LE(BigInt(off), at + 24); b.writeBigUInt64LE(BigInt(size), at + 32);
    b.writeBigUInt64LE(BigInt(off), at + 40); b.writeBigUInt64LE(BigInt(size), at + 48);
    b.writeUInt32LE(5, at + 56); b.writeUInt32LE(5, at + 60);
  }
  if (!signed) return b;
  b.writeUInt32LE(0x1d, 176); b.writeUInt32LE(16, 180); b.writeUInt32LE(signatureOffset, 184); b.writeUInt32LE(signatureSize, 188);
  const header = new Map([[0x20400, 88], [0x20500, 96], [0x20600, 108]]).get(version);
  const identifier = Buffer.from(id + '\0'), teamBytes = team ? Buffer.from('FAKETEAM00\0') : Buffer.alloc(0);
  const start = header + identifier.length + teamBytes.length, hashes = start + special * 32;
  const cd = Buffer.alloc(hashes + 32);
  cd.writeUInt32BE(0xfade0c02); cd.writeUInt32BE(cd.length, 4); cd.writeUInt32BE(version, 8); cd.writeUInt32BE(flags, 12);
  cd.writeUInt32BE(hashes, 16); cd.writeUInt32BE(header, 20); cd.writeUInt32BE(special, 24); cd.writeUInt32BE(1, 28);
  cd.writeUInt32BE(signatureOffset, 32); cd[36] = 32; cd[37] = 2; cd[39] = page;
  if (team) cd.writeUInt32BE(header + identifier.length, 48);
  identifier.copy(cd, header); teamBytes.copy(cd, header + identifier.length);
  for (const [slot, bytes] of extra) if (slot > 0 && slot <= special) digest(bytes).copy(cd, hashes - slot * 32);
  for (const [slot, bytes] of Object.entries(external)) digest(bytes).copy(cd, hashes - Number(slot) * 32);
  digest(b.subarray(0, signatureOffset)).copy(cd, hashes);
  const components = [[0, cd], ...extra], sb = b.subarray(signatureOffset);
  sb.writeUInt32BE(0xfade0cc0); sb.writeUInt32BE(components.length, 8); let at = 12 + components.length * 8;
  for (const [i, [slot, data]] of components.entries()) {
    sb.writeUInt32BE(slot, 12 + i * 8); sb.writeUInt32BE(at, 16 + i * 8); data.copy(sb, at); at += data.length;
  }
  sb.writeUInt32BE(at, 4); return b;
}
export function codeDirectory(b) {
  const at = signatureOffset + b.readUInt32BE(signatureOffset + 16);
  return b.subarray(at, at + b.readUInt32BE(at + 4));
}
export function rehash(b) {
  const cd = codeDirectory(b), hashes = cd.readUInt32BE(16), pages = cd.readUInt32BE(28), page = 2 ** cd[39], limit = cd.readUInt32BE(32);
  for (let i = 0; i < pages; i++) digest(b.subarray(i * page, Math.min((i + 1) * page, limit))).copy(cd, hashes + i * 32);
  return b;
}
export function universal(a = nativeFile(), b = nativeFile({ cpu: 0x01000007 }), wide = false) {
  const offsets = [16384, 32768], out = Buffer.alloc(offsets[1] + b.length), stride = wide ? 32 : 20;
  out.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe); out.writeUInt32BE(2, 4);
  for (const [i, part] of [a, b].entries()) {
    const at = 8 + i * stride;
    out.writeUInt32BE(part.readUInt32LE(4), at); out.writeUInt32BE(part.readUInt32LE(8), at + 4);
    if (wide) { out.writeBigUInt64BE(BigInt(offsets[i]), at + 8); out.writeBigUInt64BE(BigInt(part.length), at + 16); }
    else { out.writeUInt32BE(offsets[i], at + 8); out.writeUInt32BE(part.length, at + 12); }
    out.writeUInt32BE(14, at + (wide ? 24 : 16)); part.copy(out, offsets[i]);
  }
  return out;
}
