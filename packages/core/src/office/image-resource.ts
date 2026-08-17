/** Deterministic Office image admission. [COMP:office/image-resource] */
import { createHash } from 'node:crypto'
import sharp from 'sharp'

export const MAX_OFFICE_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_OFFICE_IMAGE_DIMENSION_PX = 8_192

export type NormalizedOfficeImage = {
  bytes: Uint8Array
  hash: string
  mime: 'image/png' | 'image/jpeg'
  widthPx: number
  heightPx: number
}

export async function normalizeOfficeImageResource(input: Uint8Array): Promise<NormalizedOfficeImage> {
  if (input.byteLength > MAX_OFFICE_IMAGE_BYTES) throw new Error('office_image_too_large')
  let source: sharp.Sharp
  let metadata: sharp.Metadata
  try {
    source = sharp(input, { failOn: 'error' })
    metadata = await source.metadata()
  } catch {
    throw new Error('office_image_invalid')
  }
  if (metadata.format !== 'png' && metadata.format !== 'jpeg') throw new Error('office_image_unsupported')
  try {
    const pipeline = sharp(input, { failOn: 'error' })
      .rotate()
      .resize({
        width: MAX_OFFICE_IMAGE_DIMENSION_PX,
        height: MAX_OFFICE_IMAGE_DIMENSION_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
    const encoded = metadata.format === 'png'
      ? pipeline.png({ compressionLevel: 9 })
      : pipeline.jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    const result = await encoded.toBuffer({ resolveWithObject: true })
    const bytes = new Uint8Array(result.data)
    return {
      bytes,
      hash: createHash('sha256').update(bytes).digest('hex'),
      mime: metadata.format === 'png' ? 'image/png' : 'image/jpeg',
      widthPx: result.info.width,
      heightPx: result.info.height,
    }
  } catch {
    throw new Error('office_image_invalid')
  }
}
