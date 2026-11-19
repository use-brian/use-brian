// [COMP:tooling/m6-qualification] Real HTTP transport plus durable spend
// reservation regressions. Upstream is explicitly injected: zero paid calls.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSpendLedger, LIVE_PRICE, startCappedLiveProvider } from '../testing/m6/live-provider.mjs'

const ledgerPath = () => join(mkdtempSync(join(tmpdir(), 'm6-spend-')), 'spend.json')

test('[COMP:tooling/m6-qualification] reservations survive lost usage and share the campaign limit', () => {
  const path = ledgerPath(), m6 = createSpendLedger(path, 'm6'), m7 = createSpendLedger(path, 'm7')
  const first = m6.reserve('fixture-model')
  m6.settle(first, undefined)
  const lost = m6.snapshot().requests[0]
  assert.equal(lost.status, 'uncertain')
  assert.ok(lost.chargedUpperUsd > 0.1)
  const second = m7.reserve('fixture-model')
  m7.settle(second, { prompt_tokens: 100, completion_tokens: 20 })
  assert.equal(m7.snapshot().requests[1].estimatedListCostUsd, 0.000018)
  for (let n = 2; n < 32; n++) m6.reserve('fixture-model')
  assert.throws(() => m7.reserve('fixture-model'), /ceiling/)
  assert.equal(m6.snapshot().requests.length, 32)
})

test('[COMP:tooling/m6-qualification] refuses invalid prior charges before any new reservation', () => {
  const path = ledgerPath(), ledger = createSpendLedger(path, 'm6')
  ledger.reserve('fixture-model')
  const invalid = JSON.parse(readFileSync(path, 'utf8')); invalid.requests[0].chargedUpperUsd = -1
  writeFileSync(path, JSON.stringify(invalid))
  assert.throws(() => ledger.reserve('fixture-model'), /invalid prior/)
})

test('[COMP:tooling/m6-qualification] clamps actual HTTP requests and accounts split streamed usage', async () => {
  const upstream = []
  const provider = await startCappedLiveProvider({ apiKey: 'fictional-test-key', ledgerPath: ledgerPath(), phase: 'm6',
    fetchUpstream: async (url, init) => {
      const body = JSON.parse(init.body); upstream.push({ url, body })
      const chunks = ['data: {"choices":[{"delta":{"content":"fixture"}}]}\r', '\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":101,"completion_tokens":7}}\r\n\r\ndata: [DONE]\r\n\r\n']
      return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close() } }), { headers: { 'content-type': 'text/event-stream' } })
    } })
  try {
    const response = await fetch(`${provider.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'expensive-model', stream: true, messages: [{ role: 'user', content: 'fictional fixture' }], tools: [{}], max_tokens: 999999, enable_thinking: true }) })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /fixture/)
    assert.equal(upstream.length, 1)
    assert.equal(upstream[0].url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions')
    assert.equal(upstream[0].body.model, LIVE_PRICE.model)
    assert.equal(upstream[0].body.max_tokens, 1024)
    assert.equal(upstream[0].body.enable_thinking, false)
    assert.equal(upstream[0].body.tools, undefined)
    assert.equal(provider.live, false)
    assert.equal(provider.ledger.snapshot().requests[0].status, 'measured')
    assert.deepEqual(provider.ledger.snapshot().requests[0].usage, { inputTokens: 101, outputTokens: 7 })
  } finally { await provider.close() }
})

test('[COMP:tooling/m6-qualification] keeps the reservation on an upstream failure without retry', async () => {
  let calls = 0
  const provider = await startCappedLiveProvider({ apiKey: 'fictional-test-key', ledgerPath: ledgerPath(), phase: 'm7', fetchUpstream: async () => { calls++; throw new Error('fixture lost connection') } })
  try {
    const response = await fetch(`${provider.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'fixture' }] }) })
    assert.equal(response.status, 503); await response.text()
    assert.equal(calls, 1)
    assert.equal(provider.ledger.snapshot().requests[0].status, 'uncertain')
    assert.ok(provider.ledger.snapshot().requests[0].chargedUpperUsd > 0.1)
  } finally { await provider.close() }
})
