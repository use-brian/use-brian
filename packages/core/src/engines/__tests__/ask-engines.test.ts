import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import {
  createEngineAskers,
  createGscQuerier,
  EngineInputError,
  EngineBudgetError,
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
        .mockResolvedValueOnce(fakeResponse('You exceeded your quota', 429))
        .mockResolvedValueOnce(perplexityResponse('served'))
      const [asker] = createEngineAskers(PPLX, fetchMock as unknown as typeof fetch)
      const run = await asker.run({ questions: ['q1', 'q2'] })

      expect(run.successfulUnits).toBe(1)
      expect(run.allFailed).toBe(false)
      // Vendor wording never reaches the caller — only the coded sentence.
      expect(JSON.stringify(run.payload)).not.toContain('quota')
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

  describe('searchConsoleQuery', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const saJson = JSON.stringify({
      client_email: 'watch@project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      token_uri: 'https://oauth2.googleapis.com/token',
    })

    it('is absent without a service-account credential', () => {
      expect(createGscQuerier({})).toBeNull()
    })

    it('signs a service-account JWT, queries the configured property, and caches the token', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ access_token: 'ya29.tok', expires_in: 3600 }))
        .mockResolvedValueOnce(fakeResponse({ rows: [{ keys: ['ai company brain'], clicks: 3 }] }))
        .mockResolvedValueOnce(fakeResponse({ rows: [] }))
      const gsc = createGscQuerier(
        { ENGINES_GSC_KEY_JSON: saJson, ENGINES_GSC_SITE: 'sc-domain:example.com' },
        fetchMock as unknown as typeof fetch,
      )!

      const data = await gsc.query({ startDate: '2026-08-01', endDate: '2026-08-07' })
      expect(data).toEqual({ rows: [{ keys: ['ai company brain'], clicks: 3 }] })

      const [queryUrl] = fetchMock.mock.calls[1] as [string]
      expect(queryUrl).toContain('/sites/sc-domain%3Aexample.com/searchAnalytics/query')

      await gsc.query({ startDate: '2026-08-01', endDate: '2026-08-07' })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('resolves the property BEFORE taking budget, so a siteless call costs nothing', async () => {
      const fetchMock = vi.fn()
      const takeBudget = vi.fn(() => null)
      const gsc = createGscQuerier(
        { ENGINES_GSC_KEY_JSON: saJson },
        fetchMock as unknown as typeof fetch,
      )!

      await expect(
        gsc.query({ startDate: '2026-08-01', endDate: '2026-08-07' }, takeBudget),
      ).rejects.toBeInstanceOf(EngineInputError)
      expect(takeBudget).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('surfaces a budget refusal as its own error carrying the sentence the hook gave', async () => {
      const fetchMock = vi.fn()
      const gsc = createGscQuerier(
        { ENGINES_GSC_KEY_JSON: saJson, ENGINES_GSC_SITE: 'sc-domain:example.com' },
        fetchMock as unknown as typeof fetch,
      )!

      await expect(
        gsc.query({ startDate: '2026-08-01', endDate: '2026-08-07' }, () => 'ceiling reached'),
      ).rejects.toThrow(new EngineBudgetError('ceiling reached'))
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
