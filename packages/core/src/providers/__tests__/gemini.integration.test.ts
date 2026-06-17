import { describe, it, expect } from 'vitest'
import dotenv from 'dotenv'
import { resolve } from 'node:path'
import { createGeminiProvider } from '../gemini.js'
import { composeWrappers, defaultWrappers } from '../wrappers.js'
import { collectStream } from '../accumulator.js'

dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '..', '..', '.env') })

const apiKey = process.env.GEMINI_API_KEY
const describeIf = apiKey ? describe : describe.skip

describeIf('[COMP:providers/gemini] Gemini provider (integration)', () => {
  const provider = createGeminiProvider(apiKey!)

  it('streams a simple text response', async () => {
    const chunks: string[] = []
    const stream = provider.stream({
      model: 'gemini-flash',
      messages: [{ role: 'user', content: 'Say "hello world" and nothing else.' }],
      systemPrompt: 'You are a test assistant. Be extremely concise.',
    })

    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') chunks.push(chunk.text)
    }

    const text = chunks.join('').toLowerCase()
    expect(text).toContain('hello')
  }, 15_000)

  it('streams a tool call response', async () => {
    const stream = provider.stream({
      model: 'gemini-flash',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      systemPrompt: 'You are a test assistant.',
      tools: [{
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
          },
          required: ['city'],
        },
      }],
    })

    const response = await collectStream(stream)
    expect(response.stopReason).toBe('tool_use')
    const toolUse = response.content.find((b) => b.type === 'tool_use')
    expect(toolUse).toBeDefined()
    if (toolUse?.type === 'tool_use') {
      expect(toolUse.name).toBe('get_weather')
    }
  }, 15_000)

  it('works with composed wrappers', async () => {
    const wrappedStream = composeWrappers(
      provider.stream.bind(provider),
      ...defaultWrappers({ idleTimeoutMs: 10_000, verbose: false }),
    )

    const response = await collectStream(wrappedStream({
      model: 'gemini-flash',
      messages: [{ role: 'user', content: 'Say "ok".' }],
      systemPrompt: 'Be concise.',
    }))

    expect(response.content.length).toBeGreaterThan(0)
    expect(response.stopReason).toBe('end_turn')
    expect(response.usage.inputTokens).toBeGreaterThan(0)
  }, 15_000)
})
