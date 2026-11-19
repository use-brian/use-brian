import { describe, it, expect } from 'vitest'
import dotenv from 'dotenv'
import { resolve } from 'node:path'
import { createOpenAICompatProvider, DASHSCOPE_INTL_BASE_URL, DASHSCOPE_INTL_LABEL } from '../openai-compat.js'

// Same pattern as gemini/anthropic integration tests — load the monorepo
// .env so the test picks up a local key when present, skip when absent.
dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '..', '..', '.env') })

const apiKey = process.env.DASHSCOPE_API_KEY
const describeIf = apiKey ? describe : describe.skip

// qwen3.5-flash is the wave-1 background-lane candidate (plan §5.1) and the
// cheapest real target; the intl deployment's free quota covers this test.
const MODEL = 'qwen3.5-flash'

describeIf('[COMP:providers/openai-compat] DashScope intl (integration)', () => {
  const provider = createOpenAICompatProvider({
    apiKey: apiKey || 'placeholder-for-skip',
    baseURL: DASHSCOPE_INTL_BASE_URL,
    label: DASHSCOPE_INTL_LABEL,
  })

  it('streams a simple text response with usage', async () => {
    const stream = provider.stream({
      model: MODEL,
      messages: [{ role: 'user', content: 'Say "hello world" and nothing else.' }],
      systemPrompt: 'You are a test assistant. Be extremely concise.',
      runtimeSystemContext: 'This is a synthetic system-context compatibility check.',
      maxTokens: 64,
    })

    let textOut = ''
    let sawStart = false
    let usage: { inputTokens: number; outputTokens: number } | null = null
    for await (const chunk of stream) {
      if (chunk.type === 'message_start') sawStart = true
      if (chunk.type === 'text_delta') textOut += chunk.text
      if (chunk.type === 'message_end') usage = chunk.usage
    }

    expect(sawStart).toBe(true)
    expect(textOut.toLowerCase()).toContain('hello')
    expect(usage?.inputTokens).toBeGreaterThan(0)
    expect(usage?.outputTokens).toBeGreaterThan(0)
  }, 60_000)

  it('round-trips a tool call', async () => {
    const stream = provider.stream({
      model: MODEL,
      messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
      systemPrompt: 'Use the provided tool to answer.',
      tools: [{
        name: 'getWeather',
        description: 'Get current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      }],
      maxTokens: 256,
    })

    const toolNames: string[] = []
    let stopReason = ''
    let args = ''
    for await (const chunk of stream) {
      if (chunk.type === 'tool_use_start') toolNames.push(chunk.name)
      if (chunk.type === 'tool_use_delta') args += chunk.input
      if (chunk.type === 'message_end') stopReason = chunk.stopReason
    }

    expect(toolNames).toContain('getWeather')
    expect(stopReason).toBe('tool_use')
    expect(JSON.parse(args)).toMatchObject({ city: expect.stringMatching(/paris/i) })
  }, 60_000)
})
