/**
 * Normalize a raw MCP tool return into a Use Brian `ToolResult`.
 *
 * A remote MCP tool returns either plain text (a string / content array) or,
 * when it emits image content, a `{ text, images }` payload (see the API
 * package's `callRemoteMcpTool`). This lifts those inline images onto
 * `ToolResult.images` so the engine can render them as image blocks the model
 * actually sees — a text-only path just carries the text as `data`.
 *
 * See docs/architecture/integrations/mcp.md → "Image tool results".
 */

import type { ToolResult, ToolResultImage } from '../tools/types.js'

/** Cap on images lifted from a single MCP tool result (defense against abuse). */
const MAX_MCP_RESULT_IMAGES = 8

function isImage(value: unknown): value is ToolResultImage {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ToolResultImage).data === 'string' &&
    typeof (value as ToolResultImage).mimeType === 'string'
  )
}

export function mcpResultToToolResult(result: unknown): ToolResult {
  if (result && typeof result === 'object' && Array.isArray((result as { images?: unknown }).images)) {
    const r = result as { text?: unknown; images: unknown[] }
    const images = r.images.filter(isImage).slice(0, MAX_MCP_RESULT_IMAGES)
    const text =
      typeof r.text === 'string' && r.text.length > 0 ? r.text : `[returned ${images.length} image(s)]`
    return images.length > 0 ? { data: text, images } : { data: text }
  }
  return { data: result }
}
