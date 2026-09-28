import { createHash } from 'node:crypto'
import sharp from 'sharp'

export const PDF_SIGNATURE_MAX_BYTES = 5 * 1024 * 1024
export const PDF_SIGNATURE_MAX_DIMENSION = 4_096

export type NormalizedPdfSignature = {
  bytes: Uint8Array
  mime: 'image/png'
  sha256: string
  width: number
  height: number
}

export class PdfSignatureImageError extends Error {
  readonly code = 'signature_image_invalid'
  constructor(message = 'Use a PNG or JPEG signature image up to 5 MiB and 4096 by 4096 pixels.') {
    super(message)
    this.name = 'PdfSignatureImageError'
  }
}

/** Strict signature-image admission: decode, apply EXIF orientation, strip
 * metadata, enforce the v1 geometry limit, and encode a lossless PNG. */
export async function normalizePdfSignatureImage(bytes: Uint8Array, declaredMime: string): Promise<NormalizedPdfSignature> {
  if (!['image/png', 'image/jpeg'].includes(declaredMime) || bytes.byteLength === 0 || bytes.byteLength > PDF_SIGNATURE_MAX_BYTES) {
    throw new PdfSignatureImageError()
  }
  try {
    const pipeline = sharp(bytes, { failOn: 'warning', limitInputPixels: PDF_SIGNATURE_MAX_DIMENSION ** 2 })
    const metadata = await pipeline.metadata()
    if (!metadata.width || !metadata.height
      || metadata.width > PDF_SIGNATURE_MAX_DIMENSION
      || metadata.height > PDF_SIGNATURE_MAX_DIMENSION
      || (metadata.format !== 'png' && metadata.format !== 'jpeg')) {
      throw new PdfSignatureImageError()
    }
    const normalized = await pipeline.rotate().png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer()
    const output = await sharp(normalized).metadata()
    if (!output.width || !output.height) throw new PdfSignatureImageError()
    return {
      bytes: normalized,
      mime: 'image/png',
      sha256: createHash('sha256').update(normalized).digest('hex'),
      width: output.width,
      height: output.height,
    }
  } catch (error) {
    if (error instanceof PdfSignatureImageError) throw error
    throw new PdfSignatureImageError()
  }
}
