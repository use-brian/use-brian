/**
 * [COMP:tooling/m6-qualification] Capped live-provider transport for disposable
 * M6/M7 chat acceptance. Stores token/cost metadata, never prompts or secrets.
 * No retry. An uncertain request keeps its entire reservation charged.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const LIVE_PRICE = Object.freeze({ model: 'qwen3.5-flash', inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4,
  maxInputTokens: 1_000_000, requestMaxOutputTokens: 1024, maxOutputTokens: 65_536, maxThinkingTokens: 81_920,
  source: 'https://www.alibabacloud.com/help/en/model-studio/qwen3-5-flash', checkedAt: '2026-11-18', scope: 'Singapore, International' })
const ALLOCATION = Object.freeze({ m6: 10, m7: 15 })
// Reserve even the documented full visible-output and thinking ceilings despite
// requesting only 1024 tokens with thinking explicitly disabled. This covers
// output-limit rounding and unexpected reported reasoning without overspend.
const RESERVATION = (LIVE_PRICE.maxInputTokens * LIVE_PRICE.inputPerMillionUsd + (LIVE_PRICE.maxOutputTokens + LIVE_PRICE.maxThinkingTokens) * LIVE_PRICE.outputPerMillionUsd) / 1_000_000

export function createSpendLedger(path, phase) {
  if (!(phase in ALLOCATION)) throw new Error('live provider phase must be m6 or m7')
  mkdirSync(dirname(path), { recursive: true })
  const mutate = action => {
    const lock = `${path}.lock`, fd = openSync(lock, 'wx', 0o600)
    try {
      const ledger = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schema: 1, totalCapUsd: 25, phaseCapsUsd: ALLOCATION, requests: [] }
      if (ledger.schema !== 1 || ledger.totalCapUsd !== 25 || JSON.stringify(ledger.phaseCapsUsd) !== JSON.stringify(ALLOCATION) || !Array.isArray(ledger.requests)) throw new Error('unrecognized live-spend ledger; refusing paid request')
      const result = action(ledger), temp = `${path}.tmp-${randomUUID()}`
      writeFileSync(temp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, path)
      return result
    } finally { closeSync(fd); unlinkSync(lock) }
  }
  const charge = request => request.chargedUpperUsd
  return {
    reserve(requestedModel) {
      return mutate(ledger => {
        if (ledger.requests.length >= 32) throw new Error('live-provider campaign request ceiling reached (32 total)')
        if (ledger.requests.some(request => !Number.isFinite(charge(request)) || charge(request) < 0 || charge(request) > RESERVATION || !(request.phase in ALLOCATION))) throw new Error('invalid prior live-provider charge')
        const total = ledger.requests.reduce((sum, request) => sum + charge(request), 0)
        const own = ledger.requests.filter(request => request.phase === phase).reduce((sum, request) => sum + charge(request), 0)
        if (!Number.isFinite(total) || !Number.isFinite(own) || total + RESERVATION > ledger.totalCapUsd || own + RESERVATION > ALLOCATION[phase]) throw new Error('live-provider budget exhausted or ledger charge invalid')
        const id = randomUUID()
        ledger.requests.push({ id, phase, requestedModel, model: LIVE_PRICE.model, reservedAt: new Date().toISOString(),
          status: 'reserved', chargedUpperUsd: RESERVATION, price: LIVE_PRICE })
        return id
      })
    },
    settle(id, usage) {
      return mutate(ledger => {
        const request = ledger.requests.find(request => request.id === id)
        if (!request || request.status !== 'reserved') throw new Error('unknown or already settled live-provider reservation')
        const measured = usage && Number.isInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 && usage.prompt_tokens <= LIVE_PRICE.maxInputTokens &&
          Number.isInteger(usage.completion_tokens) && usage.completion_tokens >= 0 && usage.completion_tokens <= LIVE_PRICE.maxOutputTokens + LIVE_PRICE.maxThinkingTokens
        if (!measured) { request.status = 'uncertain'; request.reason = 'provider usage missing or outside the reserved model limits'; return }
        request.status = 'measured'; request.usage = { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
        request.estimatedListCostUsd = (usage.prompt_tokens * LIVE_PRICE.inputPerMillionUsd + usage.completion_tokens * LIVE_PRICE.outputPerMillionUsd) / 1_000_000
        request.chargedUpperUsd = request.estimatedListCostUsd
        request.settledAt = new Date().toISOString()
      })
    },
    snapshot() { return mutate(ledger => structuredClone(ledger)) },
  }
}

export async function startCappedLiveProvider({ apiKey, ledgerPath, phase, fetchUpstream = fetch }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('DASHSCOPE_API_KEY is required for an explicitly authorized live run')
  const ledger = createSpendLedger(ledgerPath, phase), requests = []
  const server = createServer(async (req, res) => {
    let reservation, usage
    try {
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) { res.writeHead(404); res.end(); return }
      let raw = ''
      for await (const part of req) { raw += part; if (Buffer.byteLength(raw) > 1_000_000) throw new Error('live request exceeds the fixture body ceiling') }
      const body = JSON.parse(raw)
      if (!Array.isArray(body.messages) || body.messages.some(message => typeof message.content !== 'string' && message.content !== null &&
        !(Array.isArray(message.content) && message.content.every(part => part.type === 'text' && typeof part.text === 'string')))) throw new Error('live qualification accepts text-only messages')
      reservation = ledger.reserve(body.model)
      const forwarded = { ...body, model: LIVE_PRICE.model, enable_thinking: false, enable_search: false, n: 1,
        max_tokens: LIVE_PRICE.requestMaxOutputTokens, max_completion_tokens: undefined, thinking_budget: undefined,
        tools: undefined, tool_choice: undefined, ...(body.stream ? { stream_options: { include_usage: true } } : {}) }
      const upstream = await fetchUpstream('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(forwarded), signal: AbortSignal.timeout(120_000),
      })
      requests.push({ reservation, requestedModel: body.model, model: forwarded.model, stream: body.stream === true, httpStatus: upstream.status })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      if (!body.stream) {
        const result = await upstream.json(); usage = result.usage
        res.end(JSON.stringify(result))
      } else {
        let pending = '', decoder = new TextDecoder()
        for await (const part of upstream.body) {
          res.write(part); pending += decoder.decode(part, { stream: true }); pending = pending.replaceAll('\r\n', '\n')
          let separator
          while ((separator = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, separator); pending = pending.slice(separator + 2)
            for (const line of frame.split('\n')) if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              const value = JSON.parse(line.slice(6)); if (value.usage) usage = value.usage
            }
          }
        }
        res.end()
      }
    } catch {
      if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Live qualification refused or failed; inspect the bounded spend ledger.' } }))
    } finally {
      if (reservation) {
        try { ledger.settle(reservation, usage) }
        catch { requests.push({ reservation, settlement: 'failed; entire reservation remains charged' }) }
      }
    }
  })
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  return { baseURL: `http://127.0.0.1:${server.address().port}/compatible-mode/v1`, live: fetchUpstream === fetch,
    kind: fetchUpstream === fetch ? 'capped live DashScope International text-only, fixed qwen3.5-flash, no tools/retries' : 'injected transport test, not live evidence',
    requests, ledger, close: () => new Promise(accept => server.close(accept)) }
}
