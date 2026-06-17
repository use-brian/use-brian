/**
 * Embedder provider abstraction — WU-8.1.
 *
 * Spec: docs/architecture/brain/embeddings.md §"Provider abstraction".
 *
 * Launch implementation: Gemini gemini-embedding-001 truncated to 768 dimensions
 * via MRL, called via the REST API (no SDK, mirroring `providers/gemini.ts`).
 * The `Embedder` interface is the seam — vendor swaps (Cohere multilingual-v3,
 * OpenAI text-embedding-3) land here without rippling into the embedding worker
 * or retrieval code.
 */

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const MODEL_API_ID = 'gemini-embedding-001'

export const GEMINI_EMBEDDING_DIMENSIONS = 768
export const GEMINI_EMBEDDING_MODEL_ID = 'gemini:gemini-embedding-001'

// Per Gemini pricing (embeddings.md §"Cost model"): $0.025 per million input tokens.
const COST_PER_M_TOKENS_USD = 0.025

export interface Embedder {
  readonly dimensions: number
  readonly model_id: string
  embed(texts: string[]): Promise<number[][]>
  estimateCost(texts: string[]): number
}

type BatchEmbedResponse = {
  embeddings?: Array<{ values?: number[] }>
}

export function createGeminiEmbedder(
  apiKey: string,
  opts: { signal?: AbortSignal } = {},
): Embedder {
  return {
    dimensions: GEMINI_EMBEDDING_DIMENSIONS,
    model_id: GEMINI_EMBEDDING_MODEL_ID,

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []

      const url = `${BASE_URL}/models/${MODEL_API_ID}:batchEmbedContents`
      const body = {
        requests: texts.map((text) => ({
          model: `models/${MODEL_API_ID}`,
          content: { parts: [{ text }] },
          outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS,
        })),
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      if (!response.ok) {
        const errBody = await response.text()
        throw new Error(`Gemini embedding API error ${response.status}: ${errBody}`)
      }

      const json = (await response.json()) as BatchEmbedResponse
      const embeddings = json.embeddings ?? []
      if (embeddings.length !== texts.length) {
        throw new Error(
          `Gemini embedding API returned ${embeddings.length} vectors for ${texts.length} inputs`,
        )
      }

      return embeddings.map((e, i) => {
        const values = e.values
        if (!values || values.length !== GEMINI_EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Gemini embedding API returned vector of length ${values?.length ?? 0} ` +
              `for input ${i}; expected ${GEMINI_EMBEDDING_DIMENSIONS}`,
          )
        }
        return values
      })
    },

    // Pre-call USD estimate using a ~4-chars-per-token heuristic. Gemini has no
    // free client-side tokenizer; the embedding worker records actual cost from
    // the response's token usage (WU-8.3 in `embeddings.md` §"Cost model").
    estimateCost(texts: string[]): number {
      const tokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0)
      return (tokens / 1_000_000) * COST_PER_M_TOKENS_USD
    },
  }
}
