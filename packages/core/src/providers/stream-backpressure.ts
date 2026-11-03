import type { StreamChunk } from './types.js'

const MAX_CHUNKS = 32
const MAX_CHARACTERS = 65_536
const MAX_DELTA = 4_096

function characters(chunk: StreamChunk): number {
  if ('text' in chunk) return chunk.text.length
  if ('input' in chunk) return chunk.input.length
  return JSON.stringify(chunk).length
}

/** Buffer only provider bytes. All event admission and tool execution remain downstream. */
export async function* bufferProviderStream(
  open: (signal: AbortSignal) => AsyncIterable<StreamChunk>,
  parentSignal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const controller = new AbortController()
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
  const queue: StreamChunk[] = []
  let size = 0
  let ended = false
  let failed = false
  let failure: unknown
  let readable: (() => void) | undefined
  let writable: (() => void) | undefined
  let terminalConsumed: (() => void) | undefined
  const wake = () => { readable?.(); writable?.(); terminalConsumed?.() }
  const iterator = open(signal)[Symbol.asyncIterator]()
  signal.addEventListener('abort', wake)
  const pump = (async () => {
    try {
      while (!signal.aborted) {
        while (!signal.aborted && (queue.length >= MAX_CHUNKS || size >= MAX_CHARACTERS)) {
          await new Promise<void>(resolve => { writable = resolve })
          writable = undefined
        }
        signal.throwIfAborted()
        const next = await iterator.next()
        if (next.done) break
        signal.throwIfAborted()
        const chunk = next.value
        const last = queue.at(-1)
        if ((chunk.type === 'text_delta' || chunk.type === 'thinking_delta')
          && last?.type === chunk.type && last.text.length + chunk.text.length <= MAX_DELTA) {
          // Replace queued objects; consumers and provider-owned objects never mutate.
          queue[queue.length - 1] = { ...last, text: last.text + chunk.text }
        } else queue.push(chunk)
        size += characters(chunk)
        readable?.()
        // Providers may commit stateful history after yielding message_end.
        // Preserve that boundary: no read-ahead beyond an unconsumed terminal.
        if (chunk.type === 'message_end') {
          await new Promise<void>(resolve => { terminalConsumed = resolve })
          terminalConsumed = undefined
        }
      }
    } catch (error) { failed = true; failure = error }
    finally { ended = true; readable?.() }
  })()
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = queue.shift()
      if (chunk) {
        size -= characters(chunk)
        writable?.()
        yield chunk
        if (chunk.type === 'message_end') terminalConsumed?.()
      } else if (ended) {
        if (failed) throw failure
        return
      } else {
        await new Promise<void>(resolve => { readable = resolve })
        readable = undefined
      }
    }
  } finally {
    controller.abort()
    wake()
    await pump
    try { await iterator.return?.() } finally { signal.removeEventListener('abort', wake) }
  }
}
