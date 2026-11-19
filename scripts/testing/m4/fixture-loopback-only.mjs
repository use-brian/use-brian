/** [COMP:invariants/chat-import-graph] Restrict the deterministic API child to local fixture services. */
import { Socket } from 'node:net'

const geminiFixturePort = Number(process.env.BRIAN_FIXTURE_GEMINI_PORT)
if (Number.isInteger(geminiFixturePort) && geminiFixturePort > 0 && geminiFixturePort <= 65535) {
  const fetchOnLoopback = globalThis.fetch
  globalThis.fetch = (input, options) => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(input) : null
    if (url?.origin !== 'https://generativelanguage.googleapis.com' || !url.pathname.startsWith('/v1beta/models/')) {
      return fetchOnLoopback(input, options)
    }
    return fetchOnLoopback(`http://127.0.0.1:${geminiFixturePort}/gemini${url.pathname}`, {
      ...options, headers: { 'content-type': 'application/json' },
    })
  }
}

const connect = Socket.prototype.connect
Socket.prototype.connect = function (...args) {
  // Node's stream internals can supply a pre-normalized [options, callback].
  const form = Array.isArray(args[0]) ? args[0] : args
  const first = form[0]
  const host = first && typeof first === 'object' ? first.host ?? first.hostname
    : typeof form[1] === 'string' ? form[1] : undefined
  if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw Object.assign(new Error('External connection refused by the deterministic fixture'), { code: 'M4_EXTERNAL_CONNECTION_REFUSED' })
  }
  return Reflect.apply(connect, this, args)
}
