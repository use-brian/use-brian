import { applyOutputRevisions, outputContentDigest, queryOutputProvenance, type OutputRecord, type QueryOutputProvenance, type OutputDisposition } from './output-provenance.js'
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
  observe(event: QueryEvent, provenance?: QueryOutputProvenance): void
  /** Read the current delivery window without consuming it. */
  select(): TurnOutputSelection
  /** Advance only after the selected output has been delivered successfully. */
  advanceDelivery(): void
  /** Internal provenance only, never a durable terminal intent or delivery grant. */
  finalizedSelection(): FinalizedOutputSelection | null
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

export type FinalizedOutputSelection = Readonly<{
  version: 1
  invocationId: string
  format: TurnOutputFormat
  formatter: 'turn_output_v1'
  textDigest: string
  members: readonly Readonly<{ origin: string; revision: number; digest: string; contentDigest: string }>[]
}>

/** One owned snapshot per origin; selection resets never delete transcript identity. */
export function createTurnOutputCollector(
  options: { format?: TurnOutputFormat } = {},
): TurnOutputCollector {
  const format = options.format ?? 'compact'
  const records = new Map<string, OutputRecord>()
  // Synthetic legacy events preserve presentation, but never qualify provenance.
  let window: Array<{ origin: string } | { legacy: AssistantResponse }> = []
  let invocationId: string | undefined
  let disposition: OutputDisposition | undefined
  let qualified = true
  let question: AssistantQuestion | undefined
  let retracted = false
  const responses = () => window.map(entry => 'origin' in entry ? records.get(entry.origin)!.response : entry.legacy)
  return {
    observe(event, supplied) {
      const provenance = supplied ?? queryOutputProvenance(event)
      if (provenance) {
        if (provenance.version !== 1 || invocationId && invocationId !== provenance.invocationId) {
          qualified = false
          throw new Error('Output invocation changed')
        }
        invocationId = provenance.invocationId
        qualified &&= provenance.qualified
        try { applyOutputRevisions(records, provenance) }
        catch (error) { qualified = false; throw error }
        if (provenance.disposition) disposition = provenance.disposition
      } else if (event.type === 'assistant_turn' || event.type === 'turn_complete') qualified = false
      if (event.type === 'error') { qualified = false; disposition = 'error' }
      if (event.type === 'assistant_turn') {
        const emission = provenance?.emission
        if (emission?.replay) {
          if (!records.has(emission.origin)) throw new Error('Missing replayed output')
          return
        }
        const response = emission ? records.get(emission.origin)!.response : event.response
        if (hasToolUse(response) && responses().some(previous => !hasToolUse(previous)
          && (previous.stopReason === 'incomplete' || previous.stopReason === 'max_tokens')
          && textBlocks(previous).length > 0)) {
          window = []
          question = undefined
          retracted = true
        }
        window.push(emission ? { origin: emission.origin } : { legacy: response })
      } else if (event.type === 'question') {
        const { type: _, ...validatedQuestion } = event
        question = validatedQuestion
      } else if (event.type === 'grounding_nudge') {
        window = []
        question = undefined
        retracted = true
      }
    },
    select() {
      if (question) return { kind: 'question', question }
      const current = responses()
      const text = formatResponses(current, format)
      if (text.length > 0) return { kind: 'text', text }
      if (current.length === 0) return { kind: 'empty', reason: retracted ? 'text_withheld' : 'no_model_output' }
      if (current.some(hasToolUse)) return { kind: 'empty', reason: 'tools_only' }
      if (retracted || current.some(response => textBlocks(response).length > 0)) return { kind: 'empty', reason: 'text_withheld' }
      return { kind: 'empty', reason: 'no_model_output' }
    },
    finalizedSelection() {
      if (!qualified || !invocationId || disposition !== 'reply' || question) return null
      const members: FinalizedOutputSelection['members'][number][] = []
      for (const entry of window) {
        if (!('origin' in entry)) return null
        const record = records.get(entry.origin)!
        if (hasToolUse(record.response) || !formatResponses([record.response], format)) continue
        if (!record.sealed) return null
        members.push({ origin: record.origin, revision: record.revision, digest: record.digest,
          contentDigest: outputContentDigest(record.response.content) })
      }
      if (!members.length) return null
      return { version: 1, invocationId, format, formatter: 'turn_output_v1',
        textDigest: outputContentDigest(formatResponses(responses(), format)), members }
    },
    advanceDelivery() {
      window = []
      question = undefined
      retracted = false
      disposition = undefined
    },
  }
}
