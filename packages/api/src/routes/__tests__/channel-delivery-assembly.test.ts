// [COMP:api/channel-delivery-assembly] — how the channel pipeline decides what
// text actually reaches a messaging channel (Telegram / Slack / WhatsApp).
//
// The outbound message is assembled from the buffered TERMINAL assistant turns,
// never by summing `text_delta` chunks. The 2026-07-20 leak (session b8e567d6)
// is the reason: a scheduled job named tools its assistant had no connector
// grant for, and the model's narrated hunt for them — including a verbatim dump
// of its own tool list — was concatenated into the delivered reply. `sanitizeDeliveryText` cannot catch
// that class (it matches known scaffolding phrasings; free-form reasoning has
// none), so the defense has to be structural.
//
// Spec: docs/architecture/channels/inter-assistant.md → "Final-text assembly".

import { describe, it, expect } from 'vitest'
import type { ContentBlock } from '@use-brian/core'
import { assembleDeliverableText } from '../channel-pipeline.js'

/** A turn that ends with a tool call — mid-reasoning, never the answer. */
function toolTurn(text: string, toolName = 'listConnectors'): { content: ContentBlock[] } {
  return {
    content: [
      { type: 'text', text },
      { type: 'tool_use', id: 'call_1', name: toolName, input: {} },
    ] as ContentBlock[],
  }
}

/** A turn that ends without a tool call — the model's actual reply. */
function textTurn(text: string): { content: ContentBlock[] } {
  return { content: [{ type: 'text', text }] as ContentBlock[] }
}

describe('[COMP:api/channel-delivery-assembly] assembleDeliverableText', () => {
  it('drops narration riding alongside a tool call and keeps the terminal reply', () => {
    expect(
      assembleDeliverableText([toolTurn('Let me check the brain.'), textTurn('All clear.')]),
    ).toBe('All clear.')
  })

  it('joins multiple terminal turns with newlines', () => {
    expect(assembleDeliverableText([textTurn('First.'), textTurn('Second.')])).toBe(
      'First.\nSecond.',
    )
  })

  it('never delivers a mid-reasoning tool-hunting spiral (2026-07-20 leak)', () => {
    // Verbatim shape of the leak: every turn narrated AND called a tool, so no
    // turn was ever terminal. Delta-summing shipped all of it to Telegram.
    const spiral = [
      toolTurn(
        'Wait, I see "Available connectors: gmail, github, knowledge" in my search results, ' +
          'but `listConnectorInstances` only showed GitHub.',
        'mcp_search',
      ),
      toolTurn(
        'Wait! I missed something. I am "GM Bro". I should check my own capabilities. ' +
          'It has: `webSearch`, `urlReader`, `askQuestion`, `createTask`, `getTime`…',
        'listConnectorInstances',
      ),
      toolTurn('Let me try to `listConnectors` to see what is configured.', 'listConnectors'),
    ]
    expect(assembleDeliverableText(spiral)).toBe('')
  })

  it('ignores a text-less tool turn without emitting stray newlines', () => {
    const bare: { content: ContentBlock[] } = {
      content: [{ type: 'tool_use', id: 'call_1', name: 'webSearch', input: {} }] as ContentBlock[],
    }
    expect(assembleDeliverableText([bare, textTurn('Done.')])).toBe('Done.')
  })

  it('contributes nothing for a leak-suppressed turn (text blocks stripped)', () => {
    // The turn-boundary leak sanitiser empties `content` AFTER the text already
    // streamed as deltas — which is exactly why deltas are not the source.
    expect(assembleDeliverableText([{ content: [] }, textTurn('Real answer.')])).toBe(
      'Real answer.',
    )
  })

  it('reads block text at call time so the grounding gate trailer is not lost', () => {
    // The post-nudge backstop mutates the final text block IN PLACE after the
    // turn was yielded. An eagerly-copied string would ship without the trailer.
    const turn = textTurn('Revenue was 5M.')
    ;(turn.content[0] as { text: string }).text += '\n\n(Unverified: 5M)'
    expect(assembleDeliverableText([turn])).toBe('Revenue was 5M.\n\n(Unverified: 5M)')
  })

  it('returns empty string for no turns at all', () => {
    expect(assembleDeliverableText([])).toBe('')
  })
})
