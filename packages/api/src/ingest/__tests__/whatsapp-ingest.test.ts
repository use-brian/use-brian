/**
 * Unit tests for `createWhatsappIngestor` — the inbound-relay → Pipeline
 * B/C producer for read-only Bring-Your-Own-Number group ingest.
 *
 * Locks in the gate (the Phase 1 barrier) + routing:
 *   - un-enabled group (no rules) → drop: no episode, no batch
 *   - enabled group (group_match → scheduled) → batch event written, no
 *     inline Episode (the per-group window)
 *   - enabled group (group_match → realtime) → inline channel_window
 *     Episode + extraction, attributed to the owner
 *   - DM → drop (DMs off in v1)
 *   - bot / own-number traffic → drop
 *   - empty text → drop
 *   - channel not ingest-capable (resolveChannel → null) → drop
 *
 * [COMP:api/whatsapp-ingest]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWhatsappIngestor, type WhatsappChannelContext } from '../whatsapp-ingest.js'
import type { IngestRuleRow } from '../../db/ingest-rules-store.js'

const CI_ID = 'ci_wa_1'
const CHANNEL_ID = 'chan_wa_1'
const INTEGRATION_ID = 'cint_wa_1'
const GROUP = '120363000000000000@g.us'
const OTHER_GROUP = '120363999999999999@g.us'
const ALICE = '111@s.whatsapp.net'

/** A `group_match` rule enabling GROUP, at the given routing mode. */
function groupRule(
  mode: 'realtime' | 'scheduled',
  jid = GROUP,
): IngestRuleRow {
  return {
    id: 'r1',
    connectorInstanceId: CI_ID,
    source: 'whatsapp',
    ruleOrder: 0,
    filterType: 'group_match',
    filterParams: { values: [jid] },
    routingMode: mode,
    routingSchedule: mode === 'scheduled' ? '0 9 * * 1-5' : null,
    routingTimezone: 'UTC',
    alert: false,
    episodeSensitivity: null,
  }
}

function makeDeps(opts: {
  rules?: IngestRuleRow[]
  channel?: WhatsappChannelContext | null
} = {}) {
  const rules = opts.rules ?? []
  const channel: WhatsappChannelContext | null =
    opts.channel === undefined
      ? {
          workspaceId: 'w_1',
          connectorInstanceId: CI_ID,
          channelIntegrationId: INTEGRATION_ID,
          userId: 'u_owner',
          assistantId: null,
        }
      : opts.channel

  const ingestRulesStore = {
    listByConnectorInstance: vi.fn(),
    listByConnectorInstances: vi.fn(),
    seedDefaults: vi.fn(),
    listByConnectorInstanceSystem: vi.fn(async () => rules),
  }
  const episodes = {
    createEpisode: vi.fn(async (_actor: string, input: Record<string, unknown>) => ({
      id: 'ep_new',
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
      status: 'open',
      lastCheckpointAt: null,
      idleThresholdSecs: null,
      contentRef: input.contentRef,
      summaryText: null,
      attachments: [],
      sensitivity: input.sensitivity ?? 'internal',
      userId: input.userId,
      assistantId: input.assistantId,
      workspaceId: input.workspaceId,
      createdByUserId: input.createdByUserId,
      createdByAssistantId: input.createdByAssistantId,
      parentEpisodeId: null,
      extractionLocked: false,
      createdAt: new Date(),
    })),
  }
  const tasks = { create: vi.fn(async () => ({ id: 't_new' })) }
  const runExtraction = vi.fn(async () => ({ entities: [], edges: [], memories: [], tags: [] }))
  const appendBatchEvent = vi.fn(
    async (_arg: { workspaceId: string; ruleId: string; source: string }) => {},
  )
  const resolveChannel = vi.fn(async () => channel)
  const recordSeenGroup = vi.fn(async (_input: {
    channelIntegrationId: string
    chatJid: string
    subject?: string
  }) => {})

  return {
    deps: {
      provider: { stream: vi.fn() } as never,
      model: 'gemini-flash',
      crm: {} as never,
      entities: {} as never,
      entityLinks: {} as never,
      memories: {} as never,
      tasks: tasks as never,
      episodes: episodes as never,
      ingestRulesStore: ingestRulesStore as never,
      resolveChannel: resolveChannel as never,
      recordSeenGroup: recordSeenGroup as never,
      runExtraction: runExtraction as never,
      appendBatchEvent: appendBatchEvent as never,
      now: () => new Date('2026-05-26T08:30:00Z'),
      scheduledBatching: true,
    },
    episodes,
    runExtraction,
    appendBatchEvent,
    resolveChannel,
    recordSeenGroup,
    ingestRulesStore,
    tasks,
  }
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    channelId: CHANNEL_ID,
    chatJid: GROUP,
    senderJid: ALICE,
    senderName: 'Alice',
    messageId: 'm1',
    text: 'we shipped the v2 launch today',
    timestamp: 1_700_000_000_000,
    isGroup: true,
    ...overrides,
  }
}

describe('[COMP:api/whatsapp-ingest] createWhatsappIngestor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('drops a message from an un-enabled group — no episode, no batch (the barrier)', async () => {
    // No rules at all (default-drop): the group has not been enabled.
    const { deps, episodes, runExtraction, appendBatchEvent } = makeDeps({ rules: [] })
    const ingestor = createWhatsappIngestor(deps)
    const result = await ingestor.ingest(baseInput())
    expect(result).toBeNull()
    expect(episodes.createEpisode).not.toHaveBeenCalled()
    expect(runExtraction).not.toHaveBeenCalled()
    expect(appendBatchEvent).not.toHaveBeenCalled()
  })

  it('drops a message from a different group than the enabled one', async () => {
    // A group_match rule for OTHER_GROUP — a message in GROUP must not match.
    const { deps, episodes, appendBatchEvent } = makeDeps({ rules: [groupRule('scheduled', OTHER_GROUP)] })
    const ingestor = createWhatsappIngestor(deps)
    const result = await ingestor.ingest(baseInput())
    expect(result).toBeNull()
    expect(episodes.createEpisode).not.toHaveBeenCalled()
    expect(appendBatchEvent).not.toHaveBeenCalled()
  })

  it('writes a batch event for an enabled group (group_match → scheduled window)', async () => {
    const { deps, episodes, appendBatchEvent } = makeDeps({ rules: [groupRule('scheduled')] })
    const ingestor = createWhatsappIngestor(deps)
    const result = await ingestor.ingest(baseInput())
    expect(result).toBeNull()
    expect(episodes.createEpisode).not.toHaveBeenCalled()
    expect(appendBatchEvent).toHaveBeenCalledTimes(1)
    const [arg] = appendBatchEvent.mock.calls[0]!
    expect(arg).toMatchObject({
      workspaceId: 'w_1',
      ruleId: 'r1',
      source: 'whatsapp',
    })
  })

  it('materializes a channel_window Episode for an enabled realtime group', async () => {
    const { deps, episodes, runExtraction, appendBatchEvent } = makeDeps({ rules: [groupRule('realtime')] })
    const ingestor = createWhatsappIngestor(deps)
    const result = await ingestor.ingest(baseInput())
    expect(result).toEqual({ episodeId: 'ep_new' })
    expect(appendBatchEvent).not.toHaveBeenCalled()
    expect(episodes.createEpisode).toHaveBeenCalledTimes(1)
    const [actor, input] = episodes.createEpisode.mock.calls[0]
    expect(actor).toBe('u_owner')
    expect(input).toMatchObject({
      sourceKind: 'channel_window',
      workspaceId: 'w_1',
      userId: 'u_owner',
      createdByUserId: 'u_owner',
      status: 'open',
    })
    expect(input.sourceRef).toMatchObject({ source_kind: 'channel_window', channel_id: GROUP })
    expect(input.contentRef).toMatchObject({ kind: 'manual_paste' })
    // Content carries the sender name for attribution.
    expect((input.contentRef as { text: string }).text).toContain('Alice')
    expect(runExtraction).toHaveBeenCalledTimes(1)
  })

  it('routes realtime extraction through the workspace runtime', async () => {
    const { deps, runExtraction } = makeDeps({ rules: [groupRule('realtime')] })
    const customProvider = { stream: vi.fn() }
    const resolveLlm = vi.fn().mockResolvedValue({
      provider: customProvider,
      model: 'custom:profile-1',
      modelTier: 'standard',
      providerKeySource: 'user',
      inputTokenLimit: 32000,
      maxTokens: 4000,
    })
    await createWhatsappIngestor({ ...deps, resolveLlm }).ingest(baseInput())
    expect(resolveLlm).toHaveBeenCalledWith('w_1')
    const call = runExtraction.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>]
    expect(call[2]).toMatchObject({
      provider: customProvider,
      model: 'custom:profile-1',
      providerKeySource: 'user',
      inputTokenLimit: 32000,
      maxTokens: 4000,
      classifierModel: 'custom:profile-1',
    })
  })

  it('forwards the task store into extraction so commitments become tickets', async () => {
    // Pipeline B writes extracted tasks via deps.tasks; if the ingestor does
    // not thread it through, every task item is dropped with a console.warn.
    const { deps, runExtraction, tasks } = makeDeps({ rules: [groupRule('realtime')] })
    const ingestor = createWhatsappIngestor(deps)
    await ingestor.ingest(baseInput())
    expect(runExtraction).toHaveBeenCalledTimes(1)
    const call = runExtraction.mock.calls[0] as unknown as [unknown, unknown, { tasks?: unknown }]
    expect(call[2].tasks).toBe(tasks)
  })

  it('attributes the Episode + extraction to the channel\'s attached assistant', async () => {
    // resolveChannel resolves the channel's default assistant (one number per
    // assistant). Pipeline B's memory writer gates on a non-null assistant_id,
    // so this is what lets ingested facts land as memories.
    const channel: WhatsappChannelContext = {
      workspaceId: 'w_1',
      connectorInstanceId: CI_ID,
      channelIntegrationId: INTEGRATION_ID,
      userId: 'u_owner',
      assistantId: 'a_attached',
    }
    const { deps, episodes, runExtraction } = makeDeps({ rules: [groupRule('realtime')], channel })
    const ingestor = createWhatsappIngestor(deps)
    await ingestor.ingest(baseInput())
    const [, input] = episodes.createEpisode.mock.calls[0]
    expect(input).toMatchObject({ assistantId: 'a_attached', createdByAssistantId: 'a_attached' })
    const [episode] = runExtraction.mock.calls[0] as unknown as [{ assistantId: string | null }]
    expect(episode.assistantId).toBe('a_attached')
  })

  it('drops a direct message (DMs off in v1)', async () => {
    const { deps, appendBatchEvent, resolveChannel } = makeDeps({ rules: [groupRule('scheduled')] })
    const ingestor = createWhatsappIngestor(deps)
    const result = await ingestor.ingest(baseInput({ isGroup: false, chatJid: ALICE }))
    expect(result).toBeNull()
    expect(appendBatchEvent).not.toHaveBeenCalled()
    // Drops before even resolving the channel.
    expect(resolveChannel).not.toHaveBeenCalled()
  })

  it('drops bot / own-number traffic', async () => {
    const { deps, appendBatchEvent } = makeDeps({ rules: [groupRule('scheduled')] })
    const ingestor = createWhatsappIngestor(deps)
    const result = await ingestor.ingest(baseInput({ isBot: true }))
    expect(result).toBeNull()
    expect(appendBatchEvent).not.toHaveBeenCalled()
  })

  it('drops empty-text messages', async () => {
    const { deps, appendBatchEvent } = makeDeps({ rules: [groupRule('scheduled')] })
    const ingestor = createWhatsappIngestor(deps)
    const result = await ingestor.ingest(baseInput({ text: '   ' }))
    expect(result).toBeNull()
    expect(appendBatchEvent).not.toHaveBeenCalled()
  })

  it('drops when the channel is not ingest-capable (resolveChannel → null)', async () => {
    const { deps, appendBatchEvent, ingestRulesStore } = makeDeps({
      rules: [groupRule('scheduled')],
      channel: null,
    })
    const ingestor = createWhatsappIngestor(deps)
    const result = await ingestor.ingest(baseInput())
    expect(result).toBeNull()
    expect(appendBatchEvent).not.toHaveBeenCalled()
    // Bails before loading any rules.
    expect(ingestRulesStore.listByConnectorInstanceSystem).not.toHaveBeenCalled()
  })

  // ── isIngestChannel (responder-gate for read-only BYON) ─────────

  it('isIngestChannel → true when the channel resolves (ingest-capable + provisioned)', async () => {
    const { deps } = makeDeps({ rules: [] })
    const ingestor = createWhatsappIngestor(deps)
    expect(await ingestor.isIngestChannel('chan-1')).toBe(true)
  })

  it('isIngestChannel → false when the channel does not resolve (legacy / unknown)', async () => {
    const { deps } = makeDeps({ rules: [], channel: null })
    const ingestor = createWhatsappIngestor(deps)
    expect(await ingestor.isIngestChannel('chan-1')).toBe(false)
  })

  // ── seenChats recording (enable-list + eligibility signal) ──────

  it('records an un-enabled group into seenChats so it surfaces in the enable UI', async () => {
    // Default-drop (no rules), yet the group must still be recorded — the
    // connected-number-presence eligibility signal.
    const { deps, recordSeenGroup, appendBatchEvent } = makeDeps({ rules: [] })
    const ingestor = createWhatsappIngestor(deps)
    await ingestor.ingest(baseInput({ chatSubject: 'Team Ops' }))
    expect(recordSeenGroup).toHaveBeenCalledTimes(1)
    expect(recordSeenGroup.mock.calls[0]![0]).toEqual({
      channelIntegrationId: INTEGRATION_ID,
      chatJid: GROUP,
      subject: 'Team Ops',
    })
    // Still dropped from the brain — recording is not ingestion.
    expect(appendBatchEvent).not.toHaveBeenCalled()
  })

  it('does not record DMs, bot traffic, or unprovisioned channels', async () => {
    const dm = makeDeps({ rules: [groupRule('scheduled')] })
    await createWhatsappIngestor(dm.deps).ingest(baseInput({ isGroup: false, chatJid: ALICE }))
    expect(dm.recordSeenGroup).not.toHaveBeenCalled()

    const bot = makeDeps({ rules: [groupRule('scheduled')] })
    await createWhatsappIngestor(bot.deps).ingest(baseInput({ isBot: true }))
    expect(bot.recordSeenGroup).not.toHaveBeenCalled()

    const unprov = makeDeps({ rules: [groupRule('scheduled')], channel: null })
    await createWhatsappIngestor(unprov.deps).ingest(baseInput())
    expect(unprov.recordSeenGroup).not.toHaveBeenCalled()
  })

  it('records the group even on the enabled path (keeps the title fresh)', async () => {
    const { deps, recordSeenGroup } = makeDeps({ rules: [groupRule('scheduled')] })
    await createWhatsappIngestor(deps).ingest(baseInput())
    expect(recordSeenGroup).toHaveBeenCalledTimes(1)
  })

  it('never lets a recordSeenGroup failure block ingest', async () => {
    const { deps, appendBatchEvent } = makeDeps({ rules: [groupRule('scheduled')] })
    deps.recordSeenGroup = vi.fn(async () => {
      throw new Error('merge exploded')
    }) as never
    const result = await createWhatsappIngestor(deps).ingest(baseInput())
    // The scheduled enqueue still happened despite the recording throw.
    expect(result).toBeNull()
    expect(appendBatchEvent).toHaveBeenCalledTimes(1)
  })
})
