import { describe, expect, it } from 'vitest'
import { collectStream } from '../../../../core/src/providers/accumulator.js'
import { createGeminiProvider } from '../../../../core/src/providers/gemini.js'
import type { Message } from '../../../../core/src/providers/types.js'
import { LAYER_1_SYSTEM_PROMPT } from '../../../../core/src/system-prompt.js'
import {
  attachUserVisibleContext,
  buildSplitSystemPrompt,
  formatPrivateRuntimeContext,
} from '../_prompt-builder.js'

const apiKey = process.env.GEMINI_API_KEY
const describeIf = apiKey ? describe : describe.skip

describeIf('[COMP:prompt/builder] Runtime-context provenance (live Gemini)', () => {
  it('translates the visible Japanese quote without exposing private runtime notes', async () => {
    const japanese =
      'ありがとう！明日からいろいろ試してみるよ。わからないことがあったらまた質問するね？ 😁'
    const split = buildSplitSystemPrompt({
      basePrompt: LAYER_1_SYSTEM_PROMPT,
      assistantInstructions:
        'Reply in concise natural Cantonese. Answer only what the user is asking about.',
      currentDateTime: 'Saturday, August 1, 2026 at 1:22 AM JST',
      timezone: 'Asia/Tokyo',
      memoryContext: '## Memory Index\nNo memories are relevant to this translation.',
      sessionStateBlock:
        '# Open commitments\n- aspiration-vs-reality: write a 2,000-word founder essay\n- map_links: always include map links\n- restaurant_criteria: quiet and private',
      episodicContext: '# Relevant topic history\nThe user recently discussed a journal plan.',
      topicHint: {
        topic_label: 'assistant-runtime-design',
        state: 'continue',
        confidence: 0.96,
        related_topics: [],
      },
      replyContext: { text: japanese, fromAssistant: false },
    })

    const privateBlock = formatPrivateRuntimeContext(split.privateRuntimeContext)
    const systemPrompt = [split.stablePrompt, privateBlock].filter(Boolean).join('\n\n')
    const messages = attachUserVisibleContext(
      [{ role: 'user', content: '呢句咩意思' }] satisfies Message[],
      split.userVisibleContext,
    )
    expect(messages).not.toBeNull()

    const provider = createGeminiProvider(apiKey!)
    const response = await collectStream(
      provider.stream({
        model: 'gemini-flash',
        systemPrompt,
        messages: messages!,
        maxTokens: 200,
        temperature: 0,
      }),
    )
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')

    expect(text).toMatch(/多謝|謝謝|感謝|thank/i)
    expect(text).toMatch(/聽日|明天/)
    expect(text).toMatch(/再問|問你|提問/)
    expect(text).not.toMatch(
      /private_runtime_context|user_visible_context|open commitments|user context|aspiration-vs-reality|map_links|restaurant_criteria|assistant-runtime-design/i,
    )
  }, 30_000)
})
