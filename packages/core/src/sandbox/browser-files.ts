import { z } from 'zod'

export const MAX_BROWSER_DOWNLOAD = 32 * 1024 * 1024
export const MAX_BROWSER_UPLOAD = 4 * 1024 * 1024
export const BROWSER_DOWNLOAD_CHUNK = 256 * 1024
export const BrowserDownloadsSchema = z.object({ downloads: z.array(z.object({
  id: z.string().min(1).max(512), name: z.string().min(1).max(1024), mime: z.string().max(256),
  size: z.number().int().min(0).max(MAX_BROWSER_DOWNLOAD),
  state: z.enum(['progressing', 'completed', 'cancelled', 'interrupted']),
  error: z.string().max(2048).optional(), tabId: z.string().max(512).optional(),
})).max(20) }).refine(v => new Set(v.downloads.map(d => d.id)).size === v.downloads.length &&
  v.downloads.reduce((sum, d) => sum + d.size, 0) <= 128 * 1024 * 1024, 'Invalid download inventory')
export type BrowserDownloads = z.infer<typeof BrowserDownloadsSchema>
export const BrowserDownloadChunkSchema = z.object({
  data: z.string().max(4 * Math.ceil(BROWSER_DOWNLOAD_CHUNK / 3)),
  offset: z.number().int().min(0).max(MAX_BROWSER_DOWNLOAD),
  total: z.number().int().min(0).max(MAX_BROWSER_DOWNLOAD),
})
export type BrowserDownloadChunk = z.infer<typeof BrowserDownloadChunkSchema>
export function decodeBrowserData(data: string, max: number): Buffer {
  if (data.length > 4 * Math.ceil(max / 3) || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) throw new Error('Invalid browser file encoding')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > max || bytes.toString('base64') !== data) throw new Error('Invalid browser file size or encoding')
  return bytes
}
export function validateDownloadChunk(value: unknown, offset: number): BrowserDownloadChunk {
  const chunk = BrowserDownloadChunkSchema.parse(value)
  const bytes = decodeBrowserData(chunk.data, BROWSER_DOWNLOAD_CHUNK)
  if (chunk.offset !== offset || offset + bytes.length > chunk.total || (offset < chunk.total && !bytes.length)) throw new Error('Invalid browser download chunk')
  return chunk
}

/** A browser-controlled name is never a path or a Windows device name. */
export function browserFileName(name: string): string {
  let safe = name.replace(/[/\\:<>"|?*\x00-\x1f\x7f]/g, '_').slice(0, 200).replace(/[. ]+$/g, '')
  if (!safe) return 'file'
  const basename = safe.split('.')[0]!.replace(/ +$/g, '')
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(basename)) safe = `_${safe}`
  return safe.slice(0, 200).replace(/[. ]+$/g, '')
}
