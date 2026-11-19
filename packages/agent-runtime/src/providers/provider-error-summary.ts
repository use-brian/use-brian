/** Content-free diagnostics only; never use these heuristics to decide retries. */
export type ProviderErrorCategory = 'invalid_argument' | 'signature_error' | 'tool_pairing_error' | 'rate_limit' | 'auth' | 'upstream_failure' | 'network' | 'aborted' | 'idle_timeout' | 'incomplete_stream' | 'unknown'
export type ProviderErrorSummary = { category: ProviderErrorCategory; httpStatus: number | null }
const MAX_MESSAGE = 16_384
// Avoid getters, toString/toJSON, and unbounded cause traversal on arbitrary thrown values.
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  try { return Object.getOwnPropertyDescriptor(value, key)?.value } catch { return undefined }
}
function status(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
}

export function summarizeProviderError(error: unknown): ProviderErrorSummary {
  let httpStatus = status(field(error, 'status')) ?? status(field(error, 'statusCode'))
  const raw = field(error, 'message')
  const message = typeof raw === 'string' ? raw.slice(0, MAX_MESSAGE) : ''
  // Only this adapter's anchored envelope, not arbitrary numbers in payload text.
  const envelope = /^Gemini API error ([1-5]\d{2}): /.exec(message)
  let providerMessage = ''
  let providerStatus: unknown
  if (envelope) {
    httpStatus = Number(envelope[1])
    if (typeof raw === 'string' && raw.length <= MAX_MESSAGE) {
      try {
        const body: unknown = JSON.parse(raw.slice(envelope[0].length))
        const detail = field(body, 'error')
        providerStatus = field(detail, 'status')
        const text = field(detail, 'message')
        if (typeof text === 'string') providerMessage = text
      } catch { /* Malformed/oversized body: status only, no guessed details. */ }
    }
  }
  let category: ProviderErrorCategory = 'unknown'
  if (httpStatus === 401 || httpStatus === 403) category = 'auth'
  else if (httpStatus === 429) category = 'rate_limit'
  else if (httpStatus !== null && httpStatus >= 500) category = 'upstream_failure'
  else if (httpStatus === 400) {
    // Require recognizable validation language, not just mention of a field.
    if (/(?:thought[_ ]?signature|thought signature).{0,100}(?:missing|invalid|required)|(?:missing|invalid|required).{0,100}(?:thought[_ ]?signature|thought signature)/i.test(providerMessage)) category = 'signature_error'
    else if (/number of function response parts (?:should|must) be equal to (?:the )?number of function call parts|function response turn comes immediately after a function call turn/i.test(providerMessage)) category = 'tool_pairing_error'
    else if (providerStatus === 'INVALID_ARGUMENT') category = 'invalid_argument'
  }
  if (category !== 'unknown' || httpStatus !== null) return { category, httpStatus }
  if (/^Stream idle for \d+ms\b/.test(message) || (field(error, 'code') === 'stalled' && /^stalled: no progress for \d+s /.test(message))) category = 'idle_timeout'
  else if (field(error, 'name') === 'AbortError') category = 'aborted'
  else if (message === 'No response body from Gemini API') category = 'incomplete_stream'
  else {
    let current = error
    for (let depth = 0; depth < 5 && current; depth++) {
      const code = field(current, 'code')
      if (typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) { category = 'network'; break }
      current = field(current, 'cause')
    }
    if (category === 'unknown' && /^(?:fetch failed|socket hang up|network error|network request failed)$/i.test(message)) category = 'network'
  }
  return { category, httpStatus }
}
