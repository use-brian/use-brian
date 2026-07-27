import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildCodexEnvironment,
  CODEX_INFERENCE_HARDENING_ARGS,
  resolvePinnedCodexCommand,
} from '../process.js'
import { InitializeResponseSchema } from '../protocol.js'
import { CodexRpcPeer } from '../rpc.js'

const ThreadStartResponseSchema = z
  .object({
    thread: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .passthrough()

describe('[COMP:providers/codex-native-tool-boundary] pinned runtime tool surface', () => {
  it('exposes only Brian dynamic tools after every configurable native feature is disabled', async () => {
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
          model: 'gpt-5.6-sol',
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
      expect(additionalTools?.success).toBe(true)
      if (!additionalTools?.success) throw new Error('missing additional_tools request item')

      const directNames = request.tools.map((tool) => tool.name ?? tool.type ?? 'unknown')
      const envelopeNames = additionalTools.data.tools.map((tool) => tool.name)
      const execDescription =
        additionalTools.data.tools.find((tool) => tool.name === 'exec')?.description ?? ''
      const nestedNames = Array.from(
        execDescription.matchAll(/^### `([^`]+)`$/gm),
        (match) => match[1],
      )

      expect(directNames).toEqual([])
      expect(envelopeNames).toEqual(['exec', 'wait'])
      expect(nestedNames).toEqual(['brian_echo'])
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
