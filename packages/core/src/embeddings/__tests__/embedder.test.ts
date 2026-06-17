import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import dotenv from 'dotenv'
import { resolve } from 'node:path'
import {
  createGeminiEmbedder,
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MODEL_ID,
} from '../embedder.js'

dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '..', '..', '.env') })

describe('[COMP:embeddings/embedder] Gemini embedder (unit)', () => {
  it('exposes the locked dimensions and model_id', () => {
    const embedder = createGeminiEmbedder('test-key')
    expect(embedder.dimensions).toBe(768)
    expect(GEMINI_EMBEDDING_DIMENSIONS).toBe(768)
    expect(embedder.model_id).toBe('gemini:gemini-embedding-001')
    expect(GEMINI_EMBEDDING_MODEL_ID).toBe('gemini:gemini-embedding-001')
  })

  describe('embed', () => {
    let fetchSpy: MockInstance<typeof fetch>

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as MockInstance<typeof fetch>
    })

    afterEach(() => {
      fetchSpy.mockRestore()
    })

    it('short-circuits on empty input without making an HTTP call', async () => {
      const embedder = createGeminiEmbedder('test-key')
      const result = await embedder.embed([])
      expect(result).toEqual([])
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('returns vectors in input order from a batched response', async () => {
      const vec = (seed: number) => Array.from({ length: 768 }, (_, i) => seed + i / 1000)
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            embeddings: [{ values: vec(1) }, { values: vec(2) }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

      const embedder = createGeminiEmbedder('test-key')
      const result = await embedder.embed(['foo', 'bar'])

      expect(result).toHaveLength(2)
      expect(result[0]).toHaveLength(768)
      expect(result[1]).toHaveLength(768)
      expect(result[0][0]).toBe(1)
      expect(result[1][0]).toBe(2)

      const [calledUrl, init] = fetchSpy.mock.calls[0]
      expect(String(calledUrl)).toContain('gemini-embedding-001:batchEmbedContents')
      const headers = (init as RequestInit).headers as Record<string, string>
      expect(headers['x-goog-api-key']).toBe('test-key')
      const body = JSON.parse((init as RequestInit).body as string)
      expect(body.requests).toHaveLength(2)
      expect(body.requests[0].outputDimensionality).toBe(768)
      expect(body.requests[0].content.parts[0].text).toBe('foo')
    })

    it('throws on non-2xx responses with status and body', async () => {
      fetchSpy.mockResolvedValue(
        new Response('quota exceeded', { status: 429 }),
      )
      const embedder = createGeminiEmbedder('test-key')
      await expect(embedder.embed(['x'])).rejects.toThrow(/429/)
    })

    it('throws when the API returns a vector of the wrong length', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ embeddings: [{ values: [1, 2, 3] }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      const embedder = createGeminiEmbedder('test-key')
      await expect(embedder.embed(['x'])).rejects.toThrow(/length 3/)
    })

    it('throws when the API returns the wrong number of vectors', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ embeddings: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      const embedder = createGeminiEmbedder('test-key')
      await expect(embedder.embed(['x'])).rejects.toThrow(/0 vectors for 1 inputs/)
    })
  })

  describe('estimateCost', () => {
    it('returns 0 for empty input', () => {
      const embedder = createGeminiEmbedder('test-key')
      expect(embedder.estimateCost([])).toBe(0)
    })

    it('scales linearly with text length', () => {
      const embedder = createGeminiEmbedder('test-key')
      const small = embedder.estimateCost(['hello world'])
      const big = embedder.estimateCost([Array(100).fill('hello world').join(' ')])
      expect(small).toBeGreaterThan(0)
      expect(big).toBeGreaterThan(small * 50)
    })
  })
})

const apiKey = process.env.GEMINI_API_KEY
const describeIf = apiKey ? describe : describe.skip

describeIf('[COMP:embeddings/embedder] Gemini embedder (integration)', () => {
  const embedder = createGeminiEmbedder(apiKey!)

  it('embeds a single short string into a 768-dim vector', async () => {
    const vectors = await embedder.embed(['hello world'])
    expect(vectors).toHaveLength(1)
    expect(vectors[0]).toHaveLength(768)
    expect(vectors[0].every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true)
  }, 30_000)

  it('embeds a batch preserving input order', async () => {
    const vectors = await embedder.embed(['foo', 'bar'])
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toHaveLength(768)
    expect(vectors[1]).toHaveLength(768)
    // Different inputs should produce different vectors.
    expect(vectors[0]).not.toEqual(vectors[1])
  }, 30_000)
})
