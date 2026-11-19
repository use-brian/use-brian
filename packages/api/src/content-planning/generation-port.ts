/** Configured generation providers and cheap, bounded reference reads. [COMP:feed/draft-generation] */
import type { FilesApi, FilesContext } from '@use-brian/core/workspace-files/api.js'
import { calculateCost, type UsageStore } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import type { CodexImageProvider } from '@use-brian/agent-runtime/providers/codex-app-server/image.js'
import { createGeminiImageProvider, validateFeedImageSource, type GeneratedImageReceipt } from '@use-brian/agent-runtime/providers/gemini-image.js'
import { aiStudioTransport, type GoogleTransport } from '@use-brian/agent-runtime/providers/google-transport.js'
import { FEED_IMAGE_CAPABILITY, feedImageCost, type FeedImageConfig, type FeedMedia } from '@use-brian/shared'
import { withFeedTransaction, FeedCollaborationError, type FeedActor } from '../db/feed-collaboration-store.js'
import { editorialActor, type FeedEditorialRun } from '../db/feed-editorial-runs-store.js'
import { registryRow } from '@use-brian/shared/model-registry'
import { FEED_GENERATION_LIMITS, type FeedGenerationPrice, type FeedPlaceholderAttrs } from '@use-brian/shared'
import type { FeedEditorialModel, FeedEditorialModelResolver, FeedModelIdentity } from './editorial-model.js'
import { feedEditorialHash } from '../db/feed-editorial-runs-store.js'
import { query } from '../db/client.js'
import type { FeedGenerationContext } from './generation.js'
import { readFeedSelectedSources, feedSelectedFiles } from './source-authority.js'
import { createPublicCustomLlmFetch } from '../custom-llm-public-fetch.js'
export type FeedGenerationImage = { fileId: string; hash: string; inputTokens: number; image: NonNullable<GeneratedImageReceipt['image']> }
export type FeedGenerationSource = { id: string; title: string; body: string; hash: string }
export type FeedGenerationResolved = Omit<FeedEditorialModel, 'call'> & { identity: string; price(inputCharacters: number): FeedGenerationPrice; call(input: Parameters<FeedEditorialModel['call']>[0] & { slot?: FeedPlaceholderAttrs; sourceImage?: NonNullable<GeneratedImageReceipt['image']> }): Promise<{ text: string; imageReceipt?: GeneratedImageReceipt; usage?: unknown }> }
export type FeedGenerationPort = {
  readImage?: (actor: FeedActor, fileId: string) => Promise<FeedGenerationImage>;
  billing?: FeedGenerationBilling;
  persistImage?: (run: FeedEditorialRun, receipt: GeneratedImageReceipt) => Promise<FeedMedia>;
  resolve(actor: FeedModelIdentity, kind: 'text' | 'image', tier: string, imageProvider?: 'gemini' | 'openai-codex'): Promise<FeedGenerationResolved>;
  readReference(ref: FeedPlaceholderAttrs['references'][number]): Promise<{ source?: FeedGenerationSource; omission?: string }>;
}
export function createFeedGenerationPort(resolveText: FeedEditorialModelResolver, image: FeedImagePortOptions = {}): FeedGenerationPort {
  return {
    billing: image.billing,
    readImage: (actor, fileId) => readFeedGenerationImage(image, actor, fileId),
    persistImage: (run, receipt) => persistFeedImage(image, run, receipt),
    async resolve(actor, kind, tier, imageProvider) {
      if (kind === 'image') return imageProvider === 'openai-codex' ? resolveCodexFeedImage(image, actor) : resolveFeedImage(image, actor)
      const model = await resolveText(actor, tier); const rates = registryRow(model.model)?.rates
      const identity = feedEditorialHash({ model: model.model, tier: model.tier, maxTokens: model.maxTokens, inputCharacters: model.inputCharacters, rates, keySource: model.providerKeySource })
      return { ...model, identity, price(inputCharacters) {
        return { currency: 'USD', maximumUsd: rates ? calculateCost(model.model, { inputTokens: inputCharacters, outputTokens: model.maxTokens }) : null,
          rateVersion: `text-registry:${feedEditorialHash(rates ?? 'unpriced')}`, billing: model.providerKeySource === 'user' ? 'byo' : 'included' }
      } }
    },
    readReference: readFeedGenerationReference,
  }
}
const publicFetch = createPublicCustomLlmFetch()
/** File authority is checked by the caller before and after this read. */
export async function readFeedGenerationReference(ref: FeedPlaceholderAttrs['references'][number]) {
  if ('fileId' in ref) {
    const total = Number((await query('SELECT coalesce(sum(length(content)),0) AS size FROM file_segments WHERE file_id=$1', [ref.fileId])).rows[0].size)
    if (!total || total > FEED_GENERATION_LIMITS.referenceBytes) return { omission: `file:${ref.fileId}:${total ? 'reference_too_large' : 'indexed_text_unavailable'}` }
    const rows = (await query('SELECT content FROM file_segments WHERE file_id=$1 ORDER BY segment_index', [ref.fileId])).rows
    const body = rows.map(row => row.content).join('\n')
    return { source: { id: `file:${ref.fileId}`, title: 'Indexed reference passages', body, hash: feedEditorialHash(body) }, omission: `file:${ref.fileId}:indexed_passages_only` }
  }
  try {
    let url = new URL(ref.url); const signal = AbortSignal.timeout(10_000)
    for (let hop = 0; hop < 4; hop++) {
      if (url.username || url.password) break
      // Shared transport pins a validated public address; redirects get a new
      // validation. No cookies, credentials or paid reader fallback are sent.
      const response = await publicFetch(url, { signal, headers: { Accept: 'text/plain,text/html,application/json' }, redirect: 'manual' })
      if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); const location = response.headers.get('location'); if (!location) break; url = new URL(location, url); continue }
      if (!response.ok || !response.body || !/text\/(plain|html)|application\/(json|xhtml\+xml)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); break }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > FEED_GENERATION_LIMITS.referenceBytes) { await reader.cancel(); return { omission: `url:${ref.url}:reference_too_large` } } chunks.push(part.value) }
      let body = Buffer.concat(chunks).toString('utf8')
      if (/html/i.test(response.headers.get('content-type') ?? '')) body = body.replace(/<(script|style|nav)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim()
      if (!body) break
      return { source: { id: `url:${ref.url}`, title: ref.url, body, hash: feedEditorialHash(body) } }
    }
  } catch { /* A missing or denied source is visible before confirmation. */ }
  return { omission: `url:${ref.url}:reference_unavailable` }
}

export type FeedGenerationBilling = {
  quote(maximumUsd: number): number;
  available(workspaceId: string): Promise<number | null>;
  settle(input: { workspaceId: string; userId: string; runId: string; model: string; actualCostUsd: number }): Promise<void>;
}
export type FeedImagePortOptions = {
  codex?: CodexImageProvider;
  transport?: GoogleTransport;
  resolveWorkspaceKey?: (workspaceId: string) => Promise<string | null>;
  config?: FeedImageConfig;
  files?: FilesApi;
  usageStore?: UsageStore;
  billing?: FeedGenerationBilling;
  /** Transport-only fixture seam; no synthetic storage or authority. */
  fetcher?: typeof fetch;
}
function imageConfig(options: FeedImagePortOptions): FeedImageConfig | null {
  const config = options.config ?? (options.transport?.kind === 'vertex' ? null : { model: FEED_IMAGE_CAPABILITY.model, rates: FEED_IMAGE_CAPABILITY.rates, transport: 'ai-studio' as const })
  if (!config || !/^[a-zA-Z0-9._-]+$/.test(config.model) || !config.rates.version || ![config.rates.inputPerMillion, config.rates.textPerMillion, config.rates.imagePerMillion, config.rates.imageTokens].every(value => Number.isFinite(value) && value > 0)) return null
  return config
}
async function resolveFeedImage(options: FeedImagePortOptions, actor: FeedModelIdentity): Promise<FeedGenerationResolved> {
  const config = imageConfig(options)
  if (!config || !options.files) throw new FeedCollaborationError(503, 'image_generation_unavailable')
  // Vertex is a deployment authority boundary, never a fallback suggestion.
  const key = options.transport?.kind === 'vertex' ? null : await options.resolveWorkspaceKey?.(actor.workspaceId)
  const transport = key ? aiStudioTransport(key) : options.transport
  if (!transport || transport.kind !== config.transport) throw new FeedCollaborationError(503, 'image_generation_unavailable')
  const headers = await transport.headers()
  if (transport.kind === 'ai-studio' && !headers['x-goog-api-key']) throw new FeedCollaborationError(503, 'image_generation_unavailable')
  const byok = Boolean(key); const identity = feedEditorialHash({ config, transport: transport.endpoint(config.model, 'generateContent'), credential: transport.kind === 'vertex' ? 'deployment' : feedEditorialHash(headers) })
  return { model: config.model, tier: 'image', providerKeySource: byok ? 'user' : 'platform', identity, inputCharacters: FEED_IMAGE_CAPABILITY.inputCharacters, maxTokens: FEED_IMAGE_CAPABILITY.outputTokens,
    price(inputCharacters) { const maximumUsd = feedImageCost(config.rates, inputCharacters, FEED_IMAGE_CAPABILITY.outputTokens); return { currency: 'USD', maximumUsd, rateVersion: config.rates.version, billing: byok ? 'byo' : options.billing ? 'metered' : 'included', ...(!byok && options.billing ? { credits: options.billing.quote(maximumUsd) } : {}) } },
    async call(input) {
      const imageReceipt = await createGeminiImageProvider(transport, options.fetcher).generate({ model: config.model, prompt: `${input.systemPrompt}\n\n${input.prompt}`, aspectRatio: input.slot?.aspectRatio, sourceImage: input.sourceImage, signal: input.signal })
      const actualCostUsd = imageReceipt.status && imageReceipt.status >= 400 && imageReceipt.status < 500 ? 0 : feedImageCost(config.rates, imageReceipt.usage.inputTokens, imageReceipt.usage.outputTokens, imageReceipt.usage.imageTokens)
      let usageRecorded = !options.usageStore
      if (options.usageStore) { try { await options.usageStore.recordUsage({ userId: actor.userId, assistantId: actor.assistantId, sessionId: actor.sessionId, model: config.model, modelTier: 'standard', inputTokens: imageReceipt.usage.inputTokens, outputTokens: imageReceipt.usage.outputTokens, actualCostUsd: byok ? 0 : actualCostUsd, source: 'included', triggerKey: 'feed_image_generation', providerKeySource: byok ? 'user' : 'platform' }); usageRecorded = true } catch { /* Keep measured usage in the durable receipt. */ } }
      return { text: '', imageReceipt, usage: { ...imageReceipt.usage, actualCostUsd, model: config.model, providerKeySource: byok ? 'user' : 'platform', usageRecorded } }
    },
  }
}
async function resolveCodexFeedImage(options: FeedImagePortOptions, actor: FeedModelIdentity): Promise<FeedGenerationResolved> {
  if (!options.codex || !options.files) throw new FeedCollaborationError(503, 'image_generation_unavailable')
  const snapshot = await options.codex.inspect()
  return { model: snapshot.model, tier: 'image', providerKeySource: 'user',
    identity: feedEditorialHash({ provider: 'openai-codex', ...snapshot }),
    inputCharacters: FEED_IMAGE_CAPABILITY.inputCharacters, maxTokens: FEED_IMAGE_CAPABILITY.outputTokens,
    price() { return { currency: 'USD', maximumUsd: null, rateVersion: `codex-subscription:${snapshot.model}`, billing: 'subscription' } },
    async call(input) {
      const imageReceipt = await options.codex!.generate({ snapshot, prompt: `${input.systemPrompt}\n\n${input.prompt}`, sourceImage: input.sourceImage, signal: input.signal })
      let usageRecorded = !options.usageStore
      if (options.usageStore) { try {
        await options.usageStore.recordUsage({ userId: actor.userId, assistantId: actor.assistantId, sessionId: actor.sessionId,
          model: snapshot.model, modelTier: 'standard', inputTokens: 0, outputTokens: 0, actualCostUsd: 0,
          source: 'included', triggerKey: 'feed_image_generation', providerKeySource: 'user' }); usageRecorded = true
      } catch { /* Durable receipt retains unmeasured subscription usage. */ } }
      return { text: '', imageReceipt, usage: { ...imageReceipt.usage, actualCostUsd: 0, model: snapshot.model,
        orchestratorModel: snapshot.orchestratorModel, provider: 'openai-codex', providerKeySource: 'user', billing: 'subscription', usageRecorded } }
    },
  }
}
async function persistFeedImage(options: FeedImagePortOptions, run: FeedEditorialRun, receipt: GeneratedImageReceipt): Promise<FeedMedia> {
  if (!receipt.image || receipt.error) throw new FeedCollaborationError(422, receipt.error ?? 'image_missing')
  if (!options.files) throw new FeedCollaborationError(503, 'image_storage_unavailable')
  const actor = editorialActor(run); const context = run.context as FeedGenerationContext
  const authority = await withFeedTransaction(actor, async (client, scope) => {
    const publicAudience = (await client.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND clearance='public' LIMIT 1", [scope.workspaceId])).rowCount
    const sourceFiles = [...feedSelectedFiles(context.content.composition).keys(), ...(context.baseImage ? [context.baseImage.fileId] : [])]
    const ids = (kind: string) => context.sources.filter(source => source.id.startsWith(`${kind}:`)).map(source => source.id.split(':')[1]!)
    const rows = (await client.query<{ sensitivity: FilesContext['clearance']; compartments: string[]; project_ids: string[] }>(`
      SELECT sensitivity,compartments,project_ids FROM workspace_files WHERE workspace_id=$1 AND id=ANY($2::uuid[])
      UNION ALL SELECT sensitivity,compartments,project_ids FROM memories WHERE workspace_id=$1 AND id=ANY($3::uuid[])
      UNION ALL SELECT decision_sensitivity AS sensitivity,'{}'::text[] AS compartments,'{}'::uuid[] AS project_ids FROM assistant_playbook_rules WHERE assistant_id=$4 AND id=ANY($5::uuid[])
      UNION ALL SELECT sensitivity,'{}'::text[] AS compartments,'{}'::uuid[] AS project_ids FROM workspace_brands WHERE workspace_id=$1 AND id=ANY($6::uuid[])`, [scope.workspaceId, sourceFiles, ids('memory'), run.assistantId, ids('playbook'), ids('brand')])).rows
    const ranks = ['public', 'internal', 'confidential', 'restricted']
    const baseline = Math.max(ranks.indexOf(context.content.sourceSensitivity ?? 'public'), publicAudience || scope.clearance === 'public' ? 0 : 1)
    const sensitivity = ranks[Math.max(baseline, ...rows.map(row => ranks.indexOf(row.sensitivity ?? 'internal')))] as NonNullable<FilesContext['clearance']>
    return { sensitivity, compartments: [...new Set([...(context.content.sourceCompartments ?? []), ...rows.flatMap(row => row.compartments ?? [])])], projectIds: [...new Set([...(context.content.sourceProjectIds ?? []), ...rows.flatMap(row => row.project_ids ?? [])])] }
  })
  const ctx: FilesContext = { workspaceId: run.workspaceId, userId: run.actorUserId, assistantId: null, assistantKind: 'standard', clearance: authority.sensitivity, writeCompartments: authority.compartments, writeProjectIds: authority.projectIds }

  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[receipt.image.mimeType]
  const path = `/doc/feed/${run.sessionId}/${run.id}.${ext}`
  let file = await options.files.stat(ctx, path)
  if (!file.ok) {
    file = await options.files.writeBytes(ctx, { path, bytes: Buffer.from(receipt.image.data, 'base64'), mime: receipt.image.mimeType, sensitivity: authority.sensitivity, tags: ['draft', 'feed-generated'] })
    if (!file.ok && file.error.kind === 'conflict') file = await options.files.stat(ctx, path)
  }
  if (!file.ok) throw new FeedCollaborationError(503, 'image_storage_unavailable')
  if (file.value.mime !== receipt.image.mimeType || file.value.sizeBytes !== Buffer.from(receipt.image.data, 'base64').length) throw new FeedCollaborationError(409, 'generation_file_conflict')
  const stored = await options.files.readBytes(ctx, file.value.id)
  if (!stored.ok || feedEditorialHash(Buffer.from(stored.value.bytes).toString('base64')) !== feedEditorialHash(receipt.image.data)) throw new FeedCollaborationError(409, 'generation_file_conflict')
  const tagged = await options.files.setMeta(ctx, file.value.id, { metadata: { ...file.value.metadata, feedGeneration: { runId: run.id, sessionId: run.sessionId, slotId: context.slot.id, sourceRevision: run.revision, providerResponseId: receipt.responseId ?? null } } })
  if (!tagged.ok) throw new FeedCollaborationError(409, 'generation_file_conflict')
  return { fileId: file.value.id, mimeType: receipt.image.mimeType, alt: context.slot.altIntent ?? '' }
}

/** This exact selected-resource read never raises the assistant's ambient clearance. */
async function readFeedGenerationImage(options: FeedImagePortOptions, actor: FeedActor, fileId: string): Promise<FeedGenerationImage> {
  if (!options.files) throw new FeedCollaborationError(503, 'image_storage_unavailable')
  const ctx = await withFeedTransaction(actor, async (client, scope): Promise<FilesContext> => {
    const source = (await readFeedSelectedSources(client, actor, scope, 'file', [fileId]))[0]
    if (!source) throw new FeedCollaborationError(403, 'file_not_available_to_draft')
    return { workspaceId: scope.workspaceId, userId: actor.userId, assistantId: actor.assistantId, assistantKind: 'app', clearance: source.sensitivity, compartments: source.compartments, projectIds: source.projectIds }
  })
  const metadata = await options.files.stat(ctx, fileId)
  if (!metadata.ok) throw new FeedCollaborationError(403, 'file_not_available_to_draft')
  if (metadata.value.sizeBytes > FEED_IMAGE_CAPABILITY.maxSourceImageBytes || !['image/png', 'image/jpeg', 'image/webp'].includes(metadata.value.mime)) throw new FeedCollaborationError(422, 'image_source_invalid')
  const read = await options.files.readBytes(ctx, fileId)
  if (!read.ok) throw new FeedCollaborationError(403, 'file_not_available_to_draft')
  let source: Awaited<ReturnType<typeof validateFeedImageSource>>
  try { source = await validateFeedImageSource(read.value.bytes, read.value.file.mime) } catch { throw new FeedCollaborationError(422, 'image_source_invalid') }
  return { fileId, hash: feedEditorialHash(source.image), ...source }
}
