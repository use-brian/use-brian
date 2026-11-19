import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { feedGenerationRequestSchema, feedGenerationEstimateRequestSchema, type FeedPlaceholderAttrs } from '@use-brian/shared'
import { feedParagraph } from '@use-brian/doc-model'
import { generationPrompt, parseFeedTextCandidates, type FeedGenerationContext } from '../generation.js'
import { createFeedGenerationPort } from '../generation-port.js'
import { summarizeFeedRun, type FeedEditorialRun } from '../../db/feed-editorial-runs-store.js'
const slot: FeedPlaceholderAttrs = { id: randomUUID(), kind: 'text', brief: 'Explain orchard irrigation.', briefRevision: 1, references: [] }
const segmentId = randomUUID()
const context = { slot, segmentId, request: { mutationId: randomUUID(), expectedRevision: 2, segmentId, slotId: slot.id, count: 2, model: 'standard', locale: 'en' }, content: { schemaVersion: 2, title: 'Fixture', privateBrief: 'Use concrete examples.', composition: { version: 1, segments: [{ id: segmentId, content: [feedParagraph('Opening.'), { type: 'generationPlaceholder', attrs: slot }] }] } }, sources: [], omissions: [] } as unknown as FeedGenerationContext
const run = { id: randomUUID(), revision: 2, context } as FeedEditorialRun

describe('[COMP:feed/draft-generation] estimate and candidate contract', () => {
  it('scenarios 4 and 8: requires explicit confirmation and bounded typed candidate counts', () => {
    expect(feedGenerationRequestSchema.safeParse({ mutationId: randomUUID(), estimateId: randomUUID(), confirmed: false }).success).toBe(false)
    expect(feedGenerationEstimateRequestSchema.safeParse({ ...context.request, count: 6 }).success).toBe(false)
    expect(feedGenerationRequestSchema.safeParse({ mutationId: randomUUID(), estimateId: randomUUID(), confirmed: true, price: 0 }).success).toBe(false)
  })
  it('scenario 4: creates stable typed slot replacements without mutating accepted composition', () => {
    const before = JSON.stringify(context.content)
    const candidates = parseFeedTextCandidates(JSON.stringify({ candidates: [{ markdown: '**Measured** irrigation.\n\nA second paragraph.', rationale: 'Uses a concrete claim for review.' }] }), run)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ runId: run.id, slotId: slot.id, briefRevision: 1, sourceRevision: 2 })
    const edit = candidates[0]!.edits[0]!
    expect(edit.kind).toBe('replaceBlock')
    if (edit.kind === 'replaceBlock') { expect(edit.preimage).toEqual({ type: 'generationPlaceholder', attrs: slot }); expect(edit.replacement[0]!.attrs.id).toBe(slot.id); expect(edit.replacement).toHaveLength(2) }
    expect(JSON.stringify(context.content)).toBe(before)
  })
  it('scenario 8: refuses empty, malformed and over-count results without retrying a provider', () => {
    for (const text of ['not json', '{"candidates":[]}', '{"candidates":[{"markdown":"","rationale":""}]}', JSON.stringify({ candidates: [1, 2, 3].map(() => ({ markdown: 'Draft.', rationale: '' })) })]) expect(() => parseFeedTextCandidates(text, run)).toThrow()
  })
  it('scenario 8: projects an internally uncertain image iteration as failed', () => {
    const imageSlot = { ...slot, kind: 'image' as const }
    const imageRun = { ...run, kind: 'image_generation', status: 'unknown_outcome', attempts: 1, error: 'generation_transport_failed', createdAt: new Date(0), coverage: {}, summaryThreadId: null, model: 'fixture-image', context: { ...context, slot: imageSlot, estimate: { slot: imageSlot } } } as FeedEditorialRun
    expect(summarizeFeedRun(imageRun)).toMatchObject({ kind: 'image_generation', status: 'failed', attempts: 1, error: 'generation_transport_failed' })
    expect(summarizeFeedRun({ ...imageRun, kind: 'text_generation', context } as FeedEditorialRun).status).toBe('unknown_outcome')
  })
  it('scenario 8: excludes whole oversized sources and rejects an oversized required outline', () => {
    const bounded = generationPrompt({ ...context, sources: [{ id: 'oversized', title: 'Notes', body: 'x'.repeat(50_000), hash: 'hash' }] }, 40_000)
    expect(bounded.sources).toHaveLength(0); expect(bounded.omissions).toContain('oversized:input_limit')
    expect(() => generationPrompt(context, 10)).toThrow('generation_context_too_large')
  })
  it('scenario 8: resolves text without calling it and reports unpriced BYO honestly', async () => {
    const call = vi.fn(); const port = createFeedGenerationPort(async () => ({ model: 'custom-fixture', tier: 'standard', providerKeySource: 'user', inputCharacters: 20_000, maxTokens: 6000, call }))
    const resolved = await port.resolve({ workspaceId: randomUUID(), userId: randomUUID(), assistantId: randomUUID(), sessionId: randomUUID() }, 'text', 'standard')
    expect(resolved.price(100)).toMatchObject({ maximumUsd: null, billing: 'byo', currency: 'USD' }); expect(call).not.toHaveBeenCalled()
  })
})

import type { FilesApi } from '@use-brian/core/workspace-files/api.js'
import { aiStudioTransport, vertexTransport } from '@use-brian/agent-runtime/providers/google-transport.js'
import { FEED_IMAGE_CAPABILITY } from '@use-brian/shared'
describe('[COMP:feed/draft-generation] configured image execution', () => {
  it('scenario 4: quotes workspace BYO without calling the provider and records zero platform COGS', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 0 } })))
    const recordUsage = vi.fn(async () => undefined); const quote = vi.fn(() => 5)
    const port = createFeedGenerationPort(async () => { throw new Error('No text model') }, { files: {} as FilesApi, resolveWorkspaceKey: async () => 'fixture-workspace-key', transport: aiStudioTransport('fixture-platform-key'), fetcher, usageStore: { recordUsage } as never, billing: { quote, available: async () => 10, settle: vi.fn() } })
    const resolved = await port.resolve({ workspaceId: randomUUID(), userId: randomUUID(), assistantId: randomUUID(), sessionId: randomUUID() }, 'image', 'standard')
    expect(resolved.model).toBe(FEED_IMAGE_CAPABILITY.model); expect(resolved.price(100)).toMatchObject({ billing: 'byo', rateVersion: FEED_IMAGE_CAPABILITY.rates.version }); expect(quote).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    const response = await resolved.call({ prompt: 'Square', systemPrompt: 'One image', signal: AbortSignal.timeout(1000) })
    expect(response.imageReceipt?.error).toBe('image_refused'); expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ actualCostUsd: 0, providerKeySource: 'user' })); expect(fetcher.mock.calls).toHaveLength(1)
  })
  it('scenario 8: refuses unpriced Vertex without falling back to a workspace AI Studio key', async () => {
    const key = vi.fn(async () => 'fixture-key')
    const port = createFeedGenerationPort(async () => { throw new Error('No text model') }, { files: {} as FilesApi, resolveWorkspaceKey: key, transport: vertexTransport({ project: 'fixture-project', location: 'asia-east2', tokenSource: async () => 'fixture-token' }) })
    await expect(port.resolve({ workspaceId: randomUUID(), userId: randomUUID(), assistantId: randomUUID(), sessionId: randomUUID() }, 'image', 'standard')).rejects.toMatchObject({ code: 'image_generation_unavailable' }); expect(key).not.toHaveBeenCalled()
  })
})


describe('[COMP:feed/draft-generation] explicit Codex selection', () => {
  const actor = { workspaceId: randomUUID(), userId: randomUUID(), assistantId: randomUUID(), sessionId: randomUUID() }
  it('quotes subscription quota without dispatch, leaves text routing independent, and never charges Brian credits', async () => {
    const codex = { inspect: vi.fn(async () => ({ model: 'gpt-image-2', orchestratorModel: 'gpt-5.6-sol', identity: 'account-one' })),
      generate: vi.fn(async () => ({ error: 'image_provider_rejected' as const, usage: { inputTokens: 0, outputTokens: 0, measured: false } })) }
    const fetcher = vi.fn(); const quote = vi.fn(); const recordUsage = vi.fn(async () => undefined)
    const text = vi.fn(async () => ({ model: 'fixture-text', tier: 'standard', providerKeySource: 'user' as const, inputCharacters: 1000, maxTokens: 1000, call: vi.fn() }))
    const port = createFeedGenerationPort(text, { files: {} as FilesApi, codex, fetcher, transport: aiStudioTransport('fixture-key'), billing: { quote, available: vi.fn(), settle: vi.fn() }, usageStore: { recordUsage } as never })
    expect(feedGenerationEstimateRequestSchema.parse({ ...context.request, imageProvider: 'openai-codex' }).imageProvider).toBe('openai-codex')
    expect(feedGenerationEstimateRequestSchema.safeParse({ ...context.request, imageProvider: 'unreviewed' }).success).toBe(false)
    const image = await port.resolve(actor, 'image', 'max', 'openai-codex')
    expect(image.price(100)).toEqual({ currency: 'USD', maximumUsd: null, rateVersion: 'codex-subscription:gpt-image-2', billing: 'subscription' })
    expect(codex.generate).not.toHaveBeenCalled(); expect(quote).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    await image.call({ prompt: 'One diagram', systemPrompt: 'One image', signal: AbortSignal.timeout(1000) })
    expect(codex.generate).toHaveBeenCalledTimes(1); expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ actualCostUsd: 0, providerKeySource: 'user' }))
    expect(fetcher).not.toHaveBeenCalled()
    expect((await port.resolve(actor, 'text', 'standard', 'openai-codex')).model).toBe('fixture-text')
    const first = image.identity; codex.inspect.mockResolvedValue({ model: 'gpt-image-2', orchestratorModel: 'gpt-5.6-sol', identity: 'account-two' })
    expect((await port.resolve(actor, 'image', 'standard', 'openai-codex')).identity).not.toBe(first)
  })
  it('never falls back to configured Gemini when Codex is absent or disconnected', async () => {
    const fetcher = vi.fn(); const options = { files: {} as FilesApi, fetcher, transport: aiStudioTransport('fixture-key') }
    await expect(createFeedGenerationPort(vi.fn(), options).resolve(actor, 'image', 'standard', 'openai-codex')).rejects.toMatchObject({ code: 'image_generation_unavailable' })
    const codex = { inspect: vi.fn().mockRejectedValue(new Error('image_generation_unavailable')), generate: vi.fn() }
    await expect(createFeedGenerationPort(vi.fn(), { ...options, codex }).resolve(actor, 'image', 'standard', 'openai-codex')).rejects.toThrow('image_generation_unavailable')
    expect(fetcher).not.toHaveBeenCalled(); expect(codex.generate).not.toHaveBeenCalled()
  })
})
