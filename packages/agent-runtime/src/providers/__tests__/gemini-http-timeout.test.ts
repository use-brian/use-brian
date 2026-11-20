import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { createGeminiProvider } from '../gemini.js'

describe('[COMP:providers/gemini] model-specific HTTP timeouts', () => {
  const previousDispatcher = getGlobalDispatcher()
  const shortDispatcher = new Agent({ headersTimeout: 40, bodyTimeout: 40 })
  const event = `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'Ready.' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  })}\n\n`
  const server = createServer((req, res) => {
    req.resume()
    if (req.url === '/body') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders()
    }
    setTimeout(() => {
      if (!res.destroyed) {
        if (!res.headersSent) res.setHeader('Content-Type', 'text/event-stream')
        res.end(event)
      }
    }, 1500)
  })
  let origin: string

  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    setGlobalDispatcher(shortDispatcher)
  })
  afterAll(async () => {
    setGlobalDispatcher(previousDispatcher)
    server.closeAllConnections()
    await Promise.all([
      shortDispatcher.destroy(),
      new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    ])
  })

  it.each(['headers', 'body'])('lets Argon wait beyond the global %s deadline', async phase => {
    const endpoint = `${origin}/${phase}`
    await expect(fetch(endpoint).then(response => response.text())).rejects.toThrow()
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => endpoint, headers: async () => ({}) })
    let text = ''
    for await (const chunk of provider.stream({
      model: 'gemini-4-argon-research', systemPrompt: 'Reply briefly.',
      messages: [{ role: 'user', content: 'Hello' }], signal: AbortSignal.timeout(3000),
    })) if (chunk.type === 'text_delta') text += chunk.text
    expect(text).toBe('Ready.')
  })

  it('still honors caller cancellation during Argon prefill', async () => {
    const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => `${origin}/headers`, headers: async () => ({}) })
    const drain = async () => {
      for await (const _ of provider.stream({
        model: 'gemini-4-argon-research', systemPrompt: 'Reply briefly.',
        messages: [{ role: 'user', content: 'Hello' }], signal: AbortSignal.timeout(20),
      })) { /* drain */ }
    }
    await expect(drain()).rejects.toThrow()
  })
})
