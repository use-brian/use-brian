import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { CodexCatalogClient } from '../catalog.js'
import { CodexRpcPeer } from '../rpc.js'

type Harness = {
  peer: CodexRpcPeer
  inbound: PassThrough
  outbound: Array<{ id?: number; method?: string; params?: unknown }>
}

function createHarness(): Harness {
  const inbound = new PassThrough()
  const output = new PassThrough()
  const outbound: Harness['outbound'] = []
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
  return {
    peer: new CodexRpcPeer({ input: inbound, output }),
    inbound,
    outbound,
  }
}

async function waitForOutbound(harness: Harness, count: number): Promise<void> {
  await vi.waitFor(() => expect(harness.outbound).toHaveLength(count))
}

function respond(harness: Harness, requestIndex: number, result: unknown): void {
  const request = harness.outbound[requestIndex]
  harness.inbound.write(`${JSON.stringify({ id: request.id, result })}\n`)
}

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'catalog-id',
    model: 'gpt-test',
    displayName: 'GPT Test',
    description: 'Test model',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' },
    ],
    inputModalities: ['text', 'image'],
    ...overrides,
  }
}

describe('[COMP:providers/codex-catalog] account-scoped Codex model catalog', () => {
  it('paginates, preserves effort order, and excludes hidden models by default', async () => {
    const harness = createHarness()
    const client = new CodexCatalogClient(harness.peer)
    const catalog = client.listModels()
    await waitForOutbound(harness, 1)
    expect(harness.outbound[0]).toMatchObject({
      method: 'model/list',
      params: { cursor: null, includeHidden: false, limit: 100 },
    })
    respond(harness, 0, {
      data: [
        model({ model: 'gpt-default', isDefault: true }),
        model({ model: 'gpt-hidden', id: 'hidden', hidden: true }),
      ],
      nextCursor: 'page-2',
    })

    await waitForOutbound(harness, 2)
    expect(harness.outbound[1]).toMatchObject({
      method: 'model/list',
      params: { cursor: 'page-2' },
    })
    respond(harness, 1, {
      data: [model({ model: 'gpt-fast', id: 'fast', displayName: 'GPT Fast' })],
      nextCursor: null,
    })

    await expect(catalog).resolves.toMatchObject({
      defaultModelId: 'gpt-default',
      models: [
        {
          model: 'gpt-default',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'medium', description: 'Balanced' },
          ],
        },
        { model: 'gpt-fast' },
      ],
    })
    expect((await catalog).availableModelIds).toEqual(new Set(['gpt-default', 'gpt-fast']))
    harness.peer.close()
  })

  it('can explicitly include hidden catalog rows', async () => {
    const harness = createHarness()
    const client = new CodexCatalogClient(harness.peer)
    const catalog = client.listModels({ includeHidden: true })
    await waitForOutbound(harness, 1)
    respond(harness, 0, {
      data: [model({ model: 'gpt-hidden', hidden: true })],
      nextCursor: null,
    })

    await expect(catalog).resolves.toMatchObject({
      models: [{ model: 'gpt-hidden', hidden: true }],
    })
    harness.peer.close()
  })

  it('rejects duplicate model ids across pages', async () => {
    const harness = createHarness()
    const client = new CodexCatalogClient(harness.peer)
    const catalog = client.listModels()
    await waitForOutbound(harness, 1)
    respond(harness, 0, { data: [model()], nextCursor: 'again' })
    await waitForOutbound(harness, 2)
    respond(harness, 1, {
      data: [model({ id: 'different-catalog-id' })],
      nextCursor: null,
    })

    await expect(catalog).rejects.toThrow('duplicate model id: gpt-test')
    harness.peer.close()
  })

  it('rejects repeated cursors and bounded-page exhaustion', async () => {
    const harness = createHarness()
    const client = new CodexCatalogClient(harness.peer)
    const catalog = client.listModels()
    await waitForOutbound(harness, 1)
    respond(harness, 0, { data: [], nextCursor: 'loop' })
    await waitForOutbound(harness, 2)
    respond(harness, 1, { data: [], nextCursor: 'loop' })
    await expect(catalog).rejects.toThrow('repeated a pagination cursor')
    harness.peer.close()

    const boundedHarness = createHarness()
    const boundedClient = new CodexCatalogClient(boundedHarness.peer)
    const bounded = boundedClient.listModels({ maxPages: 1 })
    await waitForOutbound(boundedHarness, 1)
    respond(boundedHarness, 0, { data: [], nextCursor: 'page-2' })
    await expect(bounded).rejects.toThrow('exceeded 1 pages')
    boundedHarness.peer.close()
  })

  it('rejects ambiguous default models and oversized page settings', async () => {
    const harness = createHarness()
    const client = new CodexCatalogClient(harness.peer)
    const catalog = client.listModels()
    await waitForOutbound(harness, 1)
    respond(harness, 0, {
      data: [
        model({ model: 'gpt-one', isDefault: true }),
        model({ model: 'gpt-two', id: 'two', isDefault: true }),
      ],
      nextCursor: null,
    })

    await expect(catalog).rejects.toThrow('multiple default models')
    await expect(client.listModels({ pageSize: 251 })).rejects.toThrow(
      'pageSize cannot exceed 250',
    )
    harness.peer.close()
  })
})
