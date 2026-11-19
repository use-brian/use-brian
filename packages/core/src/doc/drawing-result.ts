import type { z } from 'zod'
import { inflateSync } from 'node:zlib'
import CRC32 from 'crc-32'
import { drawingPreviewSchema, drawingSceneDigest, MAX_DRAWING_PREVIEW_BYTES, type DrawingScene } from '@use-brian/shared/drawing'
import { buildTool, type Tool, type ToolResultImage } from '@use-brian/agent-runtime/tools/types.js'

// Keep binary assets out of every doc tool's text, including bulk reads and
// mutation receipts. Only a targeted read delivers one model-visible image.
export function buildDrawingAwareTool<Input extends z.ZodType>(def: Parameters<typeof buildTool<Input>>[0]): Tool<Input> {
  return buildTool({ ...def, async execute(input, context) {
    const result = await def.execute(input, context)
    const images: ToolResultImage[] = []
    async function visit(value: unknown): Promise<unknown> {
      if (Array.isArray(value)) {
        // Decode drawings serially so a bulk page read cannot multiply the
        // per-image allocation bound by the number of blocks in the page.
        const items: unknown[] = []
        for (const item of value) items.push(await visit(item))
        return items
      }
      if (!value || typeof value !== 'object') return value
      if (Object.getPrototypeOf(value) !== Object.prototype) return value
      const object = value as Record<string, unknown>
      if (object.kind === 'drawing' && object.scene) {
        const { preview, scene, ...block } = object
        const drawing = scene as DrawingScene
        let previewStatus = 'unavailable: no valid export for this scene; open the drawing editor and Save'
        const parsed = drawingPreviewSchema.safeParse(preview)
        if (parsed.success) {
          try {
            if (parsed.data.sceneDigest === await drawingSceneDigest(drawing)) {
              const { width, height } = parsed.data
              const bytes = Buffer.from(parsed.data.data, 'base64')
              const pixelChunks = [bytes.subarray(0, 8)]
              const idat: Buffer[] = []
              // Sharp's PNG loader does not check CRCs. Check framing here;
              // leave PNG pixel/filter validation to the existing decoder.
              for (let offset = 8; offset < bytes.length;) {
                if (bytes.length - offset < 12) throw new Error('Truncated PNG chunk')
                const end = offset + 12 + bytes.readUInt32BE(offset)
                if (end > bytes.length || (CRC32.buf(bytes.subarray(offset + 4, end - 4)) >>> 0) !== bytes.readUInt32BE(end - 4)) {
                  throw new Error('Invalid PNG chunk length or CRC')
                }
                const type = bytes.toString('ascii', offset + 4, offset + 8)
                if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, end - 4))
                // Do not inflate compressed ancillary profiles/text, or pass
                // them to providers. Keep critical chunks and transparency.
                if (!(bytes[offset + 4] & 0x20) || type === 'tRNS') pixelChunks.push(bytes.subarray(offset, end))
                offset = end
              }
              // PNG permits at most 16-bit RGBA (8 bytes/pixel). Eight extra
              // filter bytes/row safely cover all seven Adam7 passes too.
              inflateSync(Buffer.concat(idat), { maxOutputLength: height * (width * 8 + 8) })
              // sharp loads at first use, never at module evaluation (M4 step 5).
              const { default: sharp } = await import('sharp')
              const decoded = await sharp(Buffer.concat(pixelChunks), {
                failOn: 'warning', limitInputPixels: width * height,
              }).png().toBuffer({ resolveWithObject: true })
              if (decoded.info.width !== width || decoded.info.height !== height || decoded.data.length > MAX_DRAWING_PREVIEW_BYTES) {
                throw new Error('Drawing PNG exceeds export bounds')
              }
              if (def.name === 'getBlock' && !result.isError && images.length === 0) {
                images.push({ mimeType: parsed.data.mimeType, data: decoded.data.toString('base64') })
                previewStatus = 'attached: exported drawing image (requires a vision-capable model)'
              } else previewStatus = 'available: use getBlock on this drawing to read its image'
            }
          } catch { /* Invalid scenes or exports are not visual evidence. */ }
        }
        return { ...block, previewStatus, scene: { ...drawing, files: Object.fromEntries(
          Object.entries(drawing.files ?? {}).map(([id, file]) => {
            const { dataURL: _bytes, ...metadata } = file
            return [id, { ...metadata, dataOmitted: true }]
          }),
        ) } }
      }
      return Object.fromEntries(await Promise.all(Object.entries(object).map(async ([key, item]) => [key, await visit(item)])))
    }
    const data = await visit(result.data)
    return { ...result, data, ...(images.length ? { images } : {}) }
  } })
}
