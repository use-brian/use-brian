import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { providerModelIds } from '@use-brian/shared/model-registry'
import {
  buildCodexEnvironment,
  CODEX_INFERENCE_HARDENING_ARGS,
  resolvePinnedCodexCommand,
  startCodexAppServer,
} from '../process.js'
import { CodexCatalogClient } from '../catalog.js'
import { CodexAccountClient } from '../auth.js'
import { InitializeResponseSchema } from '../protocol.js'
import { CodexRpcPeer } from '../rpc.js'

const ThreadStartResponseSchema = z
  .object({
    thread: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .passthrough()

describe('[COMP:providers/codex-native-tool-boundary] pinned runtime tool surface', () => {
  it('preserves the existing Brian-owned login across both runtime pins', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'use-brian-codex-shared-login-'))
    const claims = { exp: Math.floor(Date.now() / 1000) + 86_400, email: 'fixture@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'fixture-account' } }
    const token = `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`
    const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token, access_token: token,
      refresh_token: 'local-fixture-only', account_id: 'fixture-account' }, last_refresh: new Date().toISOString() })
    await writeFile(join(codexHome, 'auth.json'), auth)
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ accounts: [{ id: 'fixture-account', account_id: 'fixture-account',
        name: 'Fixture', email: 'fixture@example.com', plan_type: 'pro',
        workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT' }],
        account_ordering: ['fixture-account'], default_account_id: 'fixture-account' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('account fixture has no port')
    try {
      for (const surface of ['account', 'inference'] as const) {
        const command = await resolvePinnedCodexCommand(surface)
        const process = await startCodexAppServer({ codexHome, surface, command: {
          ...command, argsPrefix: [...(command.argsPrefix ?? []), '-c', `chatgpt_base_url="http://127.0.0.1:${address.port}"`],
        } })
        const account = new CodexAccountClient(process.rpc)
        try {
          await expect(account.readAccount()).resolves.toMatchObject({ connected: true, authType: 'chatgpt', planType: 'pro' })
          expect(await readFile(join(codexHome, 'auth.json'), 'utf8')).toBe(auth)
        } finally { account.close(); await process.close() }
      }
    } finally {
      server.closeAllConnections()
      server.close()
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('discovers the current public model slate through a real account-only runtime', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'use-brian-codex-catalog-home-'))
    const client = await startCodexAppServer({ codexHome, surface: 'account' })
    try {
      const catalog = await new CodexCatalogClient(client.rpc).listModels()
      expect(catalog.models.map(model => model.model)).toEqual(expect.arrayContaining([
        'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra',
      ]))
      for (const method of ['thread/start', 'turn/start']) {
        await expect(client.rpc.request(method, {}, z.unknown())).rejects.toThrow(`RPC method is not enabled: ${method}`)
      }
    } finally {
      await client.close()
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it.each(providerModelIds('openai-codex'))('exposes only Brian dynamic tools for %s', async (model) => {
    const codexHome = await mkdtemp(join(tmpdir(), 'use-brian-codex-boundary-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'use-brian-codex-boundary-cwd-'))
    const bodies: unknown[] = []
    const receivedBody = promiseWithResolvers<void>()
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        try {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          receivedBody.resolve()
        } catch (error) {
          receivedBody.reject(error)
        }
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'probe complete' } }))
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('probe server has no TCP port')

    const command = await resolvePinnedCodexCommand()
    const child = spawn(
      command.command,
      [
        ...(command.argsPrefix ?? []),
        'app-server',
        ...CODEX_INFERENCE_HARDENING_ARGS,
        '-c',
        'model_provider="brian_mock"',
        '-c',
        'model_providers.brian_mock.name="Brian mock"',
        '-c',
        `model_providers.brian_mock.base_url="http://127.0.0.1:${address.port}/v1"`,
        '-c',
        'model_providers.brian_mock.wire_api="responses"',
        '-c',
        'model_providers.brian_mock.requires_openai_auth=false',
        '--listen',
        'stdio://',
      ],
      {
        cwd,
        env: buildCodexEnvironment(codexHome, {
          ...process.env,
          RUST_LOG: 'error',
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_384)
    })
    const rpc = new CodexRpcPeer({
      input: child.stdout,
      output: child.stdin,
      requestTimeoutMs: 10_000,
    })

    try {
      await rpc.request(
        'initialize',
        {
          clientInfo: {
            name: 'use_brian_boundary_probe',
            title: 'Use Brian boundary probe',
            version: '0.0.1',
          },
          capabilities: { experimentalApi: true },
        },
        InitializeResponseSchema,
      )
      await rpc.notify('initialized', {})
      const started = await rpc.request(
        'thread/start',
        {
          model,
          modelProvider: 'brian_mock',
          cwd,
          ephemeral: true,
          approvalPolicy: {
            granular: {
              mcp_elicitations: false,
              request_permissions: false,
              rules: false,
              sandbox_approval: false,
              skill_approval: false,
            },
          },
          sandbox: 'read-only',
          environments: [],
          dynamicTools: [
            {
              type: 'function',
              name: 'brian_echo',
              description: 'Return a test string through Brian.',
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false,
              },
            },
          ],
        },
        ThreadStartResponseSchema,
      )
      await rpc.request(
        'turn/start',
        {
          threadId: started.thread.id,
          input: [{ type: 'text', text: 'Reply with OK. Do not call a tool.' }],
        },
        z.object({ turn: z.object({ id: z.string() }).passthrough() }).passthrough(),
      )
      await Promise.race([
        receivedBody.promise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('mock provider did not receive a request')), 10_000)
        }),
      ])

      const request = z
        .object({
          model: z.string(),
          input: z.array(z.unknown()),
          tools: z
            .array(
              z
                .object({
                  name: z.string().optional(),
                  type: z.string().optional(),
                })
                .passthrough(),
            )
            .default([]),
        })
        .passthrough()
        .parse(bodies[0])
      expect(request.model).toBe(model)
      const additionalTools = request.input
        .map((item) =>
          z
            .object({
              type: z.literal('additional_tools'),
              tools: z.array(
                z
                  .object({
                    name: z.string(),
                    description: z.string().optional(),
                  })
                  .passthrough(),
              ),
            })
            .passthrough()
            .safeParse(item),
        )
        .find((result) => result.success)
      if (!additionalTools?.success) {
        expect(request.tools.map((tool) => tool.name)).toEqual(['brian_echo'])
        expect(request.tools.map((tool) => tool.type)).toEqual(['function'])
        return
      }

      const directNames = request.tools.map((tool) => tool.name ?? tool.type ?? 'unknown')
      expect(directNames).toEqual([])
      const names = additionalTools.data.tools.map((tool) => tool.name)
      const tools = names[0] === 'functions'
        ? z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough()) }).parse(additionalTools.data.tools[0]).tools
        : additionalTools.data.tools
      expect(tools.map((tool) => tool.name)).toEqual(['exec', 'wait'])
      const description = tools.find((tool) => tool.name === 'exec')?.description ?? ''
      expect(Array.from(description.matchAll(/^### `([^`]+)`$/gm), (match) => match[1])).toEqual(['brian_echo'])
    } catch (error) {
      throw new Error(
        `Codex native-tool boundary probe failed (stderr=${JSON.stringify(stderr)}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    } finally {
      rpc.close()
      child.stdin.end()
      child.kill('SIGTERM')
      await Promise.race([
        once(child, 'exit'),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ])
      server.close()
      await once(server, 'close')
      await Promise.all([
        rm(codexHome, { recursive: true, force: true }),
        rm(cwd, { recursive: true, force: true }),
      ])
    }
  })
})

function promiseWithResolvers<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
