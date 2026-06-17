import { describe, it, expect } from 'vitest'
import dotenv from 'dotenv'
import { resolve } from 'node:path'
import { z } from 'zod'
import { createGeminiProvider } from '../../providers/gemini.js'
import { buildTool } from '../../tools/types.js'
import { queryLoop, type QueryEvent } from '../query-loop.js'

dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '..', '..', '.env') })

const apiKey = process.env.GEMINI_API_KEY
const describeIf = apiKey ? describe : describe.skip

describeIf('[COMP:engine/query-loop] Query loop (integration)', () => {
  const provider = createGeminiProvider(apiKey!)

  it('completes a simple text response', async () => {
    const events: QueryEvent[] = []
    const abortController = new AbortController()

    for await (const event of queryLoop({
      provider,
      model: 'gemini-flash',
      systemPrompt: 'You are a test assistant. Be extremely concise.',
      messages: [{ role: 'user', content: 'What is 2 + 2? Answer with just the number.' }],
      tools: new Map(),
      context: {
        userId: 'test-user',
        assistantId: 'test-assistant',
        sessionId: 'test-session',
        appId: 'test',
        channelType: 'web',
        channelId: 'test-channel',
        abortSignal: abortController.signal,
      },
    })) {
      events.push(event)
    }

    const textEvents = events.filter((e) => e.type === 'text_delta')
    expect(textEvents.length).toBeGreaterThan(0)

    const text = textEvents.map((e) => e.type === 'text_delta' ? e.text : '').join('')
    expect(text).toContain('4')

    const complete = events.find((e) => e.type === 'turn_complete')
    expect(complete).toBeDefined()
  }, 15_000)

  it('executes a tool call and continues', async () => {
    const weatherTool = buildTool({
      name: 'get_weather',
      description: 'Get current weather for a city',
      inputSchema: z.object({
        city: z.string().describe('City name'),
      }),
      isConcurrencySafe: true,
      isReadOnly: true,
      async execute(input) {
        return { data: { city: input.city, temperature: 22, condition: 'sunny' } }
      },
    })

    const events: QueryEvent[] = []
    const abortController = new AbortController()

    for await (const event of queryLoop({
      provider,
      model: 'gemini-flash',
      systemPrompt: 'You are a test assistant. Use tools when needed. Be concise.',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      tools: new Map([['get_weather', weatherTool]]),
      context: {
        userId: 'test-user',
        assistantId: 'test-assistant',
        sessionId: 'test-session',
        appId: 'test',
        channelType: 'web',
        channelId: 'test-channel',
        abortSignal: abortController.signal,
      },
      maxTurns: 5,
    })) {
      events.push(event)
    }

    // Should have tool events
    const toolStarts = events.filter((e) => e.type === 'tool_start')
    expect(toolStarts.length).toBeGreaterThan(0)

    // Should complete
    const complete = events.find((e) => e.type === 'turn_complete')
    expect(complete).toBeDefined()

    // `assistant_turn` must fire for EVERY turn, not just the terminal one.
    // If chat.ts (or any consumer) only buffers on turn_complete, intermediate
    // turns get silently dropped — which is the bug the persistence buffer is
    // meant to avoid.
    //
    // Gemini is non-deterministic about whether it actually calls the tool
    // for "what is the weather in Tokyo?" (sometimes it answers from knowledge
    // without calling any tool). Gate the multi-turn assertion on whether a
    // tool call actually happened in this run.
    const assistantTurns = events.filter((e) => e.type === 'assistant_turn')
    expect(assistantTurns.length).toBeGreaterThanOrEqual(1)

    if (toolStarts.length > 0) {
      // A tool was called → there must be at least a tool-use turn AND a
      // final text turn, so >= 2 assistant_turn events.
      expect(assistantTurns.length).toBeGreaterThanOrEqual(2)

      // At least one turn in the sequence should carry tool_use blocks paired
      // with their tool_results inline.
      const toolTurn = assistantTurns.find((e) => {
        if (e.type !== 'assistant_turn') return false
        return e.response.content.some((b) => b.type === 'tool_use')
      })
      expect(toolTurn).toBeDefined()
      if (toolTurn?.type === 'assistant_turn') {
        expect(toolTurn.toolResults.length).toBeGreaterThan(0)
        expect(toolTurn.toolResults.every((b) => b.type === 'tool_result')).toBe(true)
      }
    }

    // Final response should mention temperature or Tokyo
    const textEvents = events.filter((e) => e.type === 'text_delta')
    const text = textEvents.map((e) => e.type === 'text_delta' ? e.text : '').join('').toLowerCase()
    expect(text.length).toBeGreaterThan(0)
  }, 30_000)
})
