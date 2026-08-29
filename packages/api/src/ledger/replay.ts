/**
 * Replay — re-run a recorded turn from its ledger trace (plan §9,
 * primitive 4: evals as a by-product of the substrate, not bolted on).
 *
 * `reconstructTurnInputs` resolves a trace's first provider_call back
 * into the exact inputs the lane sent — system prompt, message history,
 * model — by dereferencing the content-addressed payload refs. Erased
 * payloads surface as an explicit error (the D2 marker, never a silent
 * hole in the transcript). `replayTurn` then drives `queryLoop` with a
 * variant provider/model/prompt and returns the replayed text beside the
 * recorded one — their difference IS the eval.
 *
 * The `ledger` for the replay loop is caller-supplied: eval lanes pass
 * `NOOP_TURN_LEDGER` (nothing to persist), and a future self-recording
 * replay can pass a real recorder without touching this module.
 *
 * Spec: docs/architecture/engine/turn-ledger.md → "Replay"
 * [COMP:api/ledger-replay]
 */

import type { LLMProvider, Message, Tool, TurnLedger } from '@use-brian/core'
import { queryLoop } from '@use-brian/core'
import { listTraceEvents, type TurnEventRow } from '../db/turn-ledger-store.js'
import type { LedgerPayloadStore } from './payload-store.js'

export type ReconstructedTurn = {
  model: string
  systemPrompt: string
  messages: Message[]
  /** The recorded assistant response text, for diffing against a replay. */
  recordedText: string
  workspaceId: string | null
}

export type ReconstructDeps = {
  listTraceEvents: typeof listTraceEvents
  payloads: LedgerPayloadStore
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: string }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

export async function reconstructTurnInputs(
  assistantMessageId: string,
  deps: ReconstructDeps,
): Promise<ReconstructedTurn | null> {
  const events = await deps.listTraceEvents(assistantMessageId)
  const call: TurnEventRow | undefined = events.find((e) => e.kind === 'provider_call')
  if (!call) return null
  const responseRef = typeof call.metadata.responseRef === 'string' ? call.metadata.responseRef : null
  const refs = call.payloadRefs
  if (refs.length < 2) return null

  const resolve = async (hash: string): Promise<string> => {
    const got = await deps.payloads.get(call.workspaceId, hash)
    if (!got) throw new Error(`replay: payload ${hash.slice(0, 12)}… is missing`)
    if ('erased' in got) throw new Error(`replay: payload ${hash.slice(0, 12)}… was erased — this turn is no longer replayable`)
    return got.content
  }

  const systemPrompt = await resolve(refs[0])
  const messageRefs = refs.slice(1).filter((r) => r !== responseRef)
  const messages: Message[] = []
  for (const ref of messageRefs) {
    messages.push(JSON.parse(await resolve(ref)) as Message)
  }
  let recordedText = ''
  if (responseRef) {
    recordedText = textOfContent(JSON.parse(await resolve(responseRef)))
  }
  return {
    model: typeof call.metadata.model === 'string' ? call.metadata.model : 'unknown',
    systemPrompt,
    messages,
    recordedText,
    workspaceId: call.workspaceId,
  }
}

export type ReplayResult = {
  replayText: string
  recordedText: string
  changed: boolean
}

/**
 * Drive the reconstructed inputs through queryLoop with a variant. Tools
 * default to none (a pure-generation replay); pass the original toolset
 * to replay tool choice as well.
 */
export async function replayTurn(args: {
  inputs: ReconstructedTurn
  provider: LLMProvider
  ledger: TurnLedger
  /** Variant overrides — the thing being evaluated. */
  model?: string
  systemPrompt?: string
  tools?: Map<string, Tool>
  maxTurns?: number
}): Promise<ReplayResult> {
  let replayText = ''
  for await (const event of queryLoop({
    ledger: args.ledger,
    provider: args.provider,
    model: args.model ?? args.inputs.model,
    systemPrompt: args.systemPrompt ?? args.inputs.systemPrompt,
    messages: args.inputs.messages,
    tools: args.tools ?? new Map(),
    context: {
      userId: 'replay',
      assistantId: 'replay',
      sessionId: `replay-${Date.now()}`,
      appId: 'replay',
      channelType: 'replay',
      channelId: 'replay',
      abortSignal: new AbortController().signal,
    },
    maxTurns: args.maxTurns ?? 4,
    stateless: true,
  })) {
    if (event.type === 'text_delta') replayText += event.text
  }
  return {
    replayText,
    recordedText: args.inputs.recordedText,
    changed: replayText.trim() !== args.inputs.recordedText.trim(),
  }
}
