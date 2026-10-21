/** Deterministic rounded mask for the existing RGBA Brian artwork. No resampling. */
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

export function decodePng(bytes) {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) throw new Error('Expected non-interlaced 8-bit RGBA PNG')
  const data = []
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const packed = inflateSync(Buffer.concat(data)), stride = width * 4, pixels = Buffer.alloc(stride * height)
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)]
    if (filter > 4) throw new Error('Unknown PNG filter')
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= 4 ? pixels[i - 4] : 0, b = y ? pixels[i - stride] : 0, c = y && x >= 4 ? pixels[i - stride - 4] : 0
      pixels[i] = (packed[y * (stride + 1) + x + 1] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]) & 255
    }
  }
  return { width, height, pixels }
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(body.length + 8)
  result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE(crc32(body), result.length - 4)
  return result
}

export function roundIcon(bytes) {
  const { width, height, pixels } = decodePng(bytes), radius = width * .25
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let coverage = 0
    for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) {
      const px = x + (sx + .5) / 8, py = y + (sy + .5) / 8
      const cx = Math.max(radius, Math.min(width - radius, px)), cy = Math.max(radius, Math.min(height - radius, py))
      if (Math.hypot(px - cx, py - cy) <= radius) coverage++
    }
    const i = (y * width + x) * 4 + 3
    pixels[i] = Math.min(pixels[i], Math.round(255 * coverage / 64))
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const scanlines = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  return Buffer.concat([bytes.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const size of [16, 32, 48, 128]) {
    const path = new URL(`../static/icon-${size}.png`, import.meta.url)
    writeFileSync(path, roundIcon(readFileSync(path)))
  }
  writeFileSync(new URL('../static-firefox/icon-32.png', import.meta.url), readFileSync(new URL('../static/icon-32.png', import.meta.url)))
}
