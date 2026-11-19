#!/usr/bin/env node
// M5 browser qualification: scripted OpenAI-compatible provider.
//
// Test fixture only. The API reaches it through DASHSCOPE_BASE_URL (boot.ts
// honours the override), so no network model is called and turns are
// reproducible. Directives in the latest user message select the script:
//
//   slow:N     stream N words, SLOW_MS apart (main loop requests only)
//   ask:       call askQuestion with two options, then answer after the resume
//   approve:   call the first offered confirmation tool, then reply after it
//   work:      call a read-only tool (listTasks or getTime) first, then reply (slow:N applies)
//   (none)     a short fixed reply that echoes the first words of the message
//
// Only requests that carry `tools` (the main query loop) are scripted; other
// completions (classification, titles) get an immediate short reply, and
// requests asking for JSON get "{}". Every request is appended to LOG as JSONL.
//
// Usage: node m5-scripted-provider.mjs --port 18931 --log /path/requests.jsonl
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const PORT = Number(arg('--port', '18931'))
const LOG = arg('--log', null)
const SLOW_MS = Number(arg('--slow-ms', '450'))
const CONFIRM_TOOLS = ['archiveTasks', 'bulkUpdateTasks', 'createKnowledgeEntry', 'saveKnowledge', 'handoffToWorkspaceChat']

let seq = 0
const log = (entry) => {
  if (!LOG) return
  try { appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n') } catch { /* best effort */ }
}

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ')
  return ''
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return textOf(messages[i].content)
  }
  return ''
}

/** The authored text is the last timestamped segment: history merges consecutive
 * user messages (for example after a stopped turn), so only the newest one counts. */
function directiveOf(full) {
  const parts = full.split(/\[[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, [^\]]{4,40}\]/)
  const text = parts[parts.length - 1] || full
  const slow = text.match(/slow:(\d{1,3})/i)
  return {
    slow: slow ? Math.min(Number(slow[1]), 400) : 0,
    ask: /\bask:/i.test(text),
    approve: /\bapprove:/i.test(text),
    work: /\bwork:/i.test(text),
    tag: (text.match(/#([a-z0-9-]{2,40})/i) ?? [])[1] ?? null,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function streamText(res, model, words, delayMs, aborted) {
  const base = { id: `chatcmpl-m5-${++seq}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`)
  for (const w of words) {
    if (aborted()) return false
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })}\n\n`)
    if (delayMs) await sleep(delayMs)
  }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length } })}\n\n`)
  res.end('data: [DONE]\n\n')
  return true
}

function streamToolCall(res, model, name, input) {
  const base = { id: `chatcmpl-m5-${++seq}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  const call = { index: 0, id: `call_m5_${seq}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: null }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
  res.end('data: [DONE]\n\n')
}

function confirmationInput(name) {
  if (name === 'archiveTasks') return { filter: { status: ['todo'], title_contains: 'm5-qualification-nothing' } }
  if (name === 'bulkUpdateTasks') return { filter: { status: ['todo'], title_contains: 'm5-qualification-nothing' }, set: { priority: 'low' } }
  return { title: 'M5 qualification note', path: 'm5/qualification.md', content: 'Scripted entry.' }
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    let json = {}
    try { json = body ? JSON.parse(body) : {} } catch { /* tolerate */ }
    const model = json.model ?? 'm5-scripted'
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'm5-scripted', object: 'model' }] }))
      return
    }
    if (req.method === 'POST' && /\/embeddings$/.test(req.url)) {
      const inputs = Array.isArray(json.input) ? json.input : [json.input ?? '']
      const dims = Number(json.dimensions) || 1024
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list', model,
        data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: dims }, (_, i) => (i === index % dims ? 1 : 0)) })),
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      }))
      return
    }
    if (!(req.method === 'POST' && /\/chat\/completions$/.test(req.url))) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `m5 scripted provider: no route ${req.method} ${req.url}` } }))
      return
    }
    const messages = Array.isArray(json.messages) ? json.messages : []
    const tools = Array.isArray(json.tools) ? json.tools.map((t) => t?.function?.name).filter(Boolean) : []
    const userText = lastUserText(messages)
    const d = directiveOf(userText)
    const last = messages[messages.length - 1]
    const wantsJson = json.response_format && json.response_format.type !== 'text'
    const entry = { n: ++seq, model, stream: json.stream === true, tools: tools.length, offered: tools.filter((t) => t === 'askQuestion' || CONFIRM_TOOLS.includes(t)), lastRole: last?.role ?? null, directive: d, userTail: userText.slice(-160) }
    let aborted = false
    res.on('close', () => { aborted = true })

    if (!json.stream) {
      const content = wantsJson ? '{}' : 'Scripted note.'
      log({ ...entry, kind: 'non-stream' })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: `chatcmpl-m5-${seq}`, object: 'chat.completion', created: 0, model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    if (tools.length === 0) {
      log({ ...entry, kind: 'aux-stream' })
      await streamText(res, model, wantsJson || /json/i.test(userText) ? ['{}'] : ['Scripted ', 'note.'], 0, () => aborted)
      return
    }
    const tag = d.tag ? ` #${d.tag}` : ''
    const authored = (userText.split(/\[[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, [^\]]{4,40}\]/).pop() || userText)
    if (last?.role === 'tool') {
      const toolText = textOf(last.content).replace(/\s+/g, ' ').slice(0, 80)
      const words = `Tool step finished${tag}. Result: ${toolText}`.split(/(?<= )/)
      if (d.slow) words.push(...Array.from({ length: d.slow }, (_, i) => ` w${i + 1}`), ' end.')
      log({ ...entry, kind: 'after-tool' })
      await streamText(res, model, words, d.slow ? SLOW_MS : 30, () => aborted)
      return
    }
    if (d.ask && tools.includes('askQuestion')) {
      log({ ...entry, kind: 'tool-call', tool: 'askQuestion' })
      streamToolCall(res, model, 'askQuestion', { question: `Which colour should the M5 check use${tag}?`, options: ['Blue', 'Green'] })
      return
    }
    if (d.work) {
      const name = ['listTasks', 'getTime'].find((t) => tools.includes(t))
      if (name) {
        log({ ...entry, kind: 'tool-call', tool: name })
        streamToolCall(res, model, name, {})
        return
      }
    }
    if (d.approve) {
      const name = CONFIRM_TOOLS.find((t) => tools.includes(t))
      if (name) {
        log({ ...entry, kind: 'tool-call', tool: name })
        streamToolCall(res, model, name, confirmationInput(name))
        return
      }
      log({ ...entry, kind: 'approve-unavailable', offeredTools: tools })
    }
    let words
    if (d.slow) {
      words = Array.from({ length: d.slow }, (_, i) => `w${i + 1} `)
      words.unshift(`Slow reply${tag}: `)
      words.push('end.')
    } else {
      const head = authored.replace(/\s+/g, ' ').trim().split(' ').slice(-6).join(' ')
      words = `Scripted reply${tag} to: ${head}`.split(/(?<= )/)
    }
    log({ ...entry, kind: 'text', words: words.length })
    const done = await streamText(res, model, words, d.slow ? SLOW_MS : 20, () => aborted)
    if (!done) log({ n: entry.n, kind: 'client-aborted' })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[m5-provider] listening on http://127.0.0.1:${PORT}/compatible-mode/v1`)
})
