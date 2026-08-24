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

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import type { ContentBlock } from '@use-brian/core'
import {
  assembleDeliverableText,
  classifyEmptyDelivery,
  EMPTY_DELIVERY_NOTICE,
} from '../channel-pipeline.js'

const pipelineSource = readFileSync(new URL('../channel-pipeline.ts', import.meta.url), 'utf8')

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

/** A turn the leak sanitiser emptied, or that the provider never filled. */
const emptyTurn: { content: ContentBlock[] } = { content: [] }

describe('[COMP:api/channel-delivery-assembly] classifyEmptyDelivery', () => {
  it('calls an all-empty window with nothing retracted a model failure', () => {
    // The 2026-08-24 Telegram case: a workspace custom endpoint answered every
    // attempt with a clean 200 carrying no content and no usage, so all three
    // buffered turns were empty and `input_tokens` was 0 on each.
    expect(
      classifyEmptyDelivery({ window: [emptyTurn, emptyTurn, emptyTurn], retractedCount: 0 }),
    ).toBe('no_model_output')
  })

  it('calls an EMPTY window with turns retracted a withhold, not a model failure', () => {
    // The vacuous case. When the grounding gate retracts every turn it has
    // yielded, `deliveryCutIdx` consumes the whole buffer and the window is
    // `[]` — which has no tool call and no text, so the structural tests alone
    // would blame the model for text this pipeline chose not to send.
    expect(classifyEmptyDelivery({ window: [], retractedCount: 2 })).toBe('text_withheld')
  })

  it('calls an empty window with nothing retracted a model failure', () => {
    expect(classifyEmptyDelivery({ window: [], retractedCount: 0 })).toBe('no_model_output')
  })

  it('reports tools_only when the run called a tool but never reached a terminal turn', () => {
    expect(
      classifyEmptyDelivery({ window: [toolTurn('Let me look that up.')], retractedCount: 0 }),
    ).toBe('tools_only')
  })

  it('prefers tools_only over text_withheld when both signals are present', () => {
    // A tool ran, so a retry could duplicate its side effect. That verdict has
    // to win over the presence of narration text.
    expect(
      classifyEmptyDelivery({
        window: [textTurn('   '), toolTurn('Checking.')],
        retractedCount: 0,
      }),
    ).toBe('tools_only')
  })

  it('reports text_withheld when a text block survived but assembly produced nothing', () => {
    // Whitespace-only text: the model spoke, `assembleDeliverableText` trimmed
    // it to nothing. Not the provider's failure.
    expect(classifyEmptyDelivery({ window: [textTurn('   ')], retractedCount: 0 })).toBe(
      'text_withheld',
    )
  })

  it('reports text_withheld when only some turns were emptied', () => {
    expect(
      classifyEmptyDelivery({ window: [emptyTurn, textTurn('')], retractedCount: 0 }),
    ).toBe('text_withheld')
  })
})

describe('[COMP:api/channel-delivery-assembly] empty-delivery wiring', () => {
  it('states the fallback notice without claiming anything about tools', () => {
    // The tools_only branch falls back here when composeRecoveryMessage
    // declines, and it declines when tools were called and FAILED. A notice
    // that promised nothing had run would be a lie in exactly that case.
    expect(EMPTY_DELIVERY_NOTICE).not.toMatch(/tool/i)
    // User-facing copy: the em dash is banned from every user-visible string.
    expect(EMPTY_DELIVERY_NOTICE).not.toContain('\u2014')
  })

  it('tells the user instead of going silent', () => {
    // Silence is indistinguishable from being ignored. The branch that emits
    // `channel_delivery_empty` must also put a sentence on the channel — this
    // is the interactive-lane analogue of the callee lane's typed
    // `empty_response` throw.
    expect(pipelineSource).toContain(
      'await sendResponseAndStampChannelId(recovered?.text ?? EMPTY_DELIVERY_NOTICE)',
    )
    expect(pipelineSource).toMatch(
      /eventName: 'channel_delivery_empty'[\s\S]*?sendResponseAndStampChannelId\(recovered\?\.text/,
    )
  })

  it('routes the tools_only reason through composeRecoveryMessage', () => {
    // "Try again" is wrong advice when a tool may already have shipped a side
    // effect, and only that reason may spend a background model call.
    expect(pipelineSource).toMatch(
      /emptyReason === 'tools_only'\s*\?\s*await composeRecoveryMessage\(/,
    )
  })

  it('never labels an analytics event with the tier-resolved model', () => {
    // `model` is the platform tier's serving model; a workspace custom endpoint
    // swaps the provider out and pins its own wire id, so `model` never reaches
    // a provider. Labelling with it blamed `gemini-3.7-flash` for a turn served
    // by `custom:646340b5` on 2026-08-24.
    expect(pipelineSource).not.toMatch(/sanitizeAnalytics\(model\)/)
    expect(pipelineSource).toContain(
      'const analyticsModel = customLlmRuntime?.selector ?? model',
    )
  })
})
