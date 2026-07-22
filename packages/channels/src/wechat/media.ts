/**
 * Inbound WeChat (iLink) media: CDN download + AES-128-ECB decrypt.
 *
 * Media in a `WeixinMessage` is a CDN reference (`full_url` or an
 * `encrypt_query_param` to append to the CDN base) whose bytes are encrypted
 * with a per-item AES-128 key — a plain fetch of the URL yields ciphertext,
 * which is why the generic URL-based media acquirers can't handle this
 * channel. The inbound route downloads + decrypts via these helpers instead.
 *
 * Component tag: [COMP:channels/wechat-adapter].
 */

import { createDecipheriv } from 'node:crypto'
import {
  ILINK_CDN_BASE_URL,
  WeixinItemType,
  type IlinkCdnMedia,
  type WeixinMessageItem,
} from './ilink.js'

/** Decrypt AES-128-ECB with PKCS7 padding (the iLink CDN media cipher). */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * Parse a CDN media AES key into raw 16 bytes. Two encodings ship in the
 * wild: base64(16 raw bytes) — images — and base64(32-char hex string) —
 * voice/file/video. Image items may also carry a bare hex `aeskey` field,
 * which callers convert with `Buffer.from(hex, 'hex')` before calling this.
 */
export function parseIlinkAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`iLink aes_key must decode to 16 raw bytes or a 32-char hex string (got ${decoded.length} bytes)`)
}

function buildDownloadUrl(media: IlinkCdnMedia, cdnBaseUrl: string): string {
  if (media.full_url) return media.full_url
  if (!media.encrypt_query_param) throw new Error('iLink media has neither full_url nor encrypt_query_param')
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
}

/** Sniff an image mime from magic bytes; iLink image items carry no mime. */
export function sniffImageMime(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (data.length >= 6 && data.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (data.length >= 12 && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

export type WechatDownloadedMedia = {
  kind: 'image' | 'voice' | 'file' | 'video'
  data: Buffer
  mime: string
  /** Original filename for FILE items; synthesized otherwise. */
  name: string
  /** Voice duration in seconds, when the item carried playtime. */
  durationSec?: number
}

/**
 * Find the first downloadable media item on a message's item list (priority:
 * image > video > file > voice-without-STT, mirroring the reference plugin).
 * Voice items that already carry server STT `text` are handled as text.
 */
export function findWechatMediaItem(itemList: WeixinMessageItem[] | undefined): WeixinMessageItem | null {
  if (!itemList?.length) return null
  const downloadable = (m?: IlinkCdnMedia) => Boolean(m?.encrypt_query_param || m?.full_url)
  return (
    itemList.find((i) => i.type === WeixinItemType.IMAGE && downloadable(i.image_item?.media)) ??
    itemList.find((i) => i.type === WeixinItemType.VIDEO && downloadable(i.video_item?.media)) ??
    itemList.find((i) => i.type === WeixinItemType.FILE && downloadable(i.file_item?.media)) ??
    itemList.find(
      (i) => i.type === WeixinItemType.VOICE && downloadable(i.voice_item?.media) && !i.voice_item?.text,
    ) ??
    null
  )
}

/**
 * Download and decrypt one media item's bytes. `fetchImpl` is injectable for
 * tests. Images without any AES key are served plain by the CDN.
 */
export async function downloadWechatMediaItem(
  item: WeixinMessageItem,
  options?: { cdnBaseUrl?: string; fetchImpl?: typeof fetch },
): Promise<WechatDownloadedMedia | null> {
  const cdnBaseUrl = options?.cdnBaseUrl ?? ILINK_CDN_BASE_URL
  const doFetch = options?.fetchImpl ?? fetch

  async function fetchBytes(media: IlinkCdnMedia): Promise<Buffer> {
    const res = await doFetch(buildDownloadUrl(media, cdnBaseUrl))
    if (!res.ok) throw new Error(`iLink CDN download failed: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async function fetchDecrypted(media: IlinkCdnMedia, aesKeyBase64: string): Promise<Buffer> {
    return decryptAesEcb(await fetchBytes(media), parseIlinkAesKey(aesKeyBase64))
  }

  if (item.type === WeixinItemType.IMAGE && item.image_item?.media) {
    const img = item.image_item
    // The bare hex `aeskey` field is preferred over media.aes_key for images.
    const keyBase64 = img.aeskey ? Buffer.from(img.aeskey, 'hex').toString('base64') : img.media?.aes_key
    const data = keyBase64 ? await fetchDecrypted(img.media!, keyBase64) : await fetchBytes(img.media!)
    return { kind: 'image', data, mime: sniffImageMime(data), name: 'image' }
  }

  if (item.type === WeixinItemType.VIDEO && item.video_item?.media?.aes_key) {
    const data = await fetchDecrypted(item.video_item.media, item.video_item.media.aes_key)
    return { kind: 'video', data, mime: 'video/mp4', name: 'video.mp4' }
  }

  if (item.type === WeixinItemType.FILE && item.file_item?.media?.aes_key) {
    const name = item.file_item.file_name ?? 'file.bin'
    const data = await fetchDecrypted(item.file_item.media, item.file_item.media.aes_key)
    return { kind: 'file', data, mime: mimeFromFilename(name), name }
  }

  if (item.type === WeixinItemType.VOICE && item.voice_item?.media?.aes_key) {
    const data = await fetchDecrypted(item.voice_item.media, item.voice_item.media.aes_key)
    const durationSec = item.voice_item.playtime ? Math.round(item.voice_item.playtime / 1000) : undefined
    // encode_type 6 = silk, the personal-WeChat default. Forwarded as-is;
    // voice notes that carried server STT never reach this path.
    return { kind: 'voice', data, mime: 'audio/silk', name: 'voice.silk', durationSec }
  }

  return null
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

function mimeFromFilename(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? 'application/octet-stream'
}
