import { describe, it, expect, vi } from 'vitest'
import {
  createEngineAskers,
  EngineInputError,
  type EnginesEnv,
} from '../ask-engines.js'

function fakeResponse(body: unknown, status = 200) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
    json: async () => JSON.parse(raw) as unknown,
  } as Response
}

function perplexityResponse(content: string, urls: string[] = []) {
  return fakeResponse({
    choices: [{ message: { content } }],
    search_results: urls.map((url) => ({ url, title: 't' })),
  })
}

const PPLX: EnginesEnv = { ENGINES_PERPLEXITY_API_KEY: 'pplx-k' }

describe('[COMP:core/ask-engines] engine ask framework', () => {
  describe('availability', () => {
    it('builds only the engines whose credential exists, in a stable order', () => {
      expect(createEngineAskers({}).map((a) => a.name)).toEqual([])
      const names = createEngineAskers({
        ENGINES_OPENAI_API_KEY: 'sk-k',
        ENGINES_PERPLEXITY_API_KEY: 'pplx-k',
        ENGINES_ANTHROPIC_API_KEY: 'ant-k',
      }).map((a) => a.name)
      expect(names).toEqual(['askOpenAI', 'askPerplexity', 'askClaude'])
    })

    it('exposes the engine id used to key the rates table', () => {
      const [asker] = createEngineAskers(PPLX)
      expect(asker.engine).toBe('perplexity')
      expect(asker.model).toBe('sonar')
    })
  })

  describe('batch / samples / detection', () => {
    it('makes one upstream call per question × sample and counts every success', async () => {
      const fetchMock = vi.fn().mockResolvedValue(perplexityResponse('a'))
      const [asker] = createEngineAskers(PPLX, fetchMock as unknown as typeof fetch)
      const run = await asker.run({ questions: ['q1', 'q2'], samples: 2 })

      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(run.successfulUnits).toBe(4)
      expect(run.allFailed).toBe(false)
      expect(run.payload.results.map((r) => r.question)).toEqual(['q1', 'q2'])
      expect(run.payload.results[0].answers).toHaveLength(2)
    })

    it('detects checkFor terms in the FULL answer even when truncating the returned prose', async () => {
      const longTail = `${'x'.repeat(900)} Use Brian is mentioned way out here.`
      const fetchMock = vi
        .fn()
        .mockResolvedValue(perplexityResponse(longTail, ['https://competitor.example/compare']))
      const [asker] = createEngineAskers(PPLX, fetchMock as unknown as typeof fetch)
      const run = await asker.run({
        question: 'q',
        checkFor: ['use brian', 'competitor.example', 'absent-term'],
        answerMaxChars: 200,
      })

      const one = run.payload.results[0].answers[0]
      expect('answer' in one && one.answer).toContain('[truncated]')
      expect('matches' in one && one.matches).toEqual([
        { term: 'use brian', inAnswer: true, inCitations: false },
        { term: 'competitor.example', inAnswer: false, inCitations: true },
        { term: 'absent-term', inAnswer: false, inCitations: false },
      ])
    })
  })

  describe('billable unit accounting', () => {
    it('counts only units that returned an answer — refused units are not billable', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse('upstream unavailable', 500))
        .mockResolvedValueOnce(perplexityResponse('served'))
      const [asker] = createEngineAskers(PPLX, fetchMock as unknown as typeof fetch)
      const run = await asker.run({ questions: ['q1', 'q2'] })

      expect(run.successfulUnits).toBe(1)
      expect(run.allFailed).toBe(false)
      // Vendor wording never reaches the caller — only the coded sentence.
      expect(JSON.stringify(run.payload)).not.toContain('quota')
    })

    it('retries one Perplexity 429 inside the same billable unit', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse('You exceeded your quota', 429))
        .mockResolvedValueOnce(perplexityResponse('served after retry'))
      const [asker] = createEngineAskers(PPLX, fetchMock as unknown as typeof fetch)
      const run = await asker.run({ question: 'q1' })

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(run.successfulUnits).toBe(1)
      expect(run.allFailed).toBe(false)
      expect(JSON.stringify(run.payload)).not.toContain('quota')
    })

    it('stops after the bounded Perplexity 429 retry and reports the unit failed', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse('still limited', 429))
      const [asker] = createEngineAskers(PPLX, fetchMock as unknown as typeof fetch)
      const run = await asker.run({ question: 'q1' })

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(run.successfulUnits).toBe(0)
      expect(run.allFailed).toBe(true)
      expect(JSON.stringify(run.payload)).toContain('upstream_error status=429')
      expect(JSON.stringify(run.payload)).not.toContain('still limited')
    })

    it('reports allFailed with zero billable units when every unit errored', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse('nope', 500))
      const [asker] = createEngineAskers(PPLX, fetchMock as unknown as typeof fetch)
      const run = await asker.run({ questions: ['q1', 'q2'] })

      expect(run.successfulUnits).toBe(0)
      expect(run.allFailed).toBe(true)
    })
  })

  describe('the budget hook belongs to the caller, not to core', () => {
    it('stops mid-batch with a note and does not bill the skipped units', async () => {
      const fetchMock = vi.fn().mockResolvedValue(perplexityResponse('a'))
      let remaining = 2
      const [asker] = createEngineAskers(PPLX, fetchMock as unknown as typeof fetch)
      const run = await asker.run({ questions: ['q1', 'q2', 'q3', 'q4'] }, () =>
        remaining-- > 0 ? null : 'ceiling reached',
      )

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(run.successfulUnits).toBe(2)
      expect(run.payload.note).toBe('ceiling reached')
      expect(run.allFailed).toBe(false)
    })

    it('runs unbounded when no hook is passed — the in-process path', async () => {
      const fetchMock = vi.fn().mockResolvedValue(perplexityResponse('a'))
      const [asker] = createEngineAskers(PPLX, fetchMock as unknown as typeof fetch)
      const run = await asker.run({ questions: Array.from({ length: 25 }, (_, i) => `q${i}`), samples: 3 })

      expect(fetchMock).toHaveBeenCalledTimes(75)
      expect(run.successfulUnits).toBe(75)
      expect(run.payload.note).toBeUndefined()
    })
  })

  describe('input refusal', () => {
    it('refuses a call with neither question nor questions, spending nothing', async () => {
      const fetchMock = vi.fn()
      const [asker] = createEngineAskers(PPLX, fetchMock as unknown as typeof fetch)
      await expect(asker.run({})).rejects.toBeInstanceOf(EngineInputError)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses a panel above the batch ceiling', async () => {
      const [asker] = createEngineAskers(PPLX, vi.fn() as unknown as typeof fetch)
      await expect(
        asker.run({ questions: Array.from({ length: 26 }, (_, i) => `q${i}`) }),
      ).rejects.toBeInstanceOf(EngineInputError)
    })
  })
})
