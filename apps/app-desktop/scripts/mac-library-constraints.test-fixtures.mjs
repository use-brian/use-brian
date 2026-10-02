// Synthetic envelope fixtures ONLY. Payload is deliberately NOT Apple LWCR DER.
// No signing tools, native credentials, downloaded binaries, or network access.
import { createHash } from 'node:crypto';
export const digest = b => createHash('sha256').update(b).digest();
export function fixture({ version = 0x20400, cpuType = 0x0100000c, cpuSubtype = 0, page = 12 } = {}) {
  const header = new Map([[0x20400, 88], [0x20500, 96], [0x20600, 108]]).get(version);
  const payload = Buffer.from('synthetic opaque payload, NOT DER');
  const raw = Buffer.alloc(8 + payload.length);
  raw.writeUInt32BE(0xfade8181, 0); raw.writeUInt32BE(raw.length, 4); payload.copy(raw, 8);
  const signature = 4096, hashStart = header + 10, hashes = hashStart + 11 * 32;
  const cd = Buffer.alloc(hashes + 32);
  cd.writeUInt32BE(0xfade0c02, 0); cd.writeUInt32BE(cd.length, 4);
  cd.writeUInt32BE(version, 8); cd.writeUInt32BE(hashes, 16); cd.writeUInt32BE(header, 20);
  cd.writeUInt32BE(11, 24); cd.writeUInt32BE(1, 28); cd.writeUInt32BE(signature, 32);
  cd[36] = 32; cd[37] = 2; cd[39] = page;
  cd.write('synthetic', header); digest(raw).copy(cd, hashStart);
  const sb = Buffer.alloc(28 + cd.length + raw.length);
  sb.writeUInt32BE(0xfade0cc0, 0); sb.writeUInt32BE(sb.length, 4); sb.writeUInt32BE(2, 8);
  sb.writeUInt32BE(0, 12); sb.writeUInt32BE(28, 16);
  sb.writeUInt32BE(11, 20); sb.writeUInt32BE(28 + cd.length, 24);
  cd.copy(sb, 28); raw.copy(sb, 28 + cd.length);
  const bytes = Buffer.alloc(signature + sb.length);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpuType, 4); bytes.writeUInt32LE(cpuSubtype, 8);
  bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(3, 16); bytes.writeUInt32LE(160, 20);
  for (const [at, name, off, len] of [[32, '__TEXT', 0, signature], [104, '__LINKEDIT', signature, sb.length]]) {
    bytes.writeUInt32LE(0x19, at); bytes.writeUInt32LE(72, at + 4); bytes.write(name, at + 8);
    bytes.writeBigUInt64LE(BigInt(len), at + 32);
    bytes.writeBigUInt64LE(BigInt(off), at + 40); bytes.writeBigUInt64LE(BigInt(len), at + 48);
  }
  bytes.writeUInt32LE(0x1d, 176); bytes.writeUInt32LE(16, 180);
  bytes.writeUInt32LE(signature, 184); bytes.writeUInt32LE(sb.length, 188);
  sb.copy(bytes, signature);
  const cdOffset = signature + 28, rawOffset = cdOffset + cd.length;
  const expected = { cdHash: Buffer.alloc(20), slice: { offset: 0, size: bytes.length, cpuType, cpuSubtype } };
  const f = { bytes, expected, cdOffset, rawOffset, hashes, hashStart, signature, raw };
  rebind(f); return f;
}
// Rebind synthetic kernel expectation after mutations. Does NOT repair special
// slots or invalid directory fields; tests can reach structural checks directly.
export function rebind(f, { pages = true } = {}) {
  if (pages) digest(f.bytes.subarray(0, f.signature)).copy(f.bytes, f.cdOffset + f.hashes);
  const length = f.rawOffset - f.cdOffset;
  f.expected.cdHash = digest(f.bytes.subarray(f.cdOffset, f.cdOffset + length)).subarray(0, 20);
}
export function fatFixture(wide = false) {
  const a = fixture(), b = fixture({ cpuType: 0x01000007, cpuSubtype: 3 });
  const offsetA = 4096, offsetB = 12288, stride = wide ? 32 : 20;
  const bytes = Buffer.alloc(offsetB + b.bytes.length);
  bytes.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe); bytes.writeUInt32BE(2, 4);
  for (const [i, f, off] of [[0, a, offsetA], [1, b, offsetB]]) {
    const at = 8 + i * stride;
    bytes.writeUInt32BE(f.expected.slice.cpuType, at); bytes.writeUInt32BE(f.expected.slice.cpuSubtype, at + 4);
    if (wide) { bytes.writeBigUInt64BE(BigInt(off), at + 8); bytes.writeBigUInt64BE(BigInt(f.bytes.length), at + 16); }
    else { bytes.writeUInt32BE(off, at + 8); bytes.writeUInt32BE(f.bytes.length, at + 12); }
    bytes.writeUInt32BE(12, at + (wide ? 24 : 16)); f.bytes.copy(bytes, off);
  }
  return { bytes, expected: { ...a.expected, slice: { ...a.expected.slice, offset: offsetA } }, a, b, offsetA, offsetB };
}
