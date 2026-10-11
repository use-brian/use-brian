import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '../../types.js'
import { buildCodexEnvironment, CODEX_INFERENCE_HARDENING_ARGS, resolvePinnedCodexCommand } from '../process.js'
import { InitializeResponseSchema } from '../protocol.js'
import { CodexRpcPeer } from '../rpc.js'
import { createCodexAppServerProvider } from '../provider.js'

const MODEL = 'gpt-5.6-sol'
const sse = (events: object[]) => events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

// The pinned runtime nests Brian's dynamic tools inside its `exec` envelope,
// and `exec` YIELDS to the model once its yield_time_ms (default 10 s) passes
// while a nested call is still pending. A Brian tool held longer than that
// (a human approval, a slow browser action) therefore does not block the
// Codex turn: the model is called again while Brian has no send open.
describe('[COMP:providers/codex-app-server] pinned runtime tool yield', () => {
  it('a turn that ends while a Brian tool is held resumes on a fresh turn that sees the result', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brian-codex-yield-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'brian-codex-yield-cwd-'))
    const requests: Array<{ at: number; body: string }> = []
    const server = createServer((req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [] })); return }
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        if (!req.url?.includes('/responses')) { res.writeHead(500); res.end('{}'); return }
        requests.push({ at: Date.now(), body })
        const n = requests.length
        const id = `response-fixture-${n}`
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (n === 1) {
          // The model calls one Brian tool through exec, with a short yield.
          const item = { type: 'custom_tool_call', id: 'exec-item', call_id: 'exec-call', name: 'exec', input: "// @exec: {\"yield_time_ms\": 200}\nconst result = await tools.brian_echo({ value: 'x' });\ntext(JSON.stringify(result));" }
          res.end(sse([
            { type: 'response.created', response: { id } },
            { type: 'response.output_item.done', item },
            { type: 'response.completed', response: { id, output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
          ]))
          return
        }
        // Every later call (the post-yield one included) answers in text and ends the turn.
        const text = `answer ${n}`
        const item = { type: 'message', id: `msg-${n}`, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
        res.end(sse([
          { type: 'response.created', response: { id } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
          { type: 'response.output_text.delta', item_id: `msg-${n}`, output_index: 0, content_index: 0, delta: text },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id, output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
        ]))
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const { port } = server.address() as { port: number }
    const command = await resolvePinnedCodexCommand()
    const child = spawn(command.command, [...(command.argsPrefix ?? []), 'app-server', ...CODEX_INFERENCE_HARDENING_ARGS,
      '-c', 'analytics.enabled=false',
      '-c', 'model_provider="brian_mock"', '-c', 'model_providers.brian_mock.name="Brian mock"',
      '-c', `model_providers.brian_mock.base_url="http://127.0.0.1:${port}/v1"`,
      '-c', 'model_providers.brian_mock.wire_api="responses"', '-c', 'model_providers.brian_mock.requires_openai_auth=false',
      '--listen', 'stdio://'], { cwd, env: buildCodexEnvironment(home, { ...process.env, RUST_LOG: 'error' }), stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000) })
    const rpc = new CodexRpcPeer({ input: child.stdout, output: child.stdin, requestTimeoutMs: 15_000 })
    try {
      await rpc.request('initialize', { clientInfo: { name: 'brian_yield_fixture', version: '0.0.1' }, capabilities: { experimentalApi: true } }, InitializeResponseSchema)
      await rpc.notify('initialized', {})
      const provider = createCodexAppServerProvider({ transport: { rpc, cwd }, models: [MODEL] })
      const session = provider.createSession!({
        model: MODEL, systemPrompt: 'Fixture.',
        tools: [{ name: 'brian_echo', description: 'Echo through Brian.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }],
      })
      const first: StreamChunk[] = []
      for await (const chunk of session.send([{ role: 'user', content: 'Call brian_echo.' }])) first.push(chunk)
      const toolUse = first.find((c): c is Extract<StreamChunk, { type: 'tool_use_start' }> => c.type === 'tool_use_start')
      expect(toolUse?.name, JSON.stringify({ first, stderr })).toBe('brian_echo')

      // Hold the tool result well past the exec yield, as an approval wait does.
      await new Promise(resolve => setTimeout(resolve, 1_500))
      const released = Date.now()
      // Precondition: Codex called the model again while Brian still held the tool.
      expect(requests.length, JSON.stringify({ stderr })).toBeGreaterThanOrEqual(2)
      expect(requests[1]!.at).toBeLessThan(released)
      expect(requests[1]!.body).toContain('Script running with cell ID')

      const second: StreamChunk[] = []
      const drained = (async () => {
        for await (const chunk of session.send([{ role: 'user', content: [{ type: 'tool_result', toolUseId: toolUse!.id, name: 'brian_echo', content: 'echo:x' }] }])) second.push(chunk)
        return 'ended' as const
      })()
      const outcome = await Promise.race([drained, new Promise<'stalled'>(resolve => setTimeout(() => resolve('stalled'), 5_000))])
      // The yielded turn ended without the result ("answer 2" never saw it), so the
      // resumed send must end - not stall - on a fresh turn that does see it.
      expect(outcome, JSON.stringify({ second, requests: requests.length, stderr })).toBe('ended')
      expect(requests).toHaveLength(3)
      expect(requests[2]!.body).toContain('echo:x')
      const text = second.filter(c => c.type === 'text_delta').map(c => (c as { text: string }).text).join('')
      expect(text).toBe('answer 3')
      expect(second.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'end_turn' })
    } finally {
      rpc.close(); child.stdin.end(); child.kill('SIGTERM'); server.closeAllConnections(); server.close()
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))])
      await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })])
    }
  }, 30_000)
})
