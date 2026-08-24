import type { FeishuResourceType } from './types.js'

const SCHEME = 'feishu-resource:'

/**
 * Internal opaque reference used only between the adapter and Feishu route.
 * It is not a provider URL and must be acquired/staged before archive write.
 */
export function feishuResourceRef(
  messageId: string,
  fileKey: string,
  type: FeishuResourceType,
): string {
  return `${SCHEME}${encodeURIComponent(messageId)}/${encodeURIComponent(fileKey)}/${type}`
}

export function parseFeishuResourceRef(
  value: string,
): { messageId: string; fileKey: string; type: FeishuResourceType } | null {
  if (!value.startsWith(SCHEME)) return null
  const parts = value.slice(SCHEME.length).split('/')
  if (parts.length !== 3) return null
  const type = parts[2]
  if (!['image', 'file', 'audio', 'video', 'sticker'].includes(type)) return null
  try {
    const messageId = decodeURIComponent(parts[0])
    const fileKey = decodeURIComponent(parts[1])
    if (!messageId || !fileKey) return null
    return { messageId, fileKey, type: type as FeishuResourceType }
  } catch {
    return null
  }
}
