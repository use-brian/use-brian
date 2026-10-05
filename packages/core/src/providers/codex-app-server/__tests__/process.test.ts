import { access, mkdtemp, readdir, realpath, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  buildCodexEnvironment,
  resolvePinnedCodexCommand,
  startCodexAppServer,
} from '../process.js'
import { PINNED_CODEX_VERSION } from '../protocol.js'

const fakeServer = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url))
const cleanupPaths: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('[COMP:providers/codex-process] managed Codex app-server process', () => {
  it('survives an OS temporary-directory sweep and removes only its owned cwd on close', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-durable-home-test-'))
    const sweptTemp = await mkdtemp(join(tmpdir(), 'codex-swept-temp-test-'))
    cleanupPaths.push(codexHome, sweptTemp)
    await writeFile(join(codexHome, 'sentinel'), 'preserve')
    for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, sweptTemp)
    const options = {
      codexHome,
      surface: 'inference' as const,
      command: { command: process.execPath, argsPrefix: [fakeServer] },
      shutdownTimeoutMs: 500,
    }
    const client = await startCodexAppServer(options)
    let sibling: Awaited<ReturnType<typeof startCodexAppServer>> | undefined
    try {
      sibling = await startCodexAppServer(options)
      await rm(sweptTemp, { recursive: true, force: true })
      await expect(client.rpc.request('thread/start', { cwd: client.cwd }, z.object({ cwd: z.string() })))
        .resolves.toEqual({ cwd: client.cwd })
      expect(client.cwd).toContain(join(await realpath(codexHome), 'runtime', 'process-'))
      expect(await readdir(client.cwd)).toEqual([])
      if (process.platform !== 'win32') expect((await stat(client.cwd)).mode & 0o777).toBe(0o700)
      await client.close()
      await expect(access(client.cwd)).rejects.toThrow()
      await expect(sibling.rpc.request('thread/start', { cwd: sibling.cwd }, z.unknown())).resolves.toEqual({ cwd: sibling.cwd })
      expect(await readFile(join(codexHome, 'sentinel'), 'utf8')).toBe('preserve')
    } finally {
      await client.close()
      await sibling?.close()
    }
  })

  it('resolves the exact pinned package entry instead of a global binary', async () => {
    const command = await resolvePinnedCodexCommand()

    expect(PINNED_CODEX_VERSION).toBe('0.146.0-alpha.10.1')
    expect(command.command).toBe(process.execPath)
    expect(command.argsPrefix).toHaveLength(1)
    expect(command.argsPrefix?.[0]).toContain('@openai+codex@0.146.0-alpha.10.1')
    expect(command.argsPrefix?.[0]).toMatch(/bin[/\\]codex\.js$/)
  })

  it('builds an allowlisted environment without API keys, access tokens, or HOME', () => {
    const environment = buildCodexEnvironment('/safe/codex-home', {
      PATH: '/safe/bin',
      HOME: '/private/user',
      OPENAI_API_KEY: 'secret-platform-key',
      CODEX_API_KEY: 'secret-codex-key',
      CODEX_ACCESS_TOKEN: 'secret-token',
      HTTPS_PROXY: 'https://proxy.example',
      UNRELATED_SECRET: 'also-secret',
    })

    expect(environment).toEqual({
      CODEX_HOME: '/safe/codex-home',
      RUST_LOG: 'warn',
      PATH: '/safe/bin',
      HTTPS_PROXY: 'https://proxy.example',
    })
  })

  it('initializes over stdio with an isolated home and empty owned cwd', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'use-brian-codex-home-test-'))
    cleanupPaths.push(codexHome)
    const client = await startCodexAppServer({
      codexHome,
      command: { command: process.execPath, argsPrefix: [fakeServer] },
      maxStderrBytes: 16,
      shutdownTimeoutMs: 500,
    })

    const canonicalCodexHome = await realpath(codexHome)
    expect(client.codexHome).toBe(canonicalCodexHome)
    expect(client.initialize).toMatchObject({
      codexHome: canonicalCodexHome,
      platformFamily: 'test',
      userAgent: 'fake-codex-app-server',
    })
    expect(client.initialize.platformOs).toBe(client.cwd)
    expect(await readdir(client.cwd)).toEqual([])
    expect(client.diagnostics()).toEqual({ stderrBytes: 16, stderrTruncated: true })
    await expect(client.rpc.request('thread/start', {}, z.unknown())).rejects.toThrow(
      'RPC method is not enabled: thread/start',
    )

    await client.close()
    await expect(access(client.cwd)).rejects.toThrow()
    await expect(access(codexHome)).resolves.toBeUndefined()
  })

  it('rejects a relative credential home before spawning', async () => {
    await expect(startCodexAppServer({ codexHome: 'relative/codex' })).rejects.toThrow(
      'codexHome must be an absolute path',
    )
  })

  it('offers an account-only surface without enabling thread or turn methods', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'use-brian-codex-account-test-'))
    cleanupPaths.push(codexHome)
    const client = await startCodexAppServer({
      codexHome,
      surface: 'account',
      command: { command: process.execPath, argsPrefix: [fakeServer] },
      shutdownTimeoutMs: 500,
    })

    await expect(
      client.rpc.request(
        'account/read',
        { refreshToken: false },
        z.object({ account: z.null(), requiresOpenaiAuth: z.boolean() }),
      ),
    ).resolves.toEqual({ account: null, requiresOpenaiAuth: true })
    await expect(client.rpc.request('model/list', {}, z.unknown())).resolves.toEqual({
      data: [],
      nextCursor: null,
    })
    await expect(client.rpc.request('thread/start', {}, z.unknown())).rejects.toThrow(
      'RPC method is not enabled: thread/start',
    )
    await expect(client.rpc.request('turn/start', {}, z.unknown())).rejects.toThrow(
      'RPC method is not enabled: turn/start',
    )

    await client.close()
  })

  it('keeps account mutation and history injection out of the image surface', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'use-brian-codex-image-test-'))
    cleanupPaths.push(codexHome)
    const client = await startCodexAppServer({ codexHome, surface: 'image', command: { command: process.execPath, argsPrefix: [fakeServer] }, shutdownTimeoutMs: 500 })
    try {
      await expect(client.rpc.request('account/read', { refreshToken: false }, z.unknown())).resolves.toMatchObject({ account: null })
      for (const method of ['account/login/start', 'account/logout', 'thread/inject_items']) {
        await expect(client.rpc.request(method, {}, z.unknown())).rejects.toThrow(`RPC method is not enabled: ${method}`)
      }
    } finally { await client.close() }
  })

  it('honors an already-aborted start without creating a process', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(startCodexAppServer({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
