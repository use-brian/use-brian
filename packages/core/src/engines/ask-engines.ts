/**
 * AI answer engines — the shared ask framework.
 *
 * Read-only observation of external AI answer engines (OpenAI, Gemini,
 * Perplexity, Claude) plus Google Search Console. Every ask sends a BARE
 * question (no system prompt, no memory, no workspace context — the
 * measurement is only valid when the answer is not ours) and returns the
 * engine's answers + citations as data.
 *
 * This module is the SINGLE source of engine logic. Two surfaces wrap it and
 * neither forks it:
 *
 *   - `packages/core/src/tools/base/ask-engines.ts` — in-process base tools
 *     (`askOpenAI` / `askGemini` / `askPerplexity` / `askClaude` /
 *     `searchConsoleQuery`), env-gated like `xSearch`, whose upstream calls
 *     are METERED through `ToolResult.meta` external-cost.
 *   - `use-brian/packages/api/src/engines-mcp/tools.ts` — the HTTP MCP
 *     surface at `POST /api/engines/mcp` for external agents / self-host
 *     callers, which adds a daily call ceiling on top.
 *
 * Measurement affordances (all use-case-agnostic):
 *   - `questions[]` batch (≤25): a panel of questions in ONE call, so a
 *     caller's own tool-call budget never bounds panel size.
 *   - `samples` (1–3): repeat each question to expose answer stochasticity;
 *     the caller majority-scores.
 *   - `checkFor[]`: server-side case-insensitive term detection over the FULL
 *     answer + citation URLs — detection survives `answerMaxChars` truncation.
 *   - `answerMaxChars`: truncate returned prose so a large batch cannot flood
 *     the caller's context (citations + matches always complete).
 *   - `country` (askOpenAI): approximate search locale, so observation is not
 *     pinned to the server's own region.
 *
 * Deliberately self-contained: no DB, no stores, no workspace state. Env
 * decides which engines exist (an engine without its credential is not
 * built). The daily call ceiling lives OUT of this module — it is the
 * identity-less HTTP surface's concern and arrives as the optional
 * `takeBudget` hook; the in-process path passes none, because workspace
 * budget/credit enforcement is the guard there.
 *
 * Spec: docs/architecture/integrations/engines-mcp.md. [COMP:core/ask-engines]
 */

import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

/** Per-call output-token cap — callers score answers, they never need unbounded prose. */
const MAX_ANSWER_TOKENS = 2048
/** Outbound HTTP timeout per engine call. */
export const UPSTREAM_TIMEOUT_MS = 45_000
/** Max questions per batch and samples per question — bounds one call's upstream fan-out. */
export const MAX_BATCH_QUESTIONS = 25
export const MAX_SAMPLES = 3
/** Concurrent upstream calls within one batch (politeness + latency balance). */
const BATCH_CONCURRENCY = 4

export type EnginesEnv = Partial<
  Record<
    | 'ENGINES_MCP_SECRET'
    | 'ENGINES_OPENAI_API_KEY'
    | 'ENGINES_OPENAI_MODEL'
    | 'ENGINES_GEMINI_API_KEY'
    | 'ENGINES_GEMINI_MODEL'
    | 'ENGINES_PERPLEXITY_API_KEY'
    | 'ENGINES_PERPLEXITY_MODEL'
    | 'ENGINES_ANTHROPIC_API_KEY'
    | 'ENGINES_ANTHROPIC_MODEL'
    | 'ENGINES_GSC_KEY_FILE'
    | 'ENGINES_GSC_KEY_JSON'
    | 'ENGINES_GSC_SITE'
    | 'ENGINES_DAILY_CALL_CAP',
    string
  >
>

/** Engine identity — also the key into `ENGINE_PROVIDER_COST_PER_1K`. */
export type EngineId = 'openai' | 'gemini' | 'perplexity' | 'claude'

export type Citation = { url: string; title?: string }
type OneAnswer = { answer: string; citations: Citation[] }

/**
 * A caller-input problem (missing/contradictory args), rendered to the caller
 * verbatim. Distinct from an upstream failure: nothing was spent, and the
 * remedy is to call again with different arguments.
 */
export class EngineInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineInputError'
  }
}

/**
 * The caller-supplied budget hook refused this call before it ran. Carries
 * the hook's own sentence (which names the limit), so a surface can render
 * it verbatim. Never raised on the in-process path — it passes no hook.
 */
export class EngineBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineBudgetError'
  }
}

/** Budget hook: return a message to stop taking upstream units, or null to proceed. */
export type TakeBudget = () => string | null

export type AskArgs = {
  question?: string
  questions?: string[]
  samples?: number
  checkFor?: string[]
  answerMaxChars?: number
  country?: string
}

export type AskMatch = { term: string; inAnswer: boolean; inCitations: boolean }
export type AskAnswer =
  | { answer: string; citations: Citation[]; matches?: AskMatch[] }
  | { error: string }

/** The uniform result body both surfaces return (JSON on MCP, `data` in-process). */
export type AskPayload = {
  engine: EngineId
  model: string
  samples: number
  results: Array<{ question: string; answers: AskAnswer[] }>
  note?: string
}

export type AskRun = {
  payload: AskPayload
  /**
   * Upstream units that actually returned an answer. This is the BILLABLE
   * count (§2.3 of docs/plans/engines-inprocess-metering.md): a unit skipped
   * by the budget hook never called upstream, and a unit that errored was
   * refused (quota / bad request) rather than served.
   */
  successfulUnits: number
  /** Every unit failed or was skipped — the caller marks the whole call an error. */
  allFailed: boolean
}

export type EngineAsker = {
  /** Tool name on both surfaces (`askOpenAI`, …). */
  name: string
  engine: EngineId
  model: string
  description: string
  run(args: AskArgs, takeBudget?: TakeBudget): Promise<AskRun>
}

/**
 * Shared input shape for every ask tool. The MCP surface registers this raw
 * shape; the base tools wrap it in `z.object(...)`. One definition, so the
 * two surfaces can never drift in argument names or descriptions.
 */
export const ASK_INPUT_SHAPE = {
  question: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe('A single question. Use `questions` for a panel — exactly one of the two.'),
  questions: z
    .array(z.string().min(1).max(2000))
    .min(1)
    .max(MAX_BATCH_QUESTIONS)
    .optional()
    .describe(
      `Panel of up to ${MAX_BATCH_QUESTIONS} questions asked in one call (one upstream request each). ` +
        'Each is sent verbatim with NO additional context by design.',
    ),
  samples: z
    .number()
    .int()
    .min(1)
    .max(MAX_SAMPLES)
    .optional()
    .describe(
      `Ask each question this many times (default 1, max ${MAX_SAMPLES}) to expose answer variance; ` +
        'majority-score the samples.',
    ),
  checkFor: z
    .array(z.string().min(1).max(200))
    .max(10)
    .optional()
    .describe(
      'Terms/domains to detect server-side (case-insensitive) in each FULL answer and its citation ' +
        'URLs — detection is computed before any truncation, so pair freely with `answerMaxChars`.',
    ),
  answerMaxChars: z
    .number()
    .int()
    .min(200)
    .max(20000)
    .optional()
    .describe('Truncate each returned answer to this many characters (citations and matches stay complete).'),
  country: z
    .string()
    .length(2)
    .optional()
    .describe(
      'Two-letter country code hinting the search locale (engines that support it; others ignore it). ' +
        'Use to observe answers for a market other than the server region.',
    ),
} as const

/** Shared input shape for `searchConsoleQuery` — same single-source rule. */
export const GSC_INPUT_SHAPE = {
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive start date, YYYY-MM-DD.'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive end date, YYYY-MM-DD.'),
  dimensions: z
    .array(z.enum(['query', 'page', 'country', 'device', 'date']))
    .max(3)
    .optional()
    .describe('Group results by these dimensions (default: ["query"]).'),
  rowLimit: z.number().int().min(1).max(500).optional().describe('Max rows (default 100).'),
  siteUrl: z
    .string()
    .max(200)
    .optional()
    .describe('Property to query (e.g. "sc-domain:example.com"). Defaults to the configured site.'),
} as const

export const GSC_TOOL_DESCRIPTION =
  'Query Google Search Console search analytics (impressions, clicks, CTR, position) for a ' +
  'verified property the configured service account can read. Read-only ground truth for how ' +
  'the site performs in Google search.'

/** Bounded-concurrency map that preserves input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  const raw = await res.text()
  if (!res.ok) {
    // Upstream error text stays server-side; the result carries a coded
    // sentence (vendor wordings are not our interface).
    console.error(`[engines] upstream ${url} → ${res.status}: ${raw.slice(0, 500)}`)
    throw new Error(`upstream_error status=${res.status}`)
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('upstream_error status=unparseable')
  }
}

type CallOpts = { country?: string }
type AskerSpec = {
  name: string
  engine: EngineId
  model: string
  description: string
  callOnce: (question: string, opts: CallOpts) => Promise<OneAnswer>
}

/**
 * The batch/sampling/detection/truncation machinery every engine shares.
 * Budget is taken per unit BEFORE its call, and a mid-batch stop yields
 * partial results with an explicit note — never a silent gap.
 */
function makeAsker(spec: AskerSpec): EngineAsker {
  return {
    name: spec.name,
    engine: spec.engine,
    model: spec.model,
    description: spec.description,
    async run(args, takeBudget) {
      const single = typeof args.question === 'string' ? args.question.trim() : ''
      const panel = Array.isArray(args.questions)
        ? args.questions.map((q) => String(q).trim()).filter(Boolean)
        : []
      const questions = panel.length > 0 ? panel : single ? [single] : []
      if (questions.length === 0) throw new EngineInputError('Pass `question` or `questions`.')
      if (questions.length > MAX_BATCH_QUESTIONS) {
        throw new EngineInputError(`At most ${MAX_BATCH_QUESTIONS} questions per call.`)
      }
      const samples = Math.min(Math.max(Number(args.samples) || 1, 1), MAX_SAMPLES)
      const checkFor = Array.isArray(args.checkFor) ? args.checkFor.map(String) : []
      const maxChars = Number(args.answerMaxChars) || 0
      const opts: CallOpts = {
        country: typeof args.country === 'string' ? args.country.toUpperCase() : undefined,
      }

      let ceilingNote: string | null = null
      const units = questions.flatMap((q, qi) =>
        Array.from({ length: samples }, (_, si) => ({ q, qi, si })),
      )
      const unitResults = await mapPool(units, BATCH_CONCURRENCY, async (unit) => {
        if (ceilingNote) return { ...unit, error: 'skipped: daily ceiling reached' }
        const capMsg = takeBudget?.() ?? null
        if (capMsg) {
          ceilingNote = capMsg
          return { ...unit, error: 'skipped: daily ceiling reached' }
        }
        try {
          const one = await spec.callOnce(unit.q, opts)
          return { ...unit, one }
        } catch (err) {
          return { ...unit, error: err instanceof Error ? err.message : 'unknown_error' }
        }
      })

      let successfulUnits = 0
      const results = questions.map((q, qi) => {
        const answers = unitResults
          .filter((u) => u.qi === qi)
          .sort((a, b) => a.si - b.si)
          .map((u): AskAnswer => {
            if ('error' in u && u.error) return { error: u.error }
            const one = (u as { one: OneAnswer }).one
            successfulUnits += 1
            const matches =
              checkFor.length > 0
                ? checkFor.map((term) => {
                    const needle = term.toLowerCase()
                    return {
                      term,
                      inAnswer: one.answer.toLowerCase().includes(needle),
                      inCitations: one.citations.some((c) =>
                        `${c.url} ${c.title ?? ''}`.toLowerCase().includes(needle),
                      ),
                    }
                  })
                : undefined
            const answer =
              maxChars > 0 && one.answer.length > maxChars
                ? `${one.answer.slice(0, maxChars)}…[truncated]`
                : one.answer
            return { answer, citations: one.citations, ...(matches ? { matches } : {}) }
          })
        return { question: q, answers }
      })

      return {
        payload: {
          engine: spec.engine,
          model: spec.model,
          samples,
          results,
          ...(ceilingNote ? { note: ceilingNote } : {}),
        },
        successfulUnits,
        // A fully-empty run (every unit errored) is an error; partials are not.
        allFailed: results.every((r) => r.answers.every((a) => 'error' in a)),
      }
    },
  }
}

/**
 * Build the engine askers available under the given env. Only engines whose
 * credential is present are returned — absent env, absent tool, nothing to
 * govern. `fetchImpl` is injectable for tests.
 */
export function createEngineAskers(
  env: EnginesEnv,
  fetchImpl: typeof fetch = fetch,
): EngineAsker[] {
  const askers: EngineAsker[] = []

  // ── askOpenAI — Responses API + web_search (the ChatGPT proxy) ─────────
  if (env.ENGINES_OPENAI_API_KEY) {
    const model = env.ENGINES_OPENAI_MODEL || 'gpt-4o'
    askers.push(
      makeAsker({
        name: 'askOpenAI',
        engine: 'openai',
        model,
        description:
          'Ask OpenAI (web-search-grounded, the closest API proxy to ChatGPT with browsing) bare ' +
          'questions and get ITS answers with citations, as data to inspect. Supports a questions ' +
          'panel, repeat sampling, server-side term detection (checkFor), and a country locale hint. ' +
          'Read-only observation of an external engine — the answers are not this assistant speaking. ' +
          'An answer WITHOUT citations means the engine answered from its training data (parametric).',
        callOnce: async (question, opts) => {
          const data = (await postJson(
            fetchImpl,
            'https://api.openai.com/v1/responses',
            { Authorization: `Bearer ${env.ENGINES_OPENAI_API_KEY}` },
            {
              model,
              input: question,
              tools: [
                {
                  type: 'web_search',
                  ...(opts.country
                    ? { user_location: { type: 'approximate', country: opts.country } }
                    : {}),
                },
              ],
              max_output_tokens: MAX_ANSWER_TOKENS,
            },
          )) as {
            output?: Array<{
              content?: Array<{
                text?: string
                annotations?: Array<{ type?: string; url?: string; title?: string }>
              }>
            }>
          }
          let answer = ''
          const citations: Citation[] = []
          for (const item of data.output ?? []) {
            for (const part of item.content ?? []) {
              if (typeof part.text === 'string') answer += part.text
              for (const a of part.annotations ?? []) {
                if (a.type === 'url_citation' && a.url) citations.push({ url: a.url, title: a.title })
              }
            }
          }
          if (!answer) throw new Error('empty_answer')
          return { answer, citations }
        },
      }),
    )
  }

  // ── askGemini — grounded generateContent ───────────────────────────────
  if (env.ENGINES_GEMINI_API_KEY) {
    const model = env.ENGINES_GEMINI_MODEL || 'gemini-2.5-flash'
    askers.push(
      makeAsker({
        name: 'askGemini',
        engine: 'gemini',
        model,
        description:
          'Ask Google Gemini (search-grounded) bare questions and get ITS answers with citations, as ' +
          'data to inspect. Supports a questions panel, repeat sampling, and server-side term ' +
          'detection (checkFor). Read-only observation of an external engine — distinct from any ' +
          'model powering this assistant. An answer WITHOUT citations is parametric (no search used).',
        callOnce: async (question) => {
          const data = (await postJson(
            fetchImpl,
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            { 'x-goog-api-key': env.ENGINES_GEMINI_API_KEY! },
            {
              contents: [{ parts: [{ text: question }] }],
              tools: [{ google_search: {} }],
              generationConfig: { maxOutputTokens: MAX_ANSWER_TOKENS },
            },
          )) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> }
              groundingMetadata?: {
                groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
              }
            }>
          }
          const candidate = data.candidates?.[0]
          const answer = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('')
          const citations: Citation[] = []
          for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
            if (chunk.web?.uri) citations.push({ url: chunk.web.uri, title: chunk.web.title })
          }
          if (!answer) throw new Error('empty_answer')
          return { answer, citations }
        },
      }),
    )
  }

  // ── askPerplexity — Sonar chat completions ─────────────────────────────
  if (env.ENGINES_PERPLEXITY_API_KEY) {
    const model = env.ENGINES_PERPLEXITY_MODEL || 'sonar'
    askers.push(
      makeAsker({
        name: 'askPerplexity',
        engine: 'perplexity',
        model,
        description:
          'Ask Perplexity (Sonar — the consumer-Perplexity proxy) bare questions and get ITS answers ' +
          'with citations, as data to inspect. Supports a questions panel, repeat sampling, and ' +
          'server-side term detection (checkFor). Retrieval-first: every answer is search-grounded. ' +
          'Read-only observation of an external engine.',
        callOnce: async (question) => {
          const data = (await postJson(
            fetchImpl,
            'https://api.perplexity.ai/chat/completions',
            { Authorization: `Bearer ${env.ENGINES_PERPLEXITY_API_KEY}` },
            {
              model,
              messages: [{ role: 'user', content: question }],
              max_tokens: MAX_ANSWER_TOKENS,
            },
          )) as {
            choices?: Array<{ message?: { content?: string } }>
            citations?: string[]
            search_results?: Array<{ url?: string; title?: string }>
          }
          const answer = data.choices?.[0]?.message?.content ?? ''
          const citations: Citation[] = []
          for (const r of data.search_results ?? []) {
            if (r.url) citations.push({ url: r.url, title: r.title })
          }
          if (citations.length === 0) {
            for (const url of data.citations ?? []) citations.push({ url })
          }
          if (!answer) throw new Error('empty_answer')
          return { answer, citations }
        },
      }),
    )
  }

  // ── askClaude — Messages API + web_search ──────────────────────────────
  if (env.ENGINES_ANTHROPIC_API_KEY) {
    const model = env.ENGINES_ANTHROPIC_MODEL || 'claude-sonnet-5'
    askers.push(
      makeAsker({
        name: 'askClaude',
        engine: 'claude',
        model,
        description:
          'Ask Anthropic Claude (web-search-grounded) bare questions and get ITS answers with ' +
          'citations, as data to inspect. Supports a questions panel, repeat sampling, and ' +
          'server-side term detection (checkFor). Read-only observation of an external engine. ' +
          'An answer WITHOUT citations is parametric (no search used).',
        callOnce: async (question) => {
          const data = (await postJson(
            fetchImpl,
            'https://api.anthropic.com/v1/messages',
            {
              'x-api-key': env.ENGINES_ANTHROPIC_API_KEY!,
              'anthropic-version': '2023-06-01',
            },
            {
              model,
              max_tokens: MAX_ANSWER_TOKENS,
              messages: [{ role: 'user', content: question }],
              tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
            },
          )) as {
            content?: Array<{
              type?: string
              text?: string
              citations?: Array<{ url?: string; title?: string }>
            }>
          }
          let answer = ''
          const citations: Citation[] = []
          for (const block of data.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string') {
              answer += block.text
              for (const c of block.citations ?? []) {
                if (c.url) citations.push({ url: c.url, title: c.title })
              }
            }
          }
          if (!answer) throw new Error('empty_answer')
          return { answer, citations }
        },
      }),
    )
  }

  return askers
}

// ── searchConsoleQuery — GSC Search Analytics via service-account JWT ────
// The JWT lives HERE and nowhere else: both surfaces call this querier, so
// there is one signer, one token cache, one scope.

export type GscQueryArgs = {
  startDate: string
  endDate: string
  dimensions?: string[]
  rowLimit?: number
  siteUrl?: string
}

export type GscQuerier = {
  name: 'searchConsoleQuery'
  description: string
  /**
   * Run one Search Analytics query. Throws `EngineInputError` when no
   * property was given or configured, `EngineBudgetError` when the optional
   * hook refuses (neither spends anything — the property is resolved BEFORE
   * budget is taken), and a coded `Error` on any upstream failure.
   */
  query(args: GscQueryArgs, takeBudget?: TakeBudget): Promise<unknown>
}

/** Build the GSC querier, or null when no service-account credential is set. */
export function createGscQuerier(
  env: EnginesEnv,
  fetchImpl: typeof fetch = fetch,
): GscQuerier | null {
  if (!env.ENGINES_GSC_KEY_FILE && !env.ENGINES_GSC_KEY_JSON) return null

  // Lazy-loaded + cached: the JSON key is read on first use (a bad path
  // surfaces as a tool error, never a boot failure), and the OAuth token is
  // reused until shortly before expiry.
  let cachedKey: { client_email: string; private_key: string; token_uri?: string } | null = null
  let cachedToken: { token: string; expiresAt: number } | null = null

  function loadKey(): { client_email: string; private_key: string; token_uri?: string } {
    if (cachedKey) return cachedKey
    let raw: string
    if (env.ENGINES_GSC_KEY_JSON) {
      raw = env.ENGINES_GSC_KEY_JSON.trim().startsWith('{')
        ? env.ENGINES_GSC_KEY_JSON
        : Buffer.from(env.ENGINES_GSC_KEY_JSON, 'base64').toString('utf8')
    } else {
      raw = readFileSync(env.ENGINES_GSC_KEY_FILE!, 'utf8')
    }
    const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string; token_uri?: string }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('service-account JSON missing client_email/private_key')
    }
    cachedKey = {
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      token_uri: parsed.token_uri,
    }
    return cachedKey
  }

  async function accessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token
    const key = loadKey()
    const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token'
    const now = Math.floor(Date.now() / 1000)
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })}`
    const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')
    const res = await fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`upstream_error status=${res.status}`)
    const data = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!data.access_token) throw new Error('upstream_error status=no_token')
    cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 }
    return cachedToken.token
  }

  return {
    name: 'searchConsoleQuery',
    description: GSC_TOOL_DESCRIPTION,
    async query(args, takeBudget) {
      const siteUrl = String(args.siteUrl ?? env.ENGINES_GSC_SITE ?? '').trim()
      if (!siteUrl) {
        throw new EngineInputError('No `siteUrl` given and no default site is configured.')
      }
      const capMsg = takeBudget?.() ?? null
      if (capMsg) throw new EngineBudgetError(capMsg)
      const token = await accessToken()
      return postJson(
        fetchImpl,
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        { Authorization: `Bearer ${token}` },
        {
          startDate: args.startDate,
          endDate: args.endDate,
          dimensions: args.dimensions ?? ['query'],
          rowLimit: args.rowLimit ?? 100,
        },
      )
    },
  }
}
