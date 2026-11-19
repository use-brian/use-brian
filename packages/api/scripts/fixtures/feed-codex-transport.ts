/** Local-only subscription transport for the native Feed boot fixture. [COMP:feed/draft-generation] */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexImageProvider } from '@use-brian/agent-runtime/providers/codex-app-server/image.js'
import { resolvePinnedCodexCommand, startCodexAppServer } from '@use-brian/agent-runtime/providers/codex-app-server/process.js'
export async function createFeedCodexFixture(onImage: () => void) {
  if (process.env.NODE_ENV !== 'test' || new URL(process.env.DATABASE_URL!).pathname !== '/feed_draft_collaboration_acceptance') throw new Error('Isolated fixture required')
  const home = await mkdtemp(join(tmpdir(), 'feed-codex-fixture-'))
  const claims = { exp: Math.floor(Date.now() / 1000) + 86400, email: 'image-test@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'image-fixture-account' } }
  const token = `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`
  await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token, access_token: token, refresh_token: 'local-fixture-only', account_id: 'image-fixture-account' }, last_refresh: new Date().toISOString() }))
  const seen = new Set<string>()
  const server = createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [] })); return }
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (req.url?.includes('/images/generations')) {
        onImage(); res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: 1, data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=' }] })); return
      }
      if (req.url?.includes('/responses') && !seen.has(body.prompt_cache_key)) {
        seen.add(body.prompt_cache_key)
        const item = { type: 'custom_tool_call', id: 'call-item', call_id: 'image-call', name: 'exec', input: "const result = await tools.image_gen__imagegen({ prompt: 'A fixture diagram' }); generatedImage(result);" }
        res.writeHead(200, { 'content-type': 'text/event-stream' }) // sse-lifetime: turn-bounded (finite fixture, res.end below)
        for (const event of [{ type: 'response.created', response: { id: 'fixture' } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: 'fixture', output: [item], usage: { input_tokens: 5, output_tokens: 5 } } }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        res.end(); return
      }
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fixture complete' } }))
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const { port } = server.address() as { port: number }
  const pinned = await resolvePinnedCodexCommand(); const wrapper = join(home, 'wrapper.mjs')
  const config = ['-c', 'analytics.enabled=false', '-c', `chatgpt_base_url="http://127.0.0.1:${port}"`, '-c', 'model_provider="brian_mock"', '-c', 'model_providers.brian_mock.name="Brian mock"', '-c', `model_providers.brian_mock.base_url="http://127.0.0.1:${port}/v1"`, '-c', 'model_providers.brian_mock.wire_api="responses"', '-c', 'model_providers.brian_mock.requires_openai_auth=true']
  await writeFile(wrapper, `import {spawn} from 'node:child_process';const args=process.argv.slice(2);const child=spawn(${JSON.stringify(pinned.command)},[...${JSON.stringify(pinned.argsPrefix)},args[0],...${JSON.stringify(config)},...args.slice(1)],{stdio:'inherit',env:process.env});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??1));`)
  return createCodexImageProvider({ models: ['gpt-5.6-sol'], startProcess: options => startCodexAppServer({ ...options, codexHome: home, command: { command: process.execPath, argsPrefix: [wrapper] } }) })
}
