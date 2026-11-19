import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { z } from 'zod'
import { buildCodexEnvironment, buildCodexToolSurfaceArgs, resolvePinnedCodexCommand } from '../process.js'
import { CodexRpcPeer } from '../rpc.js'
import { InitializeResponseSchema } from '../protocol.js'
import { generateCodexImage } from '../image.js'

describe('[COMP:core/codex-image] pinned image runtime', () => {
  it('exposes only image generation and bridges its real public completion using loopback fixtures', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brian-image-home-')); const cwd = await mkdtemp(join(tmpdir(), 'brian-image-cwd-'))
    const png = (await sharp({ create: { width: 4, height: 4, channels: 3, background: 'white' } }).png().toBuffer()).toString('base64')
    // Synthetic credentials are only consumed by this local mock. Never read global auth.
    const claims = { exp: Math.floor(Date.now() / 1000) + 86400, email: 'image-test@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'image-fixture-account' } }
    const token = `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`
    await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token, access_token: token, refresh_token: 'local-fixture-only', account_id: 'image-fixture-account' }, last_refresh: new Date().toISOString() }))
    const requests: Array<{ path: string; body: any }> = []
    const server = createServer((req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [], accounts: [{ id: 'image-fixture-account', account_id: 'image-fixture-account',
        name: 'Fixture', email: 'image-test@example.com', plan_type: 'pro', workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT' }],
        account_ordering: ['image-fixture-account'], default_account_id: 'image-fixture-account' })); return }
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ path: req.url!, body })
        if (req.url?.includes('/images/generations')) {
          setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ created: 1, data: [{ b64_json: png }] })) }, 1500)
          return
        }
        const responseNumber = requests.filter(r => r.path.includes('/responses')).length
        if (req.url?.includes('/responses') && responseNumber === 1) {
          const item = { type: 'function_call', id: 'image-item', call_id: 'image-call', name: 'imagegen', namespace: 'image_gen', arguments: JSON.stringify({ prompt: 'One simple diagram' }) }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          for (const event of [
            { type: 'response.created', response: { id: `response-fixture-${responseNumber}` } },
            { type: 'response.output_item.done', item },
            { type: 'response.completed', response: { id: `response-fixture-${responseNumber}`, output: [item], usage: { input_tokens: 5, output_tokens: 5 } } },
          ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          res.end(); return
        }
        if (req.url?.includes('/responses')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          for (const event of [
            { type: 'response.created', response: { id: `response-fixture-${responseNumber}` } },
            { type: 'response.completed', response: { id: `response-fixture-${responseNumber}`, output: [], usage: { input_tokens: 5, output_tokens: 0 } } },
          ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          res.end(); return
        }
        res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'local fixture complete' } }))
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const { port } = server.address() as { port: number }; const command = await resolvePinnedCodexCommand()
    const child = spawn(command.command, [...(command.argsPrefix ?? []), 'app-server', ...await buildCodexToolSurfaceArgs(command, cwd, 'image'),
      '-c', 'analytics.enabled=false', '-c', `chatgpt_base_url="http://127.0.0.1:${port}"`,
      '-c', 'model_provider="brian_mock"', '-c', 'model_providers.brian_mock.name="Brian mock"',
      '-c', `model_providers.brian_mock.base_url="http://127.0.0.1:${port}/v1"`,
      '-c', 'model_providers.brian_mock.wire_api="responses"', '-c', 'model_providers.brian_mock.requires_openai_auth=true',
      '--listen', 'stdio://'], { cwd, env: buildCodexEnvironment(home, { PATH: process.env.PATH, RUST_LOG: 'error' }), stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
    const rpc = new CodexRpcPeer({ input: child.stdout, output: child.stdin, requestTimeoutMs: 15000, maxFrameBytes: 64 * 1024 * 1024 })
    try {
      await rpc.request('initialize', { clientInfo: { name: 'brian_image_fixture', version: '0.0.1' }, capabilities: { experimentalApi: true } }, InitializeResponseSchema)
      await rpc.notify('initialized', {})
      const account = await rpc.request('account/read', { refreshToken: false }, z.object({ account: z.object({ type: z.string() }) }))
      expect(account.account.type).toBe('chatgpt')
      const receipt = await generateCodexImage({ rpc, cwd }, { model: 'gpt-image-2', orchestratorModel: 'gpt-5.6-sol', identity: 'fixture' }, 'A diagram', AbortSignal.timeout(15000))
      const request = requests.find(r => r.path.includes('/responses'))!.body
      const envelopes = request.input.find((item: any) => item.type === 'additional_tools').tools
      expect(request.tools ?? []).toEqual([])
      expect(envelopes.map((tool: any) => tool.name)).toEqual(['image_gen'])
      expect(envelopes[0].tools.map((tool: any) => tool.name)).toEqual(['imagegen'])
      expect(receipt.image, JSON.stringify({ receipt, paths: requests.map(r => r.path), stderr })).toEqual({ data: png, mimeType: 'image/png' })
      expect(requests.filter(r => r.path.includes('/images/generations'))).toHaveLength(1)
      const responseRequests = requests.filter(r => r.path.includes('/responses'))
      expect(responseRequests).toHaveLength(1)
      expect(requests.find(r => r.path.includes('/images/generations'))?.body.model).toBe('gpt-image-2')
    } finally {
      rpc.close(); child.stdin.end(); child.kill('SIGTERM'); server.closeAllConnections(); server.close()
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))])
      await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })])
    }
  }, 25000)
})
