import { describe, it, expect } from 'vitest'
import dotenv from 'dotenv'
import { resolve } from 'node:path'
import { createAnthropicProvider } from '../anthropic.js'
import { collectStream } from '../accumulator.js'

// Same pattern as gemini.integration.test.ts — load monorepo .env so the
// test picks up local keys when present, and skip when absent.
dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '..', '..', '.env') })

const apiKey = process.env.ANTHROPIC_API_KEY
const describeIf = apiKey ? describe : describe.skip

describeIf('[COMP:providers/anthropic] Anthropic provider (integration)', () => {
  // Use `||` (not `??`) so an empty-string env value also routes to the
  // placeholder. `describe.skip` still evaluates its callback to discover
  // test names, so the constructor must accept a non-empty arg even when
  // we're going to skip every test inside.
  const provider = createAnthropicProvider({ apiKey: apiKey || 'placeholder-for-skip' })

  it('streams a simple text response from Claude Haiku', async () => {
    const stream = provider.stream({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'Say "hello world" and nothing else.' }],
      systemPrompt: 'You are a test assistant. Be extremely concise.',
      maxTokens: 64,
    })

    const chunks: string[] = []
    let sawMessageStart = false
    let sawMessageEnd = false
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') chunks.push(chunk.text)
      if (chunk.type === 'message_start') sawMessageStart = true
      if (chunk.type === 'message_end') sawMessageEnd = true
    }

    expect(sawMessageStart).toBe(true)
    expect(sawMessageEnd).toBe(true)
    expect(chunks.join('').toLowerCase()).toContain('hello')
  }, 15_000)

  it('reports a usage block with non-zero tokens on the message_end chunk', async () => {
    const stream = provider.stream({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'Reply with one word.' }],
      systemPrompt: 'test',
      maxTokens: 32,
    })

    const response = await collectStream(stream)
    expect(response.usage.inputTokens).toBeGreaterThan(0)
    expect(response.usage.outputTokens).toBeGreaterThan(0)
  }, 15_000)
})
