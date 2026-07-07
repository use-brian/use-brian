import { describe, it, expect, vi } from 'vitest'

import { AnalyticsLogger, type AnalyticsEvent, type AnalyticsStore } from '../../analytics/logger.js'
import type {
  CompanyListFilters,
  CompanyListRow,
  CompanyRecord,
  CompanyUpdateFields,
  ContactListFilters,
  ContactListRow,
  ContactRecord,
  ContactUpdateFields,
  CrmStore,
  DealListFilters,
  DealListRow,
  DealRecord,
  DealStage,
  DealUpdateFields,
} from '../../crm/types.js'
import type {
  EntityLinkCreateParams,
  EntityLinkRecord,
  EntityLinksStore,
  EntityRecord,
  EntityStore,
  GetEntityOpts,
  EntityKind,
  LinkKind,
  EdgeType,
  EntityCreateParams,
  EntityUpdateFields,
  EntityListRow,
  EntityRollup,
  EntitySupersedePatch,
} from '../../entities/types.js'
import type { MemoryRecord, MemoryStore, MemoryWithMetrics, SoulSynthesisInput } from '../../memory/types.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import type { Sensitivity } from '../../security/sensitivity.js'

import { processEpisode, type PipelineBDeps, type PipelineBEpisode, type EpisodeUpdaterPort } from '../pipeline-b.js'
import type { PlatformEngagementMetrics } from '../types.js'

// ── Mock provider (sequenced responses across multiple stream() calls) ──

function sequencedProvider(responses: string[]): LLMProvider {
  let i = 0
  return {
    name: 'mock',
    models: ['mock'],
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<StreamChunk> {
      const text = responses[Math.min(i, responses.length - 1)] ?? ''
      i++
      yield { type: 'text_delta', text } as StreamChunk
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
      } as StreamChunk
    },
  } as unknown as LLMProvider
}

function throwingProvider(): LLMProvider {
  return {
    name: 'mock',
    models: ['mock'],
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<StreamChunk> {
      throw new Error('boom')
    },
  } as unknown as LLMProvider
}

// ── Capturing fakes ─────────────────────────────────────────────────

function fakeAnalyticsStore(): { store: AnalyticsStore; events: AnalyticsEvent[] } {
  const events: AnalyticsEvent[] = []
  const store: AnalyticsStore = {
    async record(event) {
      events.push(event)
    },
    async recordBatch(batch) {
      events.push(...batch)
    },
    async getDailyReport() {
      throw new Error('not used')
    },
    async getWeeklyReport() {
      throw new Error('not used')
    },
    async pruneOldEvents() {
      throw new Error('not used')
    },
    async listErrors() {
      throw new Error('not used')
    },
    async summarizeErrors() {
      throw new Error('not used')
    },
  }
  return { store, events }
}

function makeEntity(over: Partial<EntityRecord> & Pick<EntityRecord, 'id' | 'kind' | 'displayName'>): EntityRecord {
  return {
    canonicalId: null,
    aliases: [],
    attributes: {},
    sensitivity: 'internal',
    workspaceId: 'ws-1',
    userId: 'u-1',
    assistantId: 'a-1',
    createdByUserId: 'u-1',
    createdByAssistantId: null,
    sourceEpisodeId: 'ep-1',
    source: 'extracted',
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: new Date('2026-05-14T10:00:00Z'),
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    centrality: 0,
    centralityComputedAt: null,
    createdAt: new Date('2026-05-14T10:00:00Z'),
    updatedAt: new Date('2026-05-14T10:00:00Z'),
    ...over,
  }
}

function makeContact(over: Partial<ContactRecord> & Pick<ContactRecord, 'id' | 'name'>): ContactRecord {
  return {
    workspaceId: 'ws-1',
    entityId: null,
    email: null,
    phone: null,
    companyId: null,
    tags: [],
    externalRef: {},
    createdAt: new Date('2026-05-14T10:00:00Z'),
    updatedAt: new Date('2026-05-14T10:00:00Z'),
    ...over,
  }
}

function makeCompany(over: Partial<CompanyRecord> & Pick<CompanyRecord, 'id' | 'name'>): CompanyRecord {
  return {
    workspaceId: 'ws-1',
    entityId: null,
    domain: null,
    tags: [],
    externalRef: {},
    createdAt: new Date('2026-05-14T10:00:00Z'),
    updatedAt: new Date('2026-05-14T10:00:00Z'),
    ...over,
  }
}

function makeMemory(over: Partial<MemoryRecord> & Pick<MemoryRecord, 'id' | 'summary'>): MemoryRecord {
  return {
    scope: 'user',
    detail: null,
    tags: [],
    confidence: 0.7,
    sensitivity: 'internal',
    workspaceId: 'ws-1',
    ...over,
  }
}

// ── Spied store factories ────────────────────────────────────────────

/**
 * Shared "world" state — the real api-side CRM wrapper inserts both an
 * `entities` row and a CRM-specialization row in one transaction. We
 * simulate that by letting spyCrm push entity rows into the same
 * lookup maps spyEntities reads.
 */
type World = {
  byCanonical: Map<string, EntityRecord[]>
  byName: Map<string, EntityRecord>
}

function makeWorld(): World {
  return { byCanonical: new Map(), byName: new Map() }
}

type SpyCrm = {
  store: CrmStore
  contacts: Array<{ name: string; email: string | null; externalRef: Record<string, unknown> | null }>
  companies: Array<{ name: string; domain: string | null }>
  contactReturns: ContactRecord[]
  companyReturns: CompanyRecord[]
}

function spyCrm(world?: World): SpyCrm {
  const c: SpyCrm = {
    store: {} as CrmStore,
    contacts: [],
    companies: [],
    contactReturns: [],
    companyReturns: [],
  }
  c.store = {
    async createCompany(params) {
      c.companies.push({ name: params.name, domain: params.domain ?? null })
      const rec = makeCompany({
        id: `co-${c.companies.length}`,
        name: params.name,
        domain: params.domain ?? null,
      })
      c.companyReturns.push(rec)
      if (world) {
        const entityId = `ent-co-${c.companies.length}`
        const entityRow = makeEntity({
          id: entityId,
          kind: 'company',
          displayName: params.name,
          canonicalId: params.domain ?? null,
          workspaceId: params.workspaceId,
        })
        if (params.domain) world.byCanonical.set(params.domain, [entityRow])
        world.byName.set(`${params.name}|company`, entityRow)
      }
      return rec
    },
    async getCompanyById() {
      return null
    },
    async listCompanies(_ctx, _filters: CompanyListFilters): Promise<CompanyListRow[]> {
      return []
    },
    async updateCompany(_userId: string, _id: string, _fields: CompanyUpdateFields) {
      return null
    },
    async createContact(params) {
      c.contacts.push({
        name: params.name,
        email: params.email ?? null,
        externalRef: params.externalRef ?? null,
      })
      const rec = makeContact({
        id: `con-${c.contacts.length}`,
        name: params.name,
        email: params.email ?? null,
      })
      c.contactReturns.push(rec)
      if (world) {
        const entityId = `ent-con-${c.contacts.length}`
        const entityRow = makeEntity({
          id: entityId,
          kind: 'person',
          displayName: params.name,
          canonicalId: params.email ?? null,
          workspaceId: params.workspaceId,
        })
        if (params.email) world.byCanonical.set(params.email, [entityRow])
        world.byName.set(`${params.name}|person`, entityRow)
      }
      return rec
    },
    async getContactById() {
      return null
    },
    async listContacts(_ctx, _filters: ContactListFilters): Promise<ContactListRow[]> {
      return []
    },
    async updateContact(_userId: string, _id: string, _fields: ContactUpdateFields) {
      return null
    },
    async createDeal() {
      return {} as DealRecord
    },
    async getDealById() {
      return null
    },
    async listDeals(_ctx, _filters: DealListFilters): Promise<DealListRow[]> {
      return []
    },
    async updateDeal(_userId: string, _id: string, _fields: DealUpdateFields) {
      return null
    },
    async setDealStage(_userId: string, _id: string, _stage: DealStage) {
      return null
    },
    async batchLabels() {
      return new Map<string, string>()
    },
  }
  return c
}

type SpyEntities = {
  store: EntityStore
  created: EntityCreateParams[]
  superseded: Array<{ id: string; patch: EntitySupersedePatch }>
  aliasesAdded: Array<{ entityId: string; alias: string }>
  findByCanonicalIdReturns: Map<string, EntityRecord[]>
  findByNameReturns: Map<string, EntityRecord | null>
}

function spyEntities(world?: World): SpyEntities {
  const s: SpyEntities = {
    store: {} as EntityStore,
    created: [],
    superseded: [],
    aliasesAdded: [],
    findByCanonicalIdReturns: new Map(),
    findByNameReturns: new Map(),
  }
  s.store = {
    async create(params: EntityCreateParams) {
      s.created.push(params)
      return makeEntity({
        id: `ent-${s.created.length}`,
        kind: params.kind,
        displayName: params.displayName,
        canonicalId: params.canonicalId ?? null,
        attributes: params.attributes ?? {},
        sensitivity: params.sensitivity ?? 'internal',
        workspaceId: params.workspaceId,
        userId: params.userId ?? null,
        assistantId: params.assistantId ?? null,
        createdByUserId: params.createdByUserId,
        createdByAssistantId: params.createdByAssistantId ?? null,
        sourceEpisodeId: params.sourceEpisodeId ?? null,
        source: params.source,
      })
    },
    async getById(_ctx, _id: string, _opts?: { asOf?: Date }) {
      return null
    },
    async findByName(_ctx, displayName: string, opts?: { kind?: EntityKind; asOf?: Date }) {
      const key = `${displayName}|${opts?.kind ?? ''}`
      const explicit = s.findByNameReturns.get(key)
      if (explicit !== undefined) return explicit
      return world?.byName.get(key) ?? null
    },
    async findByNameSystem(_actorUserId: string, _workspaceId: string, displayName: string, opts?: { kind?: EntityKind; asOf?: Date }) {
      const key = `${displayName}|${opts?.kind ?? ''}`
      const explicit = s.findByNameReturns.get(key)
      if (explicit !== undefined) return explicit
      return world?.byName.get(key) ?? null
    },
    async findByCanonicalId(_ctx, canonicalId: string, _opts?: { asOf?: Date }) {
      const explicit = s.findByCanonicalIdReturns.get(canonicalId)
      if (explicit !== undefined) return explicit
      return world?.byCanonical.get(canonicalId) ?? []
    },
    async findByCanonicalIdSystem(_actorUserId: string, _workspaceId: string, canonicalId: string, _opts?: { asOf?: Date }) {
      const explicit = s.findByCanonicalIdReturns.get(canonicalId)
      if (explicit !== undefined) return explicit
      return world?.byCanonical.get(canonicalId) ?? []
    },
    async listForWorkspace(_ctx, _opts?: { kind?: EntityKind; limit?: number; offset?: number; asOf?: Date }): Promise<EntityListRow[]> {
      return []
    },
    async update(_actorUserId: string, _id: string, _fields: EntityUpdateFields) {
      return null
    },
    async supersedeAttributes(_actorUserId: string, id: string, patch: EntitySupersedePatch) {
      s.superseded.push({ id, patch })
      return makeEntity({
        id: `${id}-v2`,
        kind: 'company',
        displayName: 'superseded',
        attributes: patch.attributes,
        sourceEpisodeId: patch.sourceEpisodeId ?? null,
      })
    },
    async getEntity(_ctx, _idOrName: string, _opts?: GetEntityOpts): Promise<EntityRollup | null> {
      return null
    },
    async getOrCreateSelf() {
      throw new Error('getOrCreateSelf not stubbed in this test fixture')
    },
    async updateSelfProfile() {
      throw new Error('updateSelfProfile not stubbed in this test fixture')
    },
    async findDuplicateClustersSystem() {
      return []
    },
    async findCrossKindDuplicateClustersSystem() {
      return []
    },
    async listLiveEntitiesSystem() {
      return []
    },
    async addAlias(_actorUserId, entityId, alias) {
      s.aliasesAdded.push({ entityId, alias: alias.trim().toLowerCase() })
      return { kind: 'not_found' as const }
    },
    async removeAlias() {
      return null
    },
  }
  return s
}

type SpyLinks = {
  store: EntityLinksStore
  created: EntityLinkCreateParams[]
}

function spyLinks(): SpyLinks {
  const s: SpyLinks = { store: {} as EntityLinksStore, created: [] }
  s.store = {
    async create(params) {
      s.created.push(params)
      const rec: EntityLinkRecord = {
        id: `link-${s.created.length}`,
        sourceKind: params.sourceKind,
        sourceId: params.sourceId,
        targetKind: params.targetKind,
        targetId: params.targetId,
        edgeType: params.edgeType,
        attributes: params.attributes ?? {},
        source: params.source,
        verifiedByUserId: null,
        verifiedAt: null,
        validFrom: new Date('2026-05-14T10:00:00Z'),
        validTo: null,
        retractedAt: null,
        retractedReason: null,
        sourceEpisodeId: params.sourceEpisodeId ?? null,
        sensitivity: params.sensitivity ?? 'internal',
        workspaceId: params.workspaceId,
        userId: params.userId ?? null,
        assistantId: params.assistantId ?? null,
        createdAt: new Date('2026-05-14T10:00:00Z'),
      }
      return rec
    },
    async getById() {
      return null
    },
    async walkOutbound(_ctx, _sourceKind: LinkKind, _sourceId: string, _opts?: { edgeTypes?: readonly EdgeType[]; asOf?: Date; limit?: number }) {
      return []
    },
    async walkInbound(_ctx, _targetKind: LinkKind, _targetId: string, _opts?: { edgeTypes?: readonly EdgeType[]; asOf?: Date; limit?: number }) {
      return []
    },
    async countForEntity() {
      return 0
    },
    async listForWorkspace() {
      return []
    },
    async closeAt() {
      return null
    },
    async retract() {
      return null
    },
  }
  return s
}

type SpyMemories = {
  store: MemoryStore
  created: Array<Parameters<MemoryStore['create']>[0]>
}

function spyMemories(): SpyMemories {
  const s: SpyMemories = { store: {} as MemoryStore, created: [] }
  s.store = {
    async create(params) {
      s.created.push(params)
      return makeMemory({
        id: `mem-${s.created.length}`,

        scope: params.scope ?? 'shared',
        summary: params.summary,
        detail: params.detail ?? null,
        tags: params.tags ?? [],
        sensitivity: params.sensitivity,
        workspaceId: params.workspaceId ?? null,
      })
    },
    async update() {
      return null
    },
    async getById() {
      return null
    },
    async getByIdSystem() {
      return null
    },
    async search() {
      return []
    },
    async getIdentity() {
      return []
    },
    async getIndex() {
      return []
    },
    async getIndexSystem() {
      return []
    },
    async getWorkspaceIndexSystem() {
      return []
    },
    async getIndexRanked() {
      return { rows: [], totalCount: 0 }
    },
    async trackRecall() {},
    async trackRecallOutcome() {},
    async getSoul() {
      return null
    },
    async count() {
      return 0
    },
    async listWithMetrics(): Promise<MemoryWithMetrics[]> {
      return []
    },
    async writeConsolidationScore() {},
    async deleteMemory() {},
    async listCronContextCandidatesForPrune() {
      return []
    },
    async listForSoulSynthesis(): Promise<SoulSynthesisInput> {
      return { selfEntityAttributes: null, preferences: [] }
    },
    async upsertSoul() {},
    async upsertDomainSummary() {},
    async pruneStaleDomainSummaries() {
      return 0
    },
    async logConsolidation() {},
    async listMemoryUsers() {
      return []
    },
    async getLastPhaseAt() {
      return null
    },
    async hasRecentActivity() {
      return false
    },
    async getWorkspaceIdentity() {
      return []
    },
    async getWorkspaceIndex() {
      return []
    },
    async getWorkspaceMemoriesByCategory() {
      return []
    },
    async searchTeam() {
      return []
    },
    async listWorkspaceMemoryGroups() {
      return []
    },
    async listTeamWithMetrics(): Promise<MemoryWithMetrics[]> {
      return []
    },
    async getLastWorkspacePhaseAt() {
      return null
    },
    async logWorkspaceConsolidation() {},
    async listOpenCommitments() {
      return []
    },
    async listForReflection() {
      return []
    },
  }
  return s
}

type SpyEpisodes = {
  port: EpisodeUpdaterPort
  checkpointCalls: Array<{ id: string; summaryText: string | null | undefined }>
  statusCalls: Array<{ id: string; next: 'open' | 'extracting' | 'archived' }>
}

function spyEpisodes(): SpyEpisodes {
  const s: SpyEpisodes = { port: {} as EpisodeUpdaterPort, checkpointCalls: [], statusCalls: [] }
  s.port = {
    async updateCheckpoint(_actorUserId, id, patch) {
      s.checkpointCalls.push({ id, summaryText: patch.summaryText })
      return null
    },
    async updateStatus(_actorUserId, id, next) {
      s.statusCalls.push({ id, next })
      return null
    },
  }
  return s
}

// ── Episode fixture ──────────────────────────────────────────────────

function baseEpisode(over: Partial<PipelineBEpisode> = {}): PipelineBEpisode {
  return {
    id: 'ep-1',
    sourceKind: 'manual_paste',
    occurredAt: new Date('2026-05-14T10:00:00Z'),
    sensitivity: 'internal' as Sensitivity,
    workspaceId: 'ws-1',
    userId: 'u-1',
    assistantId: 'a-1',
    createdByUserId: 'u-1',
    createdByAssistantId: null,
    ...over,
  }
}

function makeDeps(over: Partial<PipelineBDeps> & { provider: LLMProvider }): PipelineBDeps {
  const crm = spyCrm()
  const entities = spyEntities()
  const links = spyLinks()
  const memories = spyMemories()
  const episodes = spyEpisodes()
  const base: PipelineBDeps = {
    provider: over.provider,
    model: 'mock',
    crm: crm.store,
    entities: entities.store,
    entityLinks: links.store,
    memories: memories.store,
    episodes: episodes.port,
  }
  return { ...base, ...over }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('[COMP:brain/pipeline-b] processEpisode', () => {
  it('writes entities (CRM-routed for person/company), edges, memories, then archives the Episode', async () => {
    // Shared world: CRM-create side-effects make the freshly-inserted entity
    // row visible to subsequent EntityStore lookups, mirroring the real
    // CRM wrapper's transactional dual-insert.
    const world = makeWorld()
    const crm = spyCrm(world)
    const entities = spyEntities(world)
    const links = spyLinks()
    const memories = spyMemories()
    const episodes = spyEpisodes()

    const extraction = JSON.stringify({
      summary: 'Sarah at Notion shipped the new blocks API; we want to integrate.',
      entities: [
        { kind: 'person', display_name: 'Sarah Lee', canonical_id: 'sarah@notion.so' },
        { kind: 'company', display_name: 'Notion', canonical_id: 'notion.so' },
        { kind: 'project', display_name: 'Blocks API integration', canonical_id: null, attributes: { quarter: 'Q3' } },
      ],
      edges: [
        { source_ref: 'Sarah Lee', target_ref: 'Notion', edge_type: 'works_at' },
      ],
      memories: [
        { scope: 'user', summary: 'Plan integration with Notion Blocks API.', detail: 'Sarah will share docs next week.', tags: ['integration'], why_not_entity: 'plan is about a workstream — Notion entity already captured', why_not_task: 'descriptive plan, not an actionable TODO' },
      ],
      tags: ['domain:product'],
    })
    const classification = JSON.stringify({
      inferred_sensitivity: 'internal',
      brief_reason: 'routine product planning',
    })

    const provider = sequencedProvider([extraction, classification])
    const deps: PipelineBDeps = {
      provider,
      model: 'mock',
      crm: crm.store,
      entities: entities.store,
      entityLinks: links.store,
      memories: memories.store,
      episodes: episodes.port,
    }

    const result = await processEpisode(baseEpisode({ preStampedTags: ['domain:engineering'] }), 'meeting notes …', deps)

    expect(result.extracted).toBe(true)
    expect(result.summaryText).toContain('Sarah at Notion')

    // CRM-routed writes.
    expect(crm.contacts).toEqual([{ name: 'Sarah Lee', email: 'sarah@notion.so', externalRef: null }])
    expect(crm.companies).toEqual([{ name: 'Notion', domain: 'notion.so' }])
    // Project went through EntityStore.create with source='extracted'.
    expect(entities.created).toHaveLength(1)
    expect(entities.created[0]).toMatchObject({
      kind: 'project',
      displayName: 'Blocks API integration',
      source: 'extracted',
      sourceEpisodeId: 'ep-1',
      sensitivity: 'internal',
      workspaceId: 'ws-1',
    })

    // Edge: works_at(Sarah → Notion) using resolved entity ids from the
    // simulated CRM-stamped entity rows.
    expect(links.created).toHaveLength(1)
    expect(links.created[0]).toMatchObject({
      sourceKind: 'entity',
      sourceId: 'ent-con-1',
      targetKind: 'entity',
      targetId: 'ent-co-1',
      edgeType: 'works_at',
      source: 'extracted',
      sourceEpisodeId: 'ep-1',
    })

    // Memory carries merged tags (pre-stamped + model + memory-local), deduped.
    expect(memories.created).toHaveLength(1)
    expect(memories.created[0].tags).toEqual(['domain:engineering', 'domain:product', 'integration'])
    expect(memories.created[0].source).toBe('extracted')
    expect(memories.created[0].sensitivity).toBe('internal')
    // WU-4.5 authorship: extracted memories carry the resolved actor's
    // identity from the episode. Regression guard — Pipeline B silently
    // dropped this field for the entire WU-4.5 lifetime, which caused
    // every extracted memory write to fail `assertAuthorshipPresent` and
    // get swallowed by the try/catch as `console.warn`.
    expect(memories.created[0].createdByUserId).toBe('u-1')
    expect(memories.created[0].createdByAssistantId).toBeNull()
    expect(memories.created[0].sourceEpisodeId).toBe('ep-1')

    // Episode updated then archived.
    expect(episodes.checkpointCalls).toEqual([{ id: 'ep-1', summaryText: result.summaryText }])
    expect(episodes.statusCalls).toEqual([{ id: 'ep-1', next: 'archived' }])

    // Final-step classifier ran (no drift; sensitivity equal channel-rule).
    expect(result.sensitivity).not.toBeNull()
    expect(result.sensitivity?.inferredSensitivity).toBe('internal')
    expect(result.sensitivity?.drifted).toBe(false)
  })

  it('does not truncate a 32k-token (~128 KB) listener window at extraction (CONTENT_CHAR_LIMIT)', async () => {
    // A raw aggregated WhatsApp window near the 32k-token early-flush bound —
    // larger than the old 16 KB cap, within the raised 128 KB one. The whole
    // window must reach the extraction prompt, untruncated.
    const line = 'Alice: ship the release before Friday and ping Bob\n'
    const big = line.repeat(2000)
    expect(big.length).toBeGreaterThan(16 * 1024)
    expect(big.length).toBeLessThanOrEqual(128 * 1024)

    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const provider = {
      name: 'mock',
      models: ['mock'],
      async *stream(req: { messages: Array<{ role: string; content: string }> }) {
        calls.push(req)
        yield { type: 'text_delta', text: JSON.stringify({ summary: '', entities: [], edges: [], memories: [], tags: [] }) } as StreamChunk
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } as StreamChunk
      },
    } as unknown as LLMProvider

    const deps = makeDeps({ provider })
    await processEpisode(baseEpisode({ sourceKind: 'channel_window' }), big, deps)

    const prompt = calls[0]!.messages[0]!.content
    // The whole window is embedded verbatim and carries no truncation marker.
    expect(prompt).toContain(big)
    expect(prompt).not.toContain('…')
  })

  it('takes the digest branch for platform_engagement_digest — writes engagement memories + edges, bypasses the LLM', async () => {
    const memories = spyMemories()
    const links = spyLinks()
    const episodes = spyEpisodes()
    // A throwing provider proves the generic extraction LLM is bypassed:
    // the digest branch (step 0a) returns before any `stream()` call.
    const deps = makeDeps({
      provider: throwingProvider(),
      memories: memories.store,
      entityLinks: links.store,
      episodes: episodes.port,
    })

    const digest: PlatformEngagementMetrics = {
      per_post: [
        { post_episode_id: 'post-ep-1', likes: 10, replies: 2 },
        { post_episode_id: 'post-ep-2', views: 500, reposts: 3 },
      ],
      aggregate: { total_engagement: 515, follower_delta: 4 },
    }

    const result = await processEpisode(
      baseEpisode({ id: 'digest-ep', sourceKind: 'platform_engagement_digest', digest }),
      '',
      deps,
    )

    // One engagement memory per post (REM input-eligible). Post-Phase-4
    // (retire-memory-type): no `type` field — the categorical signal
    // rides on tags.
    expect(memories.created).toHaveLength(2)
    expect(memories.created[0].source).toBe('extracted')
    expect(memories.created[0].tags).toEqual(['engagement', 'platform-digest'])
    // WU-4.5 authorship — same regression guard as the main extraction
    // branch. The digest branch's memory + edge write sites also dropped
    // the field before this PR.
    expect(memories.created[0].createdByUserId).toBe('u-1')
    expect(memories.created[0].sourceEpisodeId).toBe('digest-ep')

    // One platform_engagement_for edge per post: memory → post Episode.
    expect(links.created).toHaveLength(2)
    expect(links.created[0]).toMatchObject({
      sourceKind: 'memory',
      sourceId: 'mem-1',
      targetKind: 'episode',
      targetId: 'post-ep-1',
      edgeType: 'platform_engagement_for',
    })

    // Episode checkpointed with the period aggregate, then archived.
    expect(episodes.checkpointCalls[0]?.summaryText).toContain('2 post(s)')
    expect(episodes.statusCalls).toEqual([{ id: 'digest-ep', next: 'archived' }])
    expect(result).toBeTruthy()
  })

  it('skips writes and still archives when extraction is fully empty', async () => {
    const entities = spyEntities()
    const links = spyLinks()
    const memories = spyMemories()
    const episodes = spyEpisodes()

    const empty = JSON.stringify({ summary: '', entities: [], edges: [], memories: [], tags: [] })
    const provider = sequencedProvider([empty])
    const deps = makeDeps({
      provider,
      entities: entities.store,
      entityLinks: links.store,
      memories: memories.store,
      episodes: episodes.port,
    })

    const result = await processEpisode(baseEpisode(), 'ack', deps)

    expect(result.extracted).toBe(true)
    expect(result.summaryText).toBe('')
    expect(entities.created).toHaveLength(0)
    expect(links.created).toHaveLength(0)
    expect(memories.created).toHaveLength(0)

    // Episode still archived.
    expect(episodes.statusCalls).toEqual([{ id: 'ep-1', next: 'archived' }])

    // Classifier skipped — no summary + no memories.
    expect(result.sensitivity).toBeNull()
  })

  it('falls back gracefully when the LLM returns un-parseable text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entities = spyEntities()
    const links = spyLinks()
    const memories = spyMemories()
    const episodes = spyEpisodes()

    const provider = sequencedProvider(['I cannot help with that'])
    const deps = makeDeps({
      provider,
      entities: entities.store,
      entityLinks: links.store,
      memories: memories.store,
      episodes: episodes.port,
    })

    const result = await processEpisode(baseEpisode(), 'something', deps)

    expect(result.extracted).toBe(false)
    expect(result.summaryText).toBe('')
    expect(entities.created).toHaveLength(0)
    expect(links.created).toHaveLength(0)
    expect(memories.created).toHaveLength(0)

    // Failure-path still archives the Episode with an empty summary.
    expect(episodes.checkpointCalls).toEqual([{ id: 'ep-1', summaryText: '' }])
    expect(episodes.statusCalls).toEqual([{ id: 'ep-1', next: 'archived' }])

    warn.mockRestore()
  })

  it('recovers when the LLM emits a raw control character inside a string literal', async () => {
    // Regression: production logs at 2026-05-27 showed
    //   `JSON.parse failed: Bad control character in string literal in JSON at position 1225`
    // when extraction output carried e.g. an embedded vertical tab (0x0B)
    // inside a `summary` string. parseExtraction now strips ASCII control
    // bytes (other than \t\n\r) before JSON.parse.
    const memories = spyMemories()
    const episodes = spyEpisodes()
    const withControlChar =
      '{"summary":"helloworld","entities":[],"edges":[],"memories":[{"scope":"user","summary":"saved","detail":"d","tags":[],"why_not_entity":"n/a","why_not_task":"n/a"}],"tags":[]}'
    const classification = JSON.stringify({
      inferred_sensitivity: 'internal',
      brief_reason: 'ok',
    })
    const deps = makeDeps({
      provider: sequencedProvider([withControlChar, classification]),
      memories: memories.store,
      episodes: episodes.port,
    })

    const result = await processEpisode(baseEpisode(), 'something', deps)

    expect(result.extracted).toBe(true)
    expect(memories.created.map((m) => m.summary)).toContain('saved')
    expect(episodes.statusCalls).toEqual([{ id: 'ep-1', next: 'archived' }])
  })

  it('recovers when the LLM emits a trailing comma in an array', async () => {
    // Regression: production logs at 2026-05-27 showed
    //   `JSON.parse failed: Expected ',' or ']' after array element`
    // when extraction output had `[..., { ... },]`. parseExtraction now
    // strips the trailing comma before JSON.parse.
    const memories = spyMemories()
    const episodes = spyEpisodes()
    const withTrailingComma =
      '{"summary":"s","entities":[],"edges":[],"memories":[{"scope":"user","summary":"saved","detail":"d","tags":[],"why_not_entity":"n/a","why_not_task":"n/a"},],"tags":[]}'
    const classification = JSON.stringify({
      inferred_sensitivity: 'internal',
      brief_reason: 'ok',
    })
    const deps = makeDeps({
      provider: sequencedProvider([withTrailingComma, classification]),
      memories: memories.store,
      episodes: episodes.port,
    })

    const result = await processEpisode(baseEpisode(), 'something', deps)

    expect(result.extracted).toBe(true)
    expect(memories.created.map((m) => m.summary)).toContain('saved')
    expect(episodes.statusCalls).toEqual([{ id: 'ep-1', next: 'archived' }])
  })

  it('does not throw and still archives when the provider itself errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const episodes = spyEpisodes()

    const deps = makeDeps({ provider: throwingProvider(), episodes: episodes.port })

    const result = await processEpisode(baseEpisode(), 'whatever', deps)

    expect(result.extracted).toBe(false)
    expect(episodes.statusCalls).toEqual([{ id: 'ep-1', next: 'archived' }])
    warn.mockRestore()
  })

  it('skips dangling edges (one endpoint missing in the parsed entity set)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entities = spyEntities()
    const links = spyLinks()

    const extraction = JSON.stringify({
      summary: 'just a project mention',
      entities: [{ kind: 'project', display_name: 'Alpha', canonical_id: null }],
      edges: [
        // target 'Ghost' is not in entities — must be skipped.
        { source_ref: 'Alpha', target_ref: 'Ghost', edge_type: 'depends_on' },
      ],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({
      provider,
      entities: entities.store,
      entityLinks: links.store,
    })

    const result = await processEpisode(baseEpisode(), 'mentions Alpha', deps)

    expect(result.entitiesWritten).toHaveLength(1)
    expect(links.created).toHaveLength(0)
    warn.mockRestore()
  })

  it('dedups entities by canonical_id (skips CRM create when one already exists)', async () => {
    const crm = spyCrm()
    const entities = spyEntities()
    entities.findByCanonicalIdReturns.set('sarah@notion.so', [
      makeEntity({ id: 'ent-existing', kind: 'person', displayName: 'Sarah Lee', canonicalId: 'sarah@notion.so' }),
    ])

    const extraction = JSON.stringify({
      summary: 'Sarah followed up',
      entities: [{ kind: 'person', display_name: 'Sarah Lee', canonical_id: 'sarah@notion.so' }],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    const result = await processEpisode(baseEpisode(), 'follow-up', deps)

    expect(crm.contacts).toEqual([])
    expect(result.entitiesWritten).toHaveLength(1)
    expect(result.entitiesWritten[0].id).toBe('ent-existing')
  })

  it('bi-temporally supersedes an existing entity when re-extraction changes its attributes', async () => {
    const crm = spyCrm()
    const entities = spyEntities()
    entities.findByCanonicalIdReturns.set('acme.com', [
      makeEntity({
        id: 'ent-acme',
        kind: 'company',
        displayName: 'Acme',
        canonicalId: 'acme.com',
        attributes: { headcount: 50 },
      }),
    ])

    const extraction = JSON.stringify({
      summary: 'Acme doubled headcount',
      entities: [
        { kind: 'company', display_name: 'Acme', canonical_id: 'acme.com', attributes: { headcount: 120 } },
      ],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([
      extraction,
      JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' }),
    ])
    const episode = baseEpisode({ id: 'ep-acme' })
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    const result = await processEpisode(episode, 'acme update', deps)

    expect(entities.superseded).toHaveLength(1)
    expect(entities.superseded[0].id).toBe('ent-acme')
    expect(entities.superseded[0].patch.attributes).toEqual({ headcount: 120 })
    // The triggering Episode is stamped on the new row for the audit chain.
    expect(entities.superseded[0].patch.sourceEpisodeId).toBe(episode.id)
    expect(result.entitiesWritten).toHaveLength(1)
  })

  it('does not supersede an existing entity when re-extracted attributes are unchanged', async () => {
    const crm = spyCrm()
    const entities = spyEntities()
    entities.findByCanonicalIdReturns.set('acme.com', [
      makeEntity({
        id: 'ent-acme',
        kind: 'company',
        displayName: 'Acme',
        canonicalId: 'acme.com',
        attributes: { headcount: 50 },
      }),
    ])

    const extraction = JSON.stringify({
      summary: 'Acme unchanged',
      entities: [
        { kind: 'company', display_name: 'Acme', canonical_id: 'acme.com', attributes: { headcount: 50 } },
      ],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([
      extraction,
      JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' }),
    ])
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    const result = await processEpisode(baseEpisode(), 'acme noop', deps)

    expect(entities.superseded).toEqual([])
    expect(result.entitiesWritten[0].id).toBe('ent-acme')
  })

  it('logs sensitivity_drift_flagged when classifier infers a higher tier than the channel', async () => {
    const crm = spyCrm()
    const entities = spyEntities()
    const memories = spyMemories()
    const { store, events } = fakeAnalyticsStore()
    const analytics = new AnalyticsLogger(store, { flushIntervalMs: 1, maxBufferSize: 1 })

    const extraction = JSON.stringify({
      summary: 'Discussion of individual compensation packages.',
      entities: [],
      edges: [],
      memories: [
        { scope: 'user', summary: 'Compensation discussion: Sarah at $X.', tags: [], why_not_entity: 'sensitive context, not an entity attribute', why_not_task: 'past discussion, not actionable' },
      ],
      tags: [],
    })
    const classification = JSON.stringify({
      inferred_sensitivity: 'confidential',
      brief_reason: 'discusses individual compensation',
    })
    const provider = sequencedProvider([extraction, classification])
    const deps = makeDeps({
      provider,
      crm: crm.store,
      entities: entities.store,
      memories: memories.store,
      analytics,
    })

    const result = await processEpisode(baseEpisode({ sensitivity: 'internal' }), 'standup transcript', deps)
    await analytics.flush()

    expect(result.sensitivity?.drifted).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0].eventName).toBe('sensitivity_drift_flagged')
    expect(events[0].metadata).toMatchObject({
      episode_id: 'ep-1',
      inferred_sensitivity: 'confidential',
      channel_sensitivity: 'internal',
    })

    // Memory was written with the original channel sensitivity (flag-not-bump).
    expect(memories.created[0].sensitivity).toBe('internal')
  })

  it('creates a CRM contact with email=null when no email-shaped canonical_id is provided', async () => {
    const crm = spyCrm()
    const entities = spyEntities()
    // No findByName pre-seed: the (kind, display_name) dedup pass must
    // miss so the CRM create path runs. resolveCrmEntity's post-create
    // lookup will then return null, but the test only asserts that
    // createContact was invoked with the expected shape.

    const extraction = JSON.stringify({
      summary: 'Met Pat',
      entities: [{ kind: 'person', display_name: 'Pat Doe', canonical_id: null }],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    await processEpisode(baseEpisode(), 'note', deps)

    expect(crm.contacts).toEqual([{ name: 'Pat Doe', email: null, externalRef: null }])
  })

  it('stamps personExternalRefs onto a fresh contact matched case-insensitively by display_name', async () => {
    // A Slack-resolved mention: the ingestor rewrote `<@U0AQT24KHEV>` to
    // "Dustin Green" in the text and passed the id→name directory as
    // personExternalRefs. The person entity must carry the Slack id as an
    // external_ref (metadata) — never as the name.
    const crm = spyCrm()
    const entities = spyEntities()
    const extraction = JSON.stringify({
      summary: 'Dustin to review',
      entities: [{ kind: 'person', display_name: 'Dustin Green', canonical_id: null }],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    await processEpisode(
      baseEpisode({
        personExternalRefs: [
          // Case differs from the extracted display_name on purpose.
          { name: 'dustin green', externalRef: { provider: 'slack', id: 'U0AQT24KHEV', team_id: 'T1' } },
        ],
      }),
      'note',
      deps,
    )

    expect(crm.contacts).toEqual([
      {
        name: 'Dustin Green',
        email: null,
        externalRef: { provider: 'slack', id: 'U0AQT24KHEV', team_id: 'T1' },
      },
    ])
  })

  it('leaves external_ref unset for a person with no matching personExternalRefs entry', async () => {
    const crm = spyCrm()
    const entities = spyEntities()
    const extraction = JSON.stringify({
      summary: 'Met Pat',
      entities: [{ kind: 'person', display_name: 'Pat Doe', canonical_id: null }],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    await processEpisode(
      baseEpisode({
        personExternalRefs: [
          { name: 'Someone Else', externalRef: { provider: 'slack', id: 'U999' } },
        ],
      }),
      'note',
      deps,
    )

    expect(crm.contacts).toEqual([{ name: 'Pat Doe', email: null, externalRef: null }])
  })

  it('dedups entities by (kind, display_name) when canonical_id is missing — skips CRM create on a name hit', async () => {
    const crm = spyCrm()
    const entities = spyEntities()
    // Existing person in the workspace with the same display_name. The
    // canonical_id dedup pass misses (extraction emits no canonical_id),
    // but the name+kind dedup pass must hit and short-circuit the CRM
    // create path. Without this guard a fresh `contacts` row is written
    // every time the model re-mentions the same name.
    entities.findByNameReturns.set('Pat Doe|person', makeEntity({
      id: 'ent-pat',
      kind: 'person',
      displayName: 'Pat Doe',
    }))

    const extraction = JSON.stringify({
      summary: 'Met Pat again',
      entities: [{ kind: 'person', display_name: 'Pat Doe', canonical_id: null }],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    await processEpisode(baseEpisode(), 'note', deps)

    expect(crm.contacts).toEqual([])
    expect(entities.created).toEqual([])
  })

  it('records a learned alias when an extracted display_name resolves to an existing entity by canonical_id', async () => {
    // Alias-as-data, Phase 2: extraction emits "deltadefi-protocol" with
    // canonical_id = "deltadefi.com"; an existing DeltaDeFi entity already
    // owns that canonical_id. Pipeline B finds it by canonical_id and
    // must now record "deltadefi-protocol" as a learned alias so the
    // next mention hits the cheap name+alias index instead of paying
    // another canonical_id lookup.
    const crm = spyCrm()
    const entities = spyEntities()
    entities.findByCanonicalIdReturns.set('deltadefi.com', [
      makeEntity({
        id: 'ent-ddf',
        kind: 'company',
        displayName: 'DeltaDeFi',
        canonicalId: 'deltadefi.com',
        aliases: ['dd'],
      }),
    ])

    const extraction = JSON.stringify({
      summary: 'Sync with deltadefi-protocol',
      entities: [{
        kind: 'company',
        display_name: 'deltadefi-protocol',
        canonical_id: 'deltadefi.com',
      }],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    await processEpisode(baseEpisode(), 'note', deps)

    expect(entities.aliasesAdded).toEqual([
      { entityId: 'ent-ddf', alias: 'deltadefi-protocol' },
    ])
  })

  it('does NOT re-record a learned alias when extracted name already matches displayName or an existing alias', async () => {
    const crm = spyCrm()
    const entities = spyEntities()
    entities.findByCanonicalIdReturns.set('deltadefi.com', [
      makeEntity({
        id: 'ent-ddf',
        kind: 'company',
        displayName: 'DeltaDeFi',
        canonicalId: 'deltadefi.com',
        aliases: ['dd', 'deltadefi-protocol'],
      }),
    ])

    const extraction = JSON.stringify({
      summary: 'Mentions',
      entities: [
        // case-variant of displayName — lower-vs-lower equals → skip
        { kind: 'company', display_name: 'deltadefi', canonical_id: 'deltadefi.com' },
      ],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    await processEpisode(baseEpisode(), 'note', deps)

    // learnAlias's guard (`normalized === entity.displayName.toLowerCase()`)
    // short-circuits before addAlias fires for a pure case-variant.
    expect(entities.aliasesAdded).toEqual([])
  })

  it('fuzzy resolver tier binds an extracted variant to an existing entity above the threshold', async () => {
    // Alias-as-data Phase 2 — neither canonical_id nor name+alias index
    // match, but Jaro-Winkler against existing entities is high enough
    // to bind. Surface form is recorded as an alias for next-time
    // cheap matching.
    const crm = spyCrm()
    const entities = spyEntities()
    // No name match (different lower-case form).
    // But listLiveEntitiesSystem will surface "DeltaDeFi" as a candidate.
    const existing = makeEntity({
      id: 'ent-ddf',
      kind: 'project',
      displayName: 'DeltaDeFi',
      aliases: [],
    })
    entities.store.listLiveEntitiesSystem = async () => [existing]

    const extraction = JSON.stringify({
      summary: 'Mentions DeltaDeFy (typo)',
      entities: [{
        kind: 'project',
        // Single-char typo — lower-cased it's "deltadefy" vs "deltadefi"
        // (the existing entity). Exact name pass misses, fuzzy hits with
        // JW ≈ 0.96.
        display_name: 'DeltaDeFy',
        canonical_id: null,
      }],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({
      provider,
      crm: crm.store,
      entities: entities.store,
    })
    ;(deps as { entityResolver?: unknown }).entityResolver = {
      fuzzyThreshold: 0.9,
      candidateLimit: 100,
    }

    await processEpisode(baseEpisode(), 'note', deps)

    // No new entity created — bound to ent-ddf via fuzzy tier.
    expect(entities.created).toEqual([])
    // Variant recorded as alias.
    expect(entities.aliasesAdded).toEqual([
      { entityId: 'ent-ddf', alias: 'deltadefy' },
    ])
  })

  it('fuzzy resolver below threshold falls through to create new entity', async () => {
    const crm = spyCrm()
    const entities = spyEntities()
    const existing = makeEntity({
      id: 'ent-other',
      kind: 'project',
      displayName: 'Hydra',
      aliases: [],
    })
    entities.store.listLiveEntitiesSystem = async () => [existing]

    const extraction = JSON.stringify({
      summary: 'Mentions Belvedere',
      entities: [{
        kind: 'project',
        display_name: 'Belvedere', // distant from "Hydra" — fuzzy misses
        canonical_id: null,
      }],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({
      provider,
      crm: crm.store,
      entities: entities.store,
    })
    ;(deps as { entityResolver?: unknown }).entityResolver = {
      fuzzyThreshold: 0.92,
      candidateLimit: 100,
    }

    await processEpisode(baseEpisode(), 'note', deps)

    // Fuzzy miss → new entity created.
    expect(entities.created).toHaveLength(1)
    expect(entities.created[0].displayName).toBe('Belvedere')
  })

  it('also learns aliases via the name-pass dedup path (not just canonical_id)', async () => {
    // The name pass resolved the entity by display_name OR existing
    // alias. If the matched display_name differs from the extracted
    // variant (e.g. matched on alias 'dd' but extracted 'DD'), the
    // case-folded form is already covered. But if there's a genuinely
    // new surface form (different non-trivial casing/whitespace),
    // record it.
    const crm = spyCrm()
    const entities = spyEntities()
    entities.findByNameReturns.set('Hydra Side-Chain|project', makeEntity({
      id: 'ent-hydra',
      kind: 'project',
      displayName: 'Hydra',
      aliases: [],
    }))

    const extraction = JSON.stringify({
      summary: 'Hydra mentions',
      entities: [{
        kind: 'project',
        display_name: 'Hydra Side-Chain',
        canonical_id: null,
      }],
      edges: [],
      memories: [],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    await processEpisode(baseEpisode(), 'note', deps)

    expect(entities.aliasesAdded).toEqual([
      { entityId: 'ent-hydra', alias: 'hydra side-chain' },
    ])
  })

  it('two ingest passes that mention the same repository produce ONE entity row (Github-style replay)', async () => {
    // Models the github poller scenario: two events fetched 15 min apart
    // both mention the `belvedere` repository. Without the name dedup pass
    // every poll cycle stacked a fresh entity row (the 18k-row baseline
    // the user reported). With the fix, the second call must observe the
    // first call's row and either no-op or supersede attributes.
    const crm = spyCrm()
    const entities = spyEntities()

    const repoExtraction = (summary: string) => JSON.stringify({
      summary,
      entities: [{
        kind: 'repository',
        display_name: 'belvedere',
        canonical_id: null,
        attributes: {},
      }],
      edges: [],
      memories: [],
      tags: [],
    })

    const provider = sequencedProvider([
      repoExtraction('PR opened on belvedere'),
      JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' }),
      repoExtraction('PR merged on belvedere'),
      JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' }),
    ])
    const deps = makeDeps({ provider, crm: crm.store, entities: entities.store })

    // First poll cycle — no existing entity, must create one.
    await processEpisode(baseEpisode(), 'pr-opened payload', deps)
    expect(entities.created).toHaveLength(1)
    expect(entities.created[0].displayName).toBe('belvedere')
    expect(entities.created[0].kind).toBe('repository')

    // Register the just-created row into the lookup map — mirrors what a
    // real entities table sees on the next read.
    const createdRow = makeEntity({
      id: 'ent-1',
      kind: 'repository',
      displayName: 'belvedere',
      attributes: {},
    })
    entities.findByNameReturns.set('belvedere|repository', createdRow)

    // Second poll cycle — same repo, must NOT create a second row.
    await processEpisode(baseEpisode(), 'pr-merged payload', deps)
    expect(entities.created).toHaveLength(1) // unchanged
    // Attributes unchanged → no supersede write either (mergeAttributes returns null).
    expect(entities.superseded).toHaveLength(0)
  })

  it('skips memory writes when the Episode lacks (userId, assistantId)', async () => {
    const memories = spyMemories()
    const extraction = JSON.stringify({
      summary: 'Some context.',
      entities: [],
      edges: [],
      memories: [{ summary: 'a fact', why_not_entity: 'no subject', why_not_task: 'not actionable' }],
      tags: [],
    })
    const provider = sequencedProvider([extraction, JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' })])
    const deps = makeDeps({ provider, memories: memories.store })

    // No userId / assistantId on the Episode — memory write must be skipped.
    await processEpisode(baseEpisode({ userId: null, assistantId: null }), 'note', deps)

    expect(memories.created).toHaveLength(0)
  })

  it('skips extraction entirely when the user is blocked for the assistant (Q20 observation block)', async () => {
    const memories = spyMemories()
    const entities = spyEntities()
    const links = spyLinks()
    const episodes = spyEpisodes()
    // Provider must not be called at all on a blocked episode.
    const provider = sequencedProvider([])
    const deps = makeDeps({
      provider,
      memories: memories.store,
      entities: entities.store,
      entityLinks: links.store,
      episodes: episodes.port,
      isUserBlockedForAssistant: async (assistantId, userId) =>
        assistantId === 'a-1' && userId === 'u-1',
    })

    const result = await processEpisode(
      baseEpisode({ assistantId: 'a-1', userId: 'u-1' }),
      'should never reach extraction',
      deps,
    )

    expect(result.extracted).toBe(false)
    expect(result.memoriesWritten).toEqual([])
    expect(result.entitiesWritten).toEqual([])
    expect(result.edgesWritten).toEqual([])
    expect(memories.created).toHaveLength(0)
    expect(entities.created).toHaveLength(0)
    // Episode is still archived for audit / replay.
    expect(episodes.statusCalls.map((c) => c.next)).toContain('archived')
  })

  it('does not block extraction when the assistant or user is missing (Q20 only fires on full pair)', async () => {
    const memories = spyMemories()
    const extraction = JSON.stringify({
      summary: 'A note.',
      entities: [],
      edges: [],
      memories: [{ summary: 'still here', why_not_entity: 'no subject', why_not_task: 'not actionable' }],
      tags: [],
    })
    const provider = sequencedProvider([
      extraction,
      JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' }),
    ])
    const deps = makeDeps({
      provider,
      memories: memories.store,
      // Blocklist returns true for everything — but this must not fire
      // because the episode lacks one half of the pair.
      isUserBlockedForAssistant: async () => true,
    })

    await processEpisode(baseEpisode({ assistantId: null, userId: 'u-1' }), 'note', deps)
    // memories require both userId and assistantId; that's a separate guard
    expect(memories.created).toHaveLength(0)
  })
})

// ── overhead:extraction usage attribution ────────────────────────────
//
// The extraction call is metered INSIDE processEpisode (next to the only
// place the usage exists), so no caller — batch drain, chat compaction,
// brain-MCP, slack/whatsapp realtime — can ship an unmetered ingest path.
// Pre-fix, this spend was computed and discarded: unbounded free ingestion,
// invisible to the cost dashboard (WS8 validated finding).

describe('[COMP:brain/pipeline-b] extraction usage attribution', () => {
  function usageSpy(impl?: () => Promise<void>) {
    const recordUsage = vi.fn(async (_params: Record<string, unknown>) => {
      if (impl) await impl()
    })
    return {
      recordUsage,
      store: { recordUsage } as unknown as import('../../billing/cost-tracker.js').UsageStore,
    }
  }

  it('records an overhead:extraction row for a successful extraction', async () => {
    const usage = usageSpy()
    const provider = sequencedProvider([
      JSON.stringify({ summary: 'A note.', entities: [], edges: [], memories: [], tags: [] }),
      JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' }),
    ])
    await processEpisode(baseEpisode(), 'note', makeDeps({ provider, usage: usage.store }))

    expect(usage.recordUsage).toHaveBeenCalledTimes(1)
    const row = usage.recordUsage.mock.calls[0]![0]
    expect(row).toMatchObject({
      userId: 'u-1',
      assistantId: 'a-1',
      workspaceId: 'ws-1',
      sessionId: null,
      model: 'mock',
      inputTokens: 10,
      outputTokens: 20,
      source: 'overhead:extraction',
      triggerKey: 'pipeline_b_extraction',
    })
    expect(row.actualCostUsd).toBeGreaterThan(0)
  })

  it('still records when the model output fails to parse — the tokens were spent', async () => {
    const usage = usageSpy()
    const provider = sequencedProvider(['this is not json'])
    await processEpisode(baseEpisode(), 'note', makeDeps({ provider, usage: usage.store }))
    expect(usage.recordUsage).toHaveBeenCalledTimes(1)
  })

  it('tolerates a null assistant (workspace-scoped batch) as a blank-assistant row', async () => {
    const usage = usageSpy()
    const provider = sequencedProvider(['nope'])
    await processEpisode(
      baseEpisode({ assistantId: null }),
      'note',
      makeDeps({ provider, usage: usage.store }),
    )
    // The episode's workspaceId rides along so the store's workspace-fallback
    // attribution can resolve a representative assistant for the row.
    expect(usage.recordUsage.mock.calls[0]![0]).toMatchObject({ assistantId: '', workspaceId: 'ws-1' })
  })

  it('a recorder failure logs and never breaks ingestion', async () => {
    const usage = usageSpy(async () => {
      throw new Error('usage db down')
    })
    const provider = sequencedProvider([
      JSON.stringify({ summary: 'A note.', entities: [], edges: [], memories: [], tags: [] }),
      JSON.stringify({ inferred_sensitivity: 'internal', brief_reason: 'routine' }),
    ])
    const result = await processEpisode(
      baseEpisode(),
      'note',
      makeDeps({ provider, usage: usage.store }),
    )
    expect(result.episodeId).toBe('ep-1')
  })
})
