/**
 * Document adaptation — the one seam where inline media becomes readable text
 * for a model that cannot read it natively.
 *
 * ## Why it lives at the provider boundary
 *
 * A PDF enters the engine as an `image` ContentBlock with
 * `mimeType: 'application/pdf'` — a contract shaped for Gemini's native
 * `inlineData` reader, and honoured by exactly one adapter. Every other place
 * that produced one of those blocks had to know, independently, whether the
 * model it was about to hit could read it: web chat had a gate, the channel
 * builders had none, the mid-loop fallback had none, and history replay had
 * none. Four surfaces, one rule, three of them wrong.
 *
 * The rule belongs where the decision is actually knowable — at dispatch, when
 * the concrete model is known. `wrapDocumentAdaptation` sits in front of a
 * provider and swaps every unsupported PDF or image block for its distillate
 * before the request reaches the adapter. So web chat, all four channel adapters, the outage
 * fallback firing mid-turn, and replayed history all inherit one behaviour
 * with zero per-route wiring.
 *
 * **If a channel path looks like it needs its own PDF handling, the wrapper is
 * in the wrong place.** That is the design's own falsification test.
 *
 * ## Applied per concrete model, including the fallback
 *
 * `nativePdf` comes from the registry row of the model being dispatched to, so
 * a Gemini primary passes through untouched (zero overhead) while an Anthropic
 * fallback wrapped around it receives the distillate instead of silently
 * dropping the block. That only works because the routing provider wraps each
 * concrete provider separately — see `routing.ts`.
 *
 * ## Ports, not dependencies
 *
 * Core stays DB-free: `distill` and `cache` are injected. The cache is keyed by
 * content hash, so re-attaching, re-asking, or arriving on a second surface is
 * free (see `db/pdf-distillate-store.ts` in the api package).
 *
 * Spec: docs/architecture/engine/file-handling.md
 * Plan: docs/plans/pdf-universal-read.md §4.3
 *
 * [COMP:providers/document-adaptation]
 */

import { createHash } from 'node:crypto'
import type {
  ContentBlock,
  LLMProvider,
  Message,
  ProviderRequest,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
  TokenUsage,
} from './types.js'

const PDF_MIME = 'application/pdf'

type DocumentDistillResult = {
  text: string
  model: string
  pageCount?: number
  truncated?: boolean
  usage?: TokenUsage | null
}

/**
 * Produces the distillate for one document. `configKey` fingerprints the
 * current configuration (engine version, render width, chunk size, model) and
 * is read BEFORE `distill` runs, because it is half the cache key.
 */
export type DocumentDistillPort = {
  configKey: string
  distill(input: { buffer: Buffer; mime: string }): Promise<DocumentDistillResult>
}

export type DistillateCachePort = {
  get(contentHash: string, configKey: string): Promise<{ text: string } | null>
  set(input: {
    contentHash: string
    configKey: string
    text: string
    model: string
    usage?: TokenUsage | null
    pageCount?: number | null
    truncated?: boolean
  }): Promise<void>
}

export type DocumentAdaptationOptions = {
  /** From the dispatched model's registry row. `true` = PDFs pass through. */
  nativePdf: boolean
  /** From the dispatched model's registry row. `true` = images pass through. */
  vision: boolean
  distill?: DocumentDistillPort
  cache?: DistillateCachePort
}

function attachmentTag(
  name: string | undefined,
  mime: string,
  body: string,
  distilled: boolean,
): string {
  const attrs = [
    ...(name ? [`name="${name.replace(/"/g, "'")}"`] : []),
    `type="${mime}"`,
    ...(distilled ? ['distilled="true"'] : []),
  ].join(' ')
  return `<attached_file ${attrs}>\n${body}\n</attached_file>`
}

/**
 * What the model sees when an attachment could not be read. Deliberately
 * instructive: the failure mode being designed out is the model inventing
 * contents or promising to retry, both of which read to a user as success.
 */
function failureBody(reason: string): string {
  return (
    `[This attachment could not be read: ${reason}. Tell the user plainly that you could not read it; ` +
    `do NOT guess at its contents, summarize it, or say you will try again.]`
  )
}

type InlineMediaBlock = Extract<ContentBlock, { type: 'image' }>

function shouldAdaptBlock(
  block: ContentBlock,
  options: DocumentAdaptationOptions,
): block is InlineMediaBlock {
  return block.type === 'image' && (
    (block.mimeType === PDF_MIME && !options.nativePdf) ||
    (block.mimeType.startsWith('image/') && !options.vision)
  )
}

function hasUnsupportedMedia(
  messages: readonly Message[],
  options: DocumentAdaptationOptions,
): boolean {
  return messages.some(
    (m) => typeof m.content !== 'string' && m.content.some((block) => shouldAdaptBlock(block, options)),
  )
}

function requestKey(block: InlineMediaBlock): string {
  return `${block.mimeType}\x00${block.data}`
}

/**
 * Resolve every distinct unsupported attachment in the request to text once.
 *
 * Deduplicated by MIME and data: the same attachment usually appears both in
 * the current turn and in replayed history, while identical bytes presented
 * as different media types still require distinct distillation.
 */
async function resolveDistillates(
  messages: readonly Message[],
  options: DocumentAdaptationOptions,
): Promise<Map<string, string>> {
  const byAttachment = new Map<string, string>()
  const pending = new Map<string, Promise<string>>()

  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (!shouldAdaptBlock(block, options)) continue
      const key = requestKey(block)
      if (pending.has(key)) continue
      pending.set(key, resolveOne(block.data, block.mimeType, options))
    }
  }

  for (const [key, promise] of pending) byAttachment.set(key, await promise)
  return byAttachment
}

async function resolveOne(
  base64: string,
  mime: string,
  options: DocumentAdaptationOptions,
): Promise<string> {
  if (!options.distill) {
    return failureBody('this deployment has no attachment-distillation backend configured')
  }
  let buffer: Buffer
  try {
    buffer = Buffer.from(base64, 'base64')
  } catch {
    return failureBody('the stored attachment is not valid base64')
  }

  const contentHash = createHash('sha256').update(buffer).digest('hex')
  const configKey = options.distill.configKey

  if (options.cache) {
    // A cache read must never take a turn down — a cache outage degrades to
    // paying for the distill again, not to failing the message.
    const hit = await options.cache.get(contentHash, configKey).catch(() => null)
    if (hit?.text) return hit.text
  }

  let result: DocumentDistillResult
  try {
    result = await options.distill.distill({ buffer, mime })
  } catch (err) {
    return failureBody(err instanceof Error ? err.message : String(err))
  }
  if (!result.text.trim()) return failureBody('it produced no readable text')

  if (options.cache) {
    await options.cache
      .set({
        contentHash,
        configKey,
        text: result.text,
        model: result.model,
        usage: result.usage ?? null,
        pageCount: result.pageCount ?? null,
        truncated: result.truncated ?? false,
      })
      .catch(() => {})
  }
  return result.text
}

/**
 * Swap unsupported media blocks for text. Returns a NEW message array —
 * session history is shared state and must not be mutated by a dispatch.
 */
function swapUnsupportedMedia(
  messages: readonly Message[],
  texts: Map<string, string>,
  options: DocumentAdaptationOptions,
): Message[] {
  return messages.map((message) => {
    if (typeof message.content === 'string') return message
    if (!message.content.some((block) => shouldAdaptBlock(block, options))) return message
    return {
      ...message,
      content: message.content.map((block): ContentBlock => {
        if (!shouldAdaptBlock(block, options)) return block
        const text = texts.get(requestKey(block)) ?? failureBody('it could not be resolved')
        const distilled = !text.startsWith('[This attachment could not be read')
        return {
          type: 'text',
          text: attachmentTag(block.name, block.mimeType, text, distilled),
        }
      }),
    }
  })
}

/**
 * Wrap a provider so inline media it cannot read arrives as distilled text.
 *
 * A provider with both capabilities returns untouched and pays no scan cost.
 */
export function wrapDocumentAdaptation(
  provider: LLMProvider,
  options: DocumentAdaptationOptions,
): LLMProvider {
  if (options.nativePdf && options.vision) return provider

  async function adapt(messages: readonly Message[]): Promise<Message[]> {
    if (!hasUnsupportedMedia(messages, options)) return messages as Message[]
    return swapUnsupportedMedia(messages, await resolveDistillates(messages, options), options)
  }

  return {
    name: provider.name,
    models: provider.models,

    stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
      // `stream` is synchronous by signature, so the async swap happens inside
      // the generator — the first `next()` awaits it before anything dispatches.
      return (async function* () {
        const messages = await adapt(request.messages)
        yield* provider.stream(messages === request.messages ? request : { ...request, messages })
      })()
    },

    createSession(sessionOptions: SessionOptions): ProviderSession {
      const inner = provider.createSession(sessionOptions)
      return {
        send(messages: Message[], opts?: SendOptions): AsyncIterable<StreamChunk> {
          return (async function* () {
            yield* inner.send(await adapt(messages), opts)
          })()
        },
      }
    },
  }
}
