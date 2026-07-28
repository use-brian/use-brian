import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  CodexRpcClosedError,
  CodexRpcPeer,
  type CodexAppServerProcess,
} from '@use-brian/core'
import { MutableProviderAvailability } from '@use-brian/shared/model-registry'
import { startCodexProviderManager } from '../codex-provider-manager.js'

type Frame = { id?: number; method?: string; params?: unknown }

function processHarness(): {
  process: CodexAppServerProcess
  peer: CodexRpcPeer
  inbound: PassThrough
  outbound: Frame[]
  close: ReturnType<typeof vi.fn>
} {
  const inbound = new PassThrough()
  const output = new PassThrough()
  const outbound: Frame[] = []
  let buffered = ''
  output.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      outbound.push(JSON.parse(buffered.slice(0, newline)))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  })
  const peer = new CodexRpcPeer({ input: inbound, output })
  const close = vi.fn(async () => {})
  return {
    process: {
      rpc: peer,
      initialize: {
        codexHome: '/tmp/codex-home',
        platformFamily: 'unix',
        platformOs: 'test',
        userAgent: 'test',
      },
      codexHome: '/tmp/codex-home',
      cwd: '/tmp/codex-cwd',
      pid: 1,
      diagnostics: () => ({ stderrBytes: 0, stderrTruncated: false }),
      close,
    },
    peer,
    inbound,
    outbound,
    close,
  }
}

async function waitForMethod(
  harness: ReturnType<typeof processHarness>,
  method: string,
  occurrence = 0,
): Promise<Frame> {
  await vi.waitFor(() => {
    expect(harness.outbound.filter((frame) => frame.method === method).length).toBeGreaterThan(
      occurrence,
    )
  })
  return harness.outbound.filter((frame) => frame.method === method)[occurrence]!
}

function respond(
  harness: ReturnType<typeof processHarness>,
  request: Frame,
  result: unknown,
): void {
  harness.inbound.write(`${JSON.stringify({ id: request.id, result })}\n`)
}

function catalogModel(model: string, overrides: Record<string, unknown> = {}) {
  return {
    id: model,
    model,
    displayName: model,
    description: 'Test model',
    hidden: false,
    isDefault: model === 'gpt-5.6-sol',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' },
    ],
    inputModalities: ['text', 'image'],
    ...overrides,
  }
}

describe('[COMP:api/codex-provider] OSS Codex provider manager', () => {
  it('publishes only the reviewed intersection of registry and live account catalog', async () => {
    const harness = processHarness()
    const availability = new MutableProviderAvailability()
    const starting = startCodexProviderManager({
      availability,
      startProcess: vi.fn(async () => harness.process),
    })

    const accountRead = await waitForMethod(harness, 'account/read')
    respond(harness, accountRead, {
      account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    })
    const modelList = await waitForMethod(harness, 'model/list')
    respond(harness, modelList, {
      data: [
        catalogModel('gpt-5.6-sol'),
        catalogModel('gpt-5.6-terra'),
        catalogModel('future-unreviewed-model'),
      ],
      nextCursor: null,
    })
    const manager = await starting

    expect(availability.has('openai-codex')).toBe(true)
    expect(availability.isModelAvailable('openai-codex', 'gpt-5.6-sol')).toBe(true)
    expect(availability.isModelAvailable('openai-codex', 'future-unreviewed-model')).toBe(false)
    expect(manager.provider.models).toContain('gpt-5.6-sol')

    const statusPromise = manager.status()
    const statusAccount = await waitForMethod(harness, 'account/read', 1)
    respond(harness, statusAccount, {
      account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    })
    const statusModels = await waitForMethod(harness, 'model/list', 1)
    respond(harness, statusModels, {
      data: [catalogModel('gpt-5.6-terra')],
      nextCursor: null,
    })
    await expect(statusPromise).resolves.toMatchObject({
      runtimeAvailable: true,
      account: { connected: true, emailHint: 'o***@example.com', planType: 'plus' },
      models: [{ model: 'gpt-5.6-terra' }],
    })
    expect(availability.isModelAvailable('openai-codex', 'gpt-5.6-sol')).toBe(false)

    const revokedStatus = manager.status()
    const revokedAccount = await waitForMethod(harness, 'account/read', 2)
    respond(harness, revokedAccount, { malformed: true })
    await expect(revokedStatus).resolves.toMatchObject({
      runtimeAvailable: true,
      account: { connected: false },
      models: [],
    })
    expect(availability.has('openai-codex')).toBe(false)
    await manager.close()
  })

  it('keeps the runtime available for login while the account is disconnected', async () => {
    const harness = processHarness()
    const availability = new MutableProviderAvailability()
    const starting = startCodexProviderManager({
      availability,
      startProcess: vi.fn(async () => harness.process),
    })
    const accountRead = await waitForMethod(harness, 'account/read')
    respond(harness, accountRead, { account: null, requiresOpenaiAuth: true })
    const manager = await starting

    expect(availability.has('openai-codex')).toBe(false)
    const loginPromise = manager.startDeviceCodeLogin()
    const loginRequest = await waitForMethod(harness, 'account/login/start')
    respond(harness, loginRequest, {
      type: 'chatgptDeviceCode',
      loginId: 'device-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })
    await expect(loginPromise).resolves.toMatchObject({
      loginId: 'device-1',
      userCode: 'ABCD-1234',
    })
    await manager.close()
  })

  it('clears entitlement and restarts the process once after an unexpected close', async () => {
    const first = processHarness()
    const second = processHarness()
    const availability = new MutableProviderAvailability()
    const startProcess = vi
      .fn()
      .mockResolvedValueOnce(first.process)
      .mockResolvedValueOnce(second.process)
    const starting = startCodexProviderManager({
      availability,
      startProcess,
      restartBackoffMs: 1,
    })
    const firstAccount = await waitForMethod(first, 'account/read')
    respond(first, firstAccount, { account: null, requiresOpenaiAuth: true })
    const manager = await starting

    first.peer.close(new CodexRpcClosedError('crash'))
    const secondAccount = await waitForMethod(second, 'account/read')
    respond(second, secondAccount, { account: null, requiresOpenaiAuth: true })
    await vi.waitFor(() => expect(startProcess).toHaveBeenCalledTimes(2))
    expect(availability.has('openai-codex')).toBe(false)
    await manager.close()
  })

  it('persists and publishes the preferred OSS provider without exposing config data', async () => {
    const harness = processHarness()
    const availability = new MutableProviderAvailability()
    const savePreferredProvider = vi.fn(async () => {})
    const starting = startCodexProviderManager({
      availability,
      savePreferredProvider,
      startProcess: vi.fn(async () => harness.process),
    })
    const accountRead = await waitForMethod(harness, 'account/read')
    respond(harness, accountRead, { account: null, requiresOpenaiAuth: true })
    const manager = await starting

    await manager.setPreferredProvider('openai-codex')

    expect(savePreferredProvider).toHaveBeenCalledWith('openai-codex')
    expect(availability.preferredProvider).toBe('openai-codex')
    const status = manager.status()
    const statusAccount = await waitForMethod(harness, 'account/read', 1)
    respond(harness, statusAccount, { account: null, requiresOpenaiAuth: true })
    await expect(status).resolves.toMatchObject({
      preferredProvider: 'openai-codex',
      account: { connected: false },
    })
    await manager.close()
  })

  it('keeps recovery and preference controls alive when the runtime cannot start', async () => {
    const availability = new MutableProviderAvailability()
    const savePreferredProvider = vi.fn(async () => {})
    const startProcess = vi.fn(async () => {
      throw new Error('binary unavailable')
    })
    const manager = await startCodexProviderManager({
      availability,
      savePreferredProvider,
      startProcess,
    })

    await expect(manager.status()).resolves.toMatchObject({
      runtimeAvailable: false,
      account: { connected: false },
      models: [],
    })
    await manager.setPreferredProvider('gemini')

    expect(savePreferredProvider).toHaveBeenCalledWith('gemini')
    expect(availability.preferredProvider).toBe('gemini')
    expect(startProcess).toHaveBeenCalledTimes(2)
    await manager.close()
  })
})
