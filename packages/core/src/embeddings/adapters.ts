/**
 * Embedder implementations per LLM adapter.
 *
 * Spec: docs/architecture/brain/embeddings.md §"Provider abstraction",
 * docs/architecture/engine/provider-abstraction.md → "Adapters".
 *
 * ## Two invariants that are easy to break and expensive to discover
 *
 * 1. **Dimensions are pinned at 768 for every adapter.** The stored vector
 *    column is fixed-width; an adapter that returns 1024 floats does not
 *    degrade gracefully, it fails the insert (or worse, silently misaligns
 *    similarity math). All three vendors below can be asked for 768, so all
 *    three are asked explicitly rather than trusting a default.
 *
 * 2. **Vectors from different adapters are NOT comparable.** Cosine similarity
 *    between a Gemini vector and a Qwen vector is meaningless — they occupy
 *    unrelated spaces. Each embedder therefore reports a distinct `model_id`,
 *    which is what lets retrieval detect the mismatch. **Switching
 *    `LLM_ADAPTER` on a deployment with existing embeddings requires a full
 *    re-embed**; until that completes, retrieval over old rows returns noise.
 *    This is the single most consequential operational fact about the
 *    embedding side of adapter switching.
 */

import {
  authorizeGoogleRequest,
  type GoogleTransport,
} from '@use-brian/agent-runtime/providers/google-transport.js'
import type { Embedder } from './embedder.js'
import { GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_MODEL_ID, createGeminiEmbedder } from './embedder.js'
import type { ExternalCredentialPool } from '@use-brian/agent-runtime/providers/credential-pool.js'

/**
 * Vertex serves the same embedding family as AI Studio (`gemini-embedding-001`),
 * via `:predict`. It reports the SAME `model_id` as AI Studio deliberately:
 * the vectors occupy the identical space, so (a) switching a deployment between
 * AI Studio and Vertex needs no re-embed, and (b) usage prices via the existing
 * `gemini-embedding-001` registry row. Only DashScope is a distinct space.
 */
const VERTEX_EMBEDDING_MODEL = 'gemini-embedding-001'
export const VERTEX_EMBEDDING_MODEL_ID = GEMINI_EMBEDDING_MODEL_ID

/** DashScope's multilingual embedding model; v3 supports an explicit `dimensions`. */
const DASHSCOPE_EMBEDDING_MODEL = 'text-embedding-v3'
export const DASHSCOPE_EMBEDDING_MODEL_ID = 'dashscope:text-embedding-v3'
const DASHSCOPE_EMBEDDING_BATCH_MAX = 10

const COST_PER_M_TOKENS_USD = 0.025

/** Shared rough token estimate (~4 chars/token), mirroring the Gemini embedder. */
function estimateCost(texts: string[]): number {
  const chars = texts.reduce((sum, t) => sum + t.length, 0)
  return (chars / 4 / 1_000_000) * COST_PER_M_TOKENS_USD
}

/**
 * Which embedder an adapter uses. Mirrors `LLM_ADAPTER`.
 */
export type EmbedderAdapterConfig =
  | { adapter: 'google-ai-studio'; apiKey?: string; transport?: GoogleTransport }
  | { adapter: 'vertex'; transport: GoogleTransport }
  | {
      adapter: 'alicloud'
      apiKey: string
      baseUrl: string
      credentialPool?: ExternalCredentialPool
      systemFallback?: string
    }

/**
 * Build the embedder for the active adapter.
 *
 * Construct this ONCE at boot and share the instance. It used to be rebuilt at
 * nine separate call sites, which made the vendor un-swappable in practice —
 * changing embedder meant finding all nine — and meant nine objects where one
 * would do.
 */
export function createEmbedderForAdapter(
  config: EmbedderAdapterConfig,
  opts: { signal?: AbortSignal } = {},
): Embedder {
  switch (config.adapter) {
    case 'vertex':
      return createVertexEmbedder(config.transport, opts)
    case 'alicloud':
      return config.credentialPool
        ? createCredentialPoolDashScopeEmbedder(
            config.credentialPool,
            config.systemFallback,
            config.baseUrl,
            opts,
          )
        : createDashScopeEmbedder(config.apiKey, config.baseUrl, opts)
    case 'google-ai-studio':
    default:
      return config.transport
        ? createAiStudioEmbedder(config.transport, opts)
        : createGeminiEmbedder(config.apiKey ?? '', opts)
  }
}

type AiStudioBatchEmbedResponse = {
  embeddings?: Array<{ values?: number[] }>
}

/** AI Studio embedder over a live credential-resolving Google transport. */
export function createAiStudioEmbedder(
  transport: GoogleTransport,
  opts: { signal?: AbortSignal } = {},
): Embedder {
  return {
    dimensions: GEMINI_EMBEDDING_DIMENSIONS,
    model_id: GEMINI_EMBEDDING_MODEL_ID,
    estimateCost,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []
      const authorization = await authorizeGoogleRequest(transport)
      const response = await fetch(transport.endpoint(GEMINI_EMBEDDING_MODEL_ID.replace('gemini:', ''), 'batchEmbedContents'), {
        method: 'POST',
        headers: authorization.headers,
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${GEMINI_EMBEDDING_MODEL_ID.replace('gemini:', '')}`,
            content: { parts: [{ text }] },
            outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS,
          })),
        }),
        signal: opts.signal,
      })
      if (!response.ok) {
        throw new Error(`Gemini embedding API error ${response.status}: ${await response.text()}`)
      }
      const json = (await response.json()) as AiStudioBatchEmbedResponse
      const embeddings = json.embeddings ?? []
      if (embeddings.length !== texts.length) {
        throw new Error(`Gemini embedding API returned ${embeddings.length} vectors for ${texts.length} inputs`)
      }
      const vectors = embeddings.map((embedding, index) => {
        const values = embedding.values
        if (!values || values.length !== GEMINI_EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Gemini embedding API returned vector of length ${values?.length ?? 0} ` +
            `for input ${index}; expected ${GEMINI_EMBEDDING_DIMENSIONS}`,
          )
        }
        return values
      })
      if (authorization.recordSpend) {
        const inputTokens = texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0)
        await authorization.recordSpend(GEMINI_EMBEDDING_MODEL_ID, { inputTokens, outputTokens: 0 }).catch(() => {})
      }
      return vectors
    },
  }
}

type VertexPredictResponse = {
  predictions?: Array<{ embeddings?: { values?: number[] } }>
}

/**
 * Vertex AI embeddings.
 *
 * Note the shape difference from AI Studio: Vertex uses `:predict` with an
 * `instances` array rather than `:batchEmbedContents` with `requests`, and it
 * nests the vector under `predictions[].embeddings.values`. Same model family,
 * different envelope — which is why this can't reuse the Gemini embedder the
 * way the chat provider reuses its request builder.
 */
export function createVertexEmbedder(
  transport: GoogleTransport,
  opts: { signal?: AbortSignal } = {},
): Embedder {
  return {
    dimensions: GEMINI_EMBEDDING_DIMENSIONS,
    model_id: VERTEX_EMBEDDING_MODEL_ID,
    estimateCost,

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []

      const url = transport.endpoint(VERTEX_EMBEDDING_MODEL, 'predict')
      const headers = await transport.headers()

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          instances: texts.map((content) => ({ content })),
          parameters: { outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS },
        }),
        signal: opts.signal,
      })

      if (!response.ok) {
        const errBody = await response.text()
        throw new Error(`Vertex embedding API error ${response.status}: ${errBody}`)
      }

      const json = (await response.json()) as VertexPredictResponse
      const predictions = json.predictions ?? []
      if (predictions.length !== texts.length) {
        throw new Error(
          `Vertex embedding API returned ${predictions.length} vectors for ${texts.length} inputs`,
        )
      }
      return predictions.map((p, i) => {
        const values = p.embeddings?.values
        if (!values) throw new Error(`Vertex embedding API returned no values for input ${i}`)
        return values
      })
    },
  }
}

type DashScopeEmbedResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>
}

/**
 * DashScope embeddings via the OpenAI-compatible `/embeddings` endpoint.
 *
 * The response is index-addressed rather than positional, so results are
 * re-sorted by `index` before being returned: OpenAI-compatible servers are
 * permitted to reorder, and silently mismatched vectors would poison retrieval
 * in a way that is nearly impossible to trace back here.
 */
export function createDashScopeEmbedder(
  apiKey: string,
  baseUrl: string,
  opts: { signal?: AbortSignal } = {},
): Embedder {
  return {
    dimensions: GEMINI_EMBEDDING_DIMENSIONS,
    model_id: DASHSCOPE_EMBEDDING_MODEL_ID,
    estimateCost,

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []

      const vectors: number[][] = []
      for (let offset = 0; offset < texts.length; offset += DASHSCOPE_EMBEDDING_BATCH_MAX) {
        const chunk = texts.slice(offset, offset + DASHSCOPE_EMBEDDING_BATCH_MAX)
        const response = await fetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: DASHSCOPE_EMBEDDING_MODEL,
            input: chunk,
            // Explicit, never defaulted — see the dimensions invariant above.
            dimensions: GEMINI_EMBEDDING_DIMENSIONS,
            encoding_format: 'float',
          }),
          signal: opts.signal,
        })

        if (!response.ok) {
          const errBody = await response.text()
          throw new Error(`DashScope embedding API error ${response.status}: ${errBody}`)
        }

        const json = (await response.json()) as DashScopeEmbedResponse
        const data = json.data ?? []
        if (data.length !== chunk.length) {
          throw new Error(
            `DashScope embedding API returned ${data.length} vectors for ${chunk.length} inputs`,
          )
        }

        const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        vectors.push(...ordered.map((d, i) => {
          if (!d.embedding) {
            throw new Error(`DashScope embedding API returned no vector for input ${offset + i}`)
          }
          if (d.embedding.length !== GEMINI_EMBEDDING_DIMENSIONS) {
            throw new Error(
              `DashScope returned ${d.embedding.length}-dim vector, expected ${GEMINI_EMBEDDING_DIMENSIONS}. ` +
              `The stored vector column is fixed-width — refusing to write a mismatched vector.`,
            )
          }
          return d.embedding
        }))
      }
      return vectors
    },
  }
}

/** DashScope embedder whose credential is selected for each submitted batch. */
function createCredentialPoolDashScopeEmbedder(
  pool: ExternalCredentialPool,
  systemFallback: string | undefined,
  baseUrl: string,
  opts: { signal?: AbortSignal } = {},
): Embedder {
  return {
    dimensions: GEMINI_EMBEDDING_DIMENSIONS,
    model_id: DASHSCOPE_EMBEDDING_MODEL_ID,
    estimateCost,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []
      const lease = await pool.resolve('dashscope', systemFallback)
      if (!lease) throw new Error('No eligible DashScope credential is configured')
      const vectors = await createDashScopeEmbedder(lease.secret, baseUrl, opts).embed(texts)
      const costUsd = estimateCost(texts)
      if (costUsd > 0) {
        await lease.recordSpend(costUsd).catch((error) => {
          console.error(
            '[provider-credentials] failed to record DashScope embedding spend',
            error instanceof Error ? error.message : String(error),
          )
        })
      }
      return vectors
    },
  }
}
