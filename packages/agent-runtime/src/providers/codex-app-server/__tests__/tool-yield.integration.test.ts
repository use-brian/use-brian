import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '../../types.js'
import { buildCodexEnvironment, buildCodexToolSurfaceArgs, resolvePinnedCodexCommand } from '../process.js'
import { InitializeResponseSchema } from '../protocol.js'
import { CodexRpcPeer } from '../rpc.js'
import { createCodexAppServerProvider } from '../provider.js'

const MODEL = 'gpt-5.6-sol'
const sse = (events: object[]) => events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

// Direct dynamic calls must stay parked until Brian returns their result.
describe('[COMP:providers/codex-app-server] pinned runtime tool result', () => {
  it('waits for a held Brian tool result before requesting the final response', async () => {
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
          const item = { type: 'function_call', id: 'tool-item', call_id: 'tool-call', name: 'brian_echo', arguments: JSON.stringify({ value: 'x' }) }
          res.end(sse([
            { type: 'response.created', response: { id } },
            { type: 'response.output_item.done', item },
            { type: 'response.completed', response: { id, output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
          ]))
          return
        }
        // After Brian supplies the result, the model composes the final response.
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
    const child = spawn(command.command, [...(command.argsPrefix ?? []), 'app-server', ...await buildCodexToolSurfaceArgs(command, cwd, 'inference'),
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

      // A slow action or human approval must not trigger another inference.
      await new Promise(resolve => setTimeout(resolve, 1_500))
      expect(requests).toHaveLength(1)

      const second: StreamChunk[] = []
      const drained = (async () => {
        for await (const chunk of session.send([{ role: 'user', content: [{ type: 'tool_result', toolUseId: toolUse!.id, name: 'brian_echo', content: 'echo:x' }] }])) second.push(chunk)
        return 'ended' as const
      })()
      const outcome = await Promise.race([drained, new Promise<'stalled'>(resolve => setTimeout(() => resolve('stalled'), 5_000))])
      expect(outcome, JSON.stringify({ second, requests: requests.length, stderr })).toBe('ended')
      expect(requests).toHaveLength(2)
      expect(requests[1]!.body).toContain('echo:x')
      const text = second.filter(c => c.type === 'text_delta').map(c => (c as { text: string }).text).join('')
      expect(text).toBe('answer 2')
      expect(second.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'end_turn' })
    } finally {
      rpc.close(); child.stdin.end(); child.kill('SIGTERM'); server.closeAllConnections(); server.close()
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))])
      await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })])
    }
  }, 30_000)
})
