import type { AssistantResponse, ContentBlock, StreamChunk, TokenUsage, StopReason } from './types.js'

/**
 * Accumulates StreamChunks into a complete AssistantResponse.
 * Used after the stream completes to get the final message for storage.
 */
export function createAccumulator() {
  let model = ''
  let textBuffer = ''
  let stopReason: StopReason = 'end_turn'
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  const toolCalls = new Map<string, { name: string; inputJson: string }>()
  const content: ContentBlock[] = []

  return {
    push(chunk: StreamChunk) {
      switch (chunk.type) {
        case 'message_start':
          model = chunk.model
          break
        case 'text_delta':
          textBuffer += chunk.text
          break
        case 'tool_use_start':
          toolCalls.set(chunk.id, { name: chunk.name, inputJson: '' })
          break
        case 'tool_use_delta': {
          const tc = toolCalls.get(chunk.id)
          if (tc) tc.inputJson += chunk.input
          break
        }
        case 'tool_use_end': {
          // Flush any preceding text
          if (textBuffer) {
            content.push({ type: 'text', text: textBuffer })
            textBuffer = ''
          }
          const tc = toolCalls.get(chunk.id)
          if (tc) {
            let input: Record<string, unknown> = {}
            try { input = JSON.parse(tc.inputJson) } catch { /* use empty */ }
            const block: ContentBlock = { type: 'tool_use', id: chunk.id, name: tc.name, input }
            if (chunk.providerSignature) block.providerSignature = chunk.providerSignature
            content.push(block)
            toolCalls.delete(chunk.id)
          }
          break
        }
        case 'message_end':
          stopReason = chunk.stopReason
          usage = chunk.usage
          break
      }
    },

    finish(): AssistantResponse {
      // Flush remaining text
      if (textBuffer) {
        content.push({ type: 'text', text: textBuffer })
        textBuffer = ''
      }
      return { content, stopReason, usage, model }
    },
  }
}

/**
 * Convenience: consume an entire stream and return the assembled response.
 */
export async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<AssistantResponse> {
  const acc = createAccumulator()
  for await (const chunk of stream) {
    acc.push(chunk)
  }
  return acc.finish()
}
