import { registryRow } from '@use-brian/shared/model-registry'
import type { HttpRetryWindow } from './types.js'

/** HTTP-only retries: never replay a successful response or any streamed tools. */
const BUDGET_MS = 60_000
const MAX_RETRIES = 3
const MAX_ERROR_BYTES = 32_768
const rateLimitError = () => new Error('Gemini API error 429: rate limit retry exhausted or unavailable')

function aborted(signal?: AbortSignal): void { signal?.throwIfAborted() }

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  aborted(signal)
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

/** Bound both the bytes and time spent inspecting a rejected response. */
async function errorBody(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = '', bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: () => void = () => {}
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason ?? new Error('Rejected body read canceled'))
    signal.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => reject(new Error('Rejected body read timeout')), 1_000)
  })
  try {
    aborted(signal)
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stopped])
      if (done) return text + decoder.decode()
      bytes += value.byteLength
      if (bytes > MAX_ERROR_BYTES) return ''
      text += decoder.decode(value, { stream: true })
    }
  } catch { return '' } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    // Cancellation is best effort: hostile/failed streams must not hold up retries.
    void reader.cancel().catch(() => {})
  }
}

type Quota = 'capacity' | 'requests' | 'tokens' | 'daily' | 'billing' | 'unknown'
function hints(response: Response, text: string) {
  const delays: number[] = []
  const header = response.headers.get('retry-after')?.trim()
  if (header && header.length < 128) {
    const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN
    const date = /^[A-Za-z]{3},/.test(header) ? Date.parse(header) : NaN
    const ms = Number.isFinite(seconds) ? seconds * 1000 : date - Date.now()
    if (Number.isFinite(ms) && ms >= 0) delays.push(ms)
    else if (Number.isFinite(date)) delays.push(0)
  }
  const headerHint = delays.length > 0
  let rpcHint = false
  let quota: Quota = 'unknown'
  let hard = false
  try {
    const error = JSON.parse(text)?.error
    const message = typeof error?.message === 'string' ? error.message : ''
    const classify = (text: string) => {
      if (/billing|insufficient_quota/i.test(text)) quota = 'billing'
      else if (/daily|perday|per_day/i.test(text) && quota !== 'billing') quota = 'daily'
      else if (quota !== 'daily' && quota !== 'billing') {
        if (/token/i.test(text)) quota = 'tokens'
        else if (/request/i.test(text)) quota = 'requests'
        else if (/capacity|overload/i.test(text)) quota = 'capacity'
      }
    }
    classify(message)
    // RESOURCE_EXHAUSTED and generic quota wording alone are NOT definitive.
    hard = /(?:insufficient_quota|billing (?:is )?disabled|daily quota (?:exceeded|exhausted)|quota[^\n]{0,200}limit:\s*0\b)/i.test(message)
    if (Array.isArray(error?.details)) for (const detail of error.details.slice(0, 100)) {
      if (detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
          ['BILLING_DISABLED', 'DAILY_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED_PER_DAY'].includes(detail.reason)) { hard = true; classify(detail.reason) }
      if (detail?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' && Array.isArray(detail.violations)) {
        for (const violation of detail.violations.slice(0, 100)) {
          const id = typeof violation?.quotaId === 'string' ? violation.quotaId : ''
          const metric = typeof violation?.quotaMetric === 'string' ? violation.quotaMetric : ''
          classify(id + ' ' + metric)
          if (/perday|per_day/i.test(id + ' ' + metric) || violation?.quotaValue === '0' || violation?.quotaValue === 0) hard = true
        }
      }
      if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') continue
      const delay = detail.retryDelay
      if (typeof delay !== 'string' || delay.length > 32 || !/^\d+(?:\.\d{1,9})?s$/.test(delay)) continue
      const ms = Number(delay.slice(0, -1)) * 1000
      if (Number.isFinite(ms)) { delays.push(ms); rpcHint = true }
    }
  } catch { /* Malformed errors carry no authoritative hints. */ }
  return { delay: delays.length ? Math.max(...delays) : undefined, hard, quota,
    source: headerHint && rpcHint ? 'both' : headerHint ? 'retry_after' : rpcHint ? 'retry_info' : 'fallback' }
}

/** One scope per SSE request, shared by the existing schema fallback. */
export function createGeminiHttpRetry(signal?: AbortSignal, options: {
  transport?: 'ai-studio' | 'vertex'; model?: string; window?: HttpRetryWindow
} = {}) {
  // Do not shorten the normal provider prefill window before any 429 occurs.
  let deadline: number | undefined
  let retries = 0
  let hint: ReturnType<typeof hints> | undefined
  const remainingMs = () => Math.max(0, Math.min(deadline ?? Infinity, options.window?.deadline ?? Infinity) - Date.now())
  const diagnostic = (terminalReason: string, delayMs = 0) => {
    if (process.env.BRIAN_DEBUG_GEMINI_HTTP_RETRY !== '1') return
    console.info('[gemini-http-retry]', JSON.stringify({
      category: 'rate_limit_retry', transport: options.transport === 'vertex' ? 'vertex' : options.transport === 'ai-studio' ? 'ai-studio' : 'unknown',
      model: options.model && registryRow(options.model) ? options.model : 'other',
      quota: hint?.quota ?? 'unknown', hintSource: hint?.source ?? 'fallback',
      terminalReason, attempt: retries, delayMs, remainingMs: Number.isFinite(remainingMs()) ? remainingMs() : 0,
    }))
  }
  const fail = (reason: string): never => { diagnostic(reason); throw rateLimitError() }
  return async (send: (signal: AbortSignal) => Promise<Response>): Promise<Response> => {
    while (true) {
      aborted(signal)
      const remaining = deadline === undefined ? undefined : remainingMs()
      if (remaining !== undefined && remaining <= 0) fail('deadline')
      const controller = new AbortController()
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      let timer = remaining === undefined ? undefined
        : setTimeout(() => controller.abort(rateLimitError()), remaining)
      let response: Response
      try {
        response = await send(requestSignal)
        if (response.status !== 429) { if (deadline !== undefined) diagnostic('admitted'); return response }
        if (options.window) options.window.rateLimited = true
        if (deadline === undefined) {
          deadline = Date.now() + BUDGET_MS
          timer = setTimeout(() => controller.abort(rateLimitError()), BUDGET_MS)
        }
        hint = hints(response, await errorBody(response, requestSignal))
        aborted(signal)
      } catch (error) {
        if (deadline !== undefined) diagnostic(remainingMs() <= 0 || controller.signal.aborted ? 'deadline' : signal?.aborted ? 'canceled' : 'request_failed')
        throw error
      } finally { clearTimeout(timer) }
      if (hint!.hard) fail('hard_quota')
      if (retries >= MAX_RETRIES) fail('retry_limit')
      const delay = hint!.delay ?? (5000 * 2 ** retries + Math.round(Math.random() * 2000))
      if (delay >= remainingMs()) fail('delay_exceeds_deadline')
      retries++
      diagnostic('scheduled', delay)
      try { await sleep(delay, signal) } catch (error) { diagnostic('canceled'); throw error }
      // Recheck cancellation and budget immediately before the next fetch.
    }
  }
}
