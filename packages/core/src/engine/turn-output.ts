import type { AssistantResponse, ContentBlock } from '../providers/types.js'
import type { AssistantQuestion } from '../tools/base/ask-question.js'
import type { QueryEvent } from './query-loop.js'

export type TurnOutputEmptyReason = 'tools_only' | 'no_model_output' | 'text_withheld'

export type TurnOutputSelection =
  | { kind: 'text'; text: string }
  | { kind: 'question'; question: AssistantQuestion }
  | { kind: 'empty'; reason: TurnOutputEmptyReason }

export type TurnOutputFormat = 'compact' | 'channel'

export type TurnOutputCollector = {
  /** Observe one engine event. Events unrelated to final delivery are ignored. */
  observe(event: QueryEvent): void
  /** Read the current delivery window without consuming it. */
  select(): TurnOutputSelection
  /** Advance only after the selected output has been delivered successfully. */
  advanceDelivery(): void
}

function hasToolUse(response: AssistantResponse): boolean {
  return response.content.some((block) => block.type === 'tool_use')
}

function textBlocks(response: AssistantResponse): Array<ContentBlock & { type: 'text'; text: string }> {
  return response.content.filter(
    (block): block is ContentBlock & { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string',
  )
}

function formatResponses(responses: AssistantResponse[], format: TurnOutputFormat): string {
  const eligible = responses.filter((response) => !hasToolUse(response))
  if (format === 'channel') {
    return eligible
      .flatMap((response) => textBlocks(response))
      .map((block) => block.text)
      .join('\n')
      .trim()
  }
  return eligible
    .map((response) => textBlocks(response).map((block) => block.text).join('').trim())
    .filter((text) => text.length > 0)
    .join('\n')
    .trim()
}

/**
 * Invocation-local owner for final, non-streaming assistant output.
 *
 * The collector deliberately retains response references rather than copied
 * strings: the grounding gate may append a trailer after `assistant_turn` was
 * yielded. `turn_complete.response` is ignored because queryLoop has already
 * yielded that response through `assistant_turn`.
 */
export function createTurnOutputCollector(
  options: { format?: TurnOutputFormat } = {},
): TurnOutputCollector {
  const format = options.format ?? 'compact'
  let responses: AssistantResponse[] = []
  let question: AssistantQuestion | undefined
  let retracted = false

  return {
    observe(event) {
      if (event.type === 'assistant_turn') {
        // A truncated draft can be continued directly with text. Resuming
        // tools instead starts a new synthesis, which replaces that draft.
        if (hasToolUse(event.response) && responses.some((response) =>
          !hasToolUse(response)
          && (response.stopReason === 'incomplete' || response.stopReason === 'max_tokens')
          && textBlocks(response).length > 0,
        )) {
          responses = []
          question = undefined
          retracted = true
        }
        responses.push(event.response)
      } else if (event.type === 'question') {
        const { type: _, ...validatedQuestion } = event
        question = validatedQuestion
      } else if (event.type === 'grounding_nudge') {
        responses = []
        question = undefined
        retracted = true
      }
    },

    select() {
      if (question) return { kind: 'question', question }

      const text = formatResponses(responses, format)
      if (text.length > 0) return { kind: 'text', text }

      if (responses.length === 0) {
        return { kind: 'empty', reason: retracted ? 'text_withheld' : 'no_model_output' }
      }
      if (responses.some(hasToolUse)) return { kind: 'empty', reason: 'tools_only' }
      if (retracted) return { kind: 'empty', reason: 'text_withheld' }
      if (responses.some((response) => textBlocks(response).length > 0)) {
        return { kind: 'empty', reason: 'text_withheld' }
      }
      return { kind: 'empty', reason: 'no_model_output' }
    },

    advanceDelivery() {
      responses = []
      question = undefined
      retracted = false
    },
  }
}
