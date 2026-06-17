// Ported from apps/web/src/app/chat/page.tsx:210. Pure generator over the
// SSE wire format — caller manages the buffer between chunks because chunks
// can split across event boundaries.

export type SSEEvent = { event: string; data: unknown }

export type SSEBuffer = { text: string }

export function createSSEBuffer(): SSEBuffer {
  return { text: '' }
}

/**
 * Parse one chunk into zero or more SSE events. The generator is intentional
 * — a single chunk can carry multiple events, and a single event can span
 * multiple chunks. The buffer object is mutable; pass the same instance for
 * the lifetime of one stream.
 */
export function* parseSSEStream(
  chunk: string,
  buffer: SSEBuffer,
): Generator<SSEEvent> {
  buffer.text += chunk
  const parts = buffer.text.split('\n\n')
  buffer.text = parts.pop() ?? ''

  for (const part of parts) {
    let event = 'message'
    let data = ''
    for (const line of part.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data = line.slice(6)
    }
    if (data) {
      let parsed: unknown
      try { parsed = JSON.parse(data) } catch { parsed = data }
      yield { event, data: parsed }
    }
  }
}
