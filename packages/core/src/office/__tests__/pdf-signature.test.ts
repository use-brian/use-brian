import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  PDF_SIGNATURE_MAX_DIMENSION,
  normalizePdfSignatureImage,
} from '../pdf/index.js'

describe('[COMP:office/pdf-engine] PDF signature image normalization', () => {
  it('rotates JPEG input, strips metadata, and emits deterministic PNG bytes', async () => {
    const input = await sharp({
      create: { width: 7, height: 3, channels: 3, background: '#112233' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()

    const normalized = await normalizePdfSignatureImage(input, 'image/jpeg')
    const repeated = await normalizePdfSignatureImage(input, 'image/jpeg')
    const decoded = await sharp(normalized.bytes).metadata()

    expect(normalized).toMatchObject({ mime: 'image/png', width: 3, height: 7 })
    expect(normalized.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(repeated.sha256).toBe(normalized.sha256)
    expect(decoded.orientation).toBeUndefined()
    expect(decoded.exif).toBeUndefined()
  })

  it('rejects spoofed, unsupported, oversized, and over-dimension inputs', async () => {
    await expect(normalizePdfSignatureImage(new TextEncoder().encode('not an image'), 'image/png'))
      .rejects.toMatchObject({ code: 'signature_image_invalid' })

    const webp = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
    }).webp().toBuffer()
    await expect(normalizePdfSignatureImage(webp, 'image/webp'))
      .rejects.toMatchObject({ code: 'signature_image_invalid' })

    await expect(normalizePdfSignatureImage(new Uint8Array(5 * 1024 * 1024 + 1), 'image/png'))
      .rejects.toMatchObject({ code: 'signature_image_invalid' })

    const tooWide = await sharp({
      create: {
        width: PDF_SIGNATURE_MAX_DIMENSION + 1,
        height: 1,
        channels: 3,
        background: '#ffffff',
      },
    }).png().toBuffer()
    await expect(normalizePdfSignatureImage(tooWide, 'image/png'))
      .rejects.toMatchObject({ code: 'signature_image_invalid' })
  })
})
