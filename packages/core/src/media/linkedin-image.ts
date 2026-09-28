/** Bounded deterministic image derivative for the Feed LinkedIn projection. */
import sharp from 'sharp'
import { createHash } from 'node:crypto'
export async function prepareLinkedInImage(source: Uint8Array, mime: string) {
  const maxBytes=20*1024*1024, maxPixels=36_152_319
  if(!source.length || source.length>maxBytes)throw new Error('linkedin_image_size')
  const image=sharp(source,{animated:true,failOn:'error',limitInputPixels:maxPixels})
  const metadata=await image.metadata()
  const expected:Record<string,string>={'image/png':'png','image/jpeg':'jpeg','image/gif':'gif','image/webp':'webp'}
  if(!expected[mime] || metadata.format!==expected[mime] || !metadata.width || !metadata.height || metadata.width*metadata.height>maxPixels || (metadata.pages??1)>250)throw new Error('linkedin_image_format')
  if(mime==='image/webp' && (metadata.pages??1)>1)throw new Error('linkedin_animated_webp_unsupported')
  // Decode fully before any provider upload. Preserve accepted original formats;
  // sharp strips private metadata from the WebP derivative by default.
  await image.clone().stats()
  const bytes=mime==='image/webp'?await image.png({compressionLevel:9,adaptiveFiltering:false}).toBuffer():Buffer.from(source)
  if(bytes.length>maxBytes)throw new Error('linkedin_image_size')
  return {bytes,mimeType:mime==='image/webp'?'image/png':mime,sourceHash:createHash('sha256').update(source).digest('hex'),hash:createHash('sha256').update(bytes).digest('hex'),derivativeVersion:1 as const}
}
