/**
 * Manual verification for MCP image tool-results (the feat/mcp-image-tool-results change).
 *
 * Drives ONE real Gemini query-loop turn where a tool returns an image via
 * `ToolResult.images`. If the model can name the image's colour, the whole
 * path works end to end:
 *   tool returns images -> executor emits image blocks -> query loop puts them
 *   in the tool-results turn -> Gemini `inlineData` -> model SEES the pixels.
 *
 * This is the one link unit tests can't prove: that Gemini accepts an image
 * part sitting alongside the functionResponse in the tool-results turn.
 *
 * Run:  GEMINI_API_KEY=... pnpm --filter @use-brian/core tsx scripts/verify-mcp-image.ts
 *       (optional VERIFY_MODEL=gemini-flash-3 to match the prod chat model)
 */

import { z } from 'zod'
import { queryLoop, type QueryEvent } from '../src/engine/query-loop.js'
import { buildTool } from '../src/tools/types.js'
import { createGeminiProvider } from '../src/providers/gemini.js'

// A 96x96 solid-red JPEG (generated with ffmpeg color=red). Small on purpose.
const RED_JPEG_B64 =
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABNAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAYHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAYABgAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AiwEm38AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/9k='

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  console.error('Set GEMINI_API_KEY to run this verification.')
  process.exit(2)
}
const model = process.env.VERIFY_MODEL ?? 'gemini-2.5-flash'

let toolCalled = false

const showImage = buildTool({
  name: 'show_image',
  description: 'Return an image for you to look at. Call this, then describe what you see.',
  inputSchema: z.object({}),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute() {
    toolCalled = true
    return {
      data: 'Here is the image. Look at it and answer the user.',
      images: [{ mimeType: 'image/jpeg', data: RED_JPEG_B64 }],
    }
  },
})

async function main(): Promise<void> {
  const events: QueryEvent[] = []
  for await (const event of queryLoop({
    provider: createGeminiProvider(apiKey!),
    model,
    systemPrompt: 'You are a vision test assistant. Use tools when asked.',
    messages: [
      {
        role: 'user',
        content:
          'Call the show_image tool, then reply with ONLY the single dominant colour of the image it returns (one word).',
      },
    ],
    tools: new Map([['show_image', showImage]]),
    context: {
      userId: 'verify-user',
      assistantId: 'verify-assistant',
      sessionId: 'verify-session',
      appId: 'verify',
      channelType: 'web',
      channelId: 'verify-channel',
      abortSignal: new AbortController().signal,
    },
    maxTurns: 4,
  })) {
    events.push(event)
  }

  const text = events
    .map((e) => (e.type === 'text_delta' ? e.text : ''))
    .join('')
    .trim()

  console.log(`\nmodel (${model}) said: ${JSON.stringify(text)}`)
  console.log(`tool called: ${toolCalled}`)

  if (!toolCalled) {
    console.error('\nFAILED: the model never called show_image (cannot conclude anything about images).')
    process.exit(1)
  }
  if (/\bred\b/i.test(text)) {
    console.log('\nOK - the model saw the image (named the colour). MCP image tool-results reach the model.')
    return
  }
  console.error(
    '\nFAILED: the model called the tool but did not name the colour - the image likely did NOT reach it as vision.',
  )
  process.exit(1)
}

main().catch((err: unknown) => {
  console.error('\nVERIFY FAILED (error):')
  console.error(err)
  process.exit(1)
})
