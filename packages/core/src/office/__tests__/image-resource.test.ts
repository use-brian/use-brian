import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { MAX_OFFICE_IMAGE_DIMENSION_PX, normalizeOfficeImageResource } from '../image-resource.js'

describe('[COMP:office/image-resource] Office image normalization', () => {
  it('decodes, rotates, strips metadata, bounds dimensions, and hashes normalized bytes', async () => {
    const input = await sharp({ create: { width: 9_000, height: 4, channels: 3, background: '#336699' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const normalized = await normalizeOfficeImageResource(input)
    const decoded = await sharp(normalized.bytes).metadata()
    expect(normalized.mime).toBe('image/jpeg')
    expect(Math.max(normalized.widthPx, normalized.heightPx)).toBe(MAX_OFFICE_IMAGE_DIMENSION_PX)
    expect(decoded.orientation).toBeUndefined()
    expect(decoded.exif).toBeUndefined()
    expect(normalized.hash).toMatch(/^[a-f0-9]{64}$/)
    expect((await normalizeOfficeImageResource(input)).hash).toBe(normalized.hash)
  })

  it('accepts decoded PNG while rejecting spoofed and unsupported bytes', async () => {
    const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#ffffff' } }).png().toBuffer()
    expect(await normalizeOfficeImageResource(png)).toMatchObject({ mime: 'image/png', widthPx: 3, heightPx: 2 })
    await expect(normalizeOfficeImageResource(new TextEncoder().encode('not an image'))).rejects.toThrow('office_image_invalid')
    const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).webp().toBuffer()
    await expect(normalizeOfficeImageResource(webp)).rejects.toThrow('office_image_unsupported')
  })
})
