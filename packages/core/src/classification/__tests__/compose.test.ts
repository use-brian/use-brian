import { describe, expect, it, vi } from 'vitest'

import { createComposeExecutor } from '../compose.js'
import type { CompositionContext, CompositionWrite } from '../compose.js'
import type { CrmStore } from '../../crm/types.js'
import type {
  EntityCreateParams,
  EntityLinkCreateParams,
  EntityLinkRecord,
  EntityLinksStore,
  EntityRecord,
  EntityStore,
} from '../../entities/types.js'

const NOW = new Date('2026-05-28T10:00:00Z')

function baseCtx(overrides: Partial<CompositionContext> = {}): CompositionContext {
  return {
    actorUserId: 'user-1',
    workspaceId: 'ws-1',
    sensitivity: 'internal',
    assistantId: 'asst-1',
    userId: 'user-1',
    sourceEpisodeId: 'ep-1',
    createdByRule: 'rule-test',
    boundary: 'connector',
    ...overrides,
  }
}

type Created = { id: string; params: EntityCreateParams }

function makeEntityStoreStub() {
  const created: Created[] = []
  const byCanonical = new Map<string, EntityRecord>()
  const byName = new Map<string, EntityRecord>()

  const stub = {
    create: vi.fn(async (params: EntityCreateParams) => {
      const { aliases: _unused, ...rest } = params as EntityCreateParams & { aliases?: readonly string[] }
      const rec = makeEntity({ id: `ent-${created.length + 1}`, ...rest })
      created.push({ id: rec.id, params })
      if (params.canonicalId) byCanonical.set(`${params.kind}:${params.canonicalId}`, rec)
      byName.set(`${params.kind}:${params.displayName.toLowerCase()}`, rec)
      return rec
    }),
    findByCanonicalIdSystem: vi.fn(async (_u: string, _w: string, cid: string) => {
      const rec = byCanonical.get(`person:${cid}`) ?? byCanonical.get(`company:${cid}`) ?? byCanonical.get(`repository:${cid}`) ?? byCanonical.get(`project:${cid}`)
      return rec ? [rec] : []
    }),
    findByNameSystem: vi.fn(async (_u: string, _w: string, name: string, opts?: { kind?: string }) => {
      return byName.get(`${opts?.kind ?? 'person'}:${name.toLowerCase()}`) ?? null
    }),
    supersedeAttributes: vi.fn(async (_u: string, id: string) => {
      return created.find((c) => c.id === id)
        ? makeEntity({ id, kind: 'project', displayName: 'whatever', canonicalId: null })
        : null
    }),
  } as unknown as EntityStore

  return { stub, created, byCanonical, byName }
}

function makeLinksStoreStub() {
  const created: EntityLinkCreateParams[] = []
  const stub: Partial<EntityLinksStore> = {
    create: vi.fn(async (params: EntityLinkCreateParams) => {
      created.push(params)
      return {
        id: `link-${created.length}`,
        sourceKind: params.sourceKind,
        sourceId: params.sourceId,
        targetKind: params.targetKind,
        targetId: params.targetId,
        edgeType: params.edgeType,
        attributes: params.attributes ?? {},
        source: params.source,
        verifiedByUserId: null,
        verifiedAt: null,
        validFrom: NOW,
        validTo: null,
        retractedAt: null,
        retractedReason: null,
        sourceEpisodeId: params.sourceEpisodeId ?? null,
        sensitivity: params.sensitivity ?? 'internal',
        workspaceId: params.workspaceId,
        userId: params.userId ?? null,
        assistantId: params.assistantId ?? null,
        createdAt: NOW,
      } satisfies EntityLinkRecord
    }),
  }
  return { stub: stub as EntityLinksStore, created }
}

function makeCrmStub() {
  const calls: { method: string; params: unknown }[] = []
  const stub: Partial<CrmStore> = {
    createContact: vi.fn(async (params) => {
      calls.push({ method: 'createContact', params })
      return { id: `contact-1` } as unknown as Awaited<ReturnType<CrmStore['createContact']>>
    }),
    createCompany: vi.fn(async (params) => {
      calls.push({ method: 'createCompany', params })
      return { id: `company-1` } as unknown as Awaited<ReturnType<CrmStore['createCompany']>>
    }),
    createDeal: vi.fn(async (params) => {
      calls.push({ method: 'createDeal', params })
      return { id: `deal-1` } as unknown as Awaited<ReturnType<CrmStore['createDeal']>>
    }),
  }
  return { stub: stub as CrmStore, calls }
}

function makeEntity(p: Partial<EntityRecord> & Pick<EntityRecord, 'id'>): EntityRecord {
  return {
    id: p.id,
    kind: p.kind ?? 'project',
    displayName: p.displayName ?? 'whatever',
    canonicalId: p.canonicalId ?? null,
    aliases: p.aliases ?? [],
    attributes: p.attributes ?? {},
    sensitivity: p.sensitivity ?? 'internal',
    workspaceId: p.workspaceId ?? 'ws-1',
    userId: p.userId ?? null,
    assistantId: p.assistantId ?? null,
    createdByUserId: p.createdByUserId ?? 'user-1',
    createdByAssistantId: p.createdByAssistantId ?? null,
    sourceEpisodeId: p.sourceEpisodeId ?? null,
    source: p.source ?? 'extracted',
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: NOW,
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    centrality: 0,
    centralityComputedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

describe('[COMP:classification/compose] createComposeExecutor', () => {
  it('writes a primary non-CRM entity via EntityStore.create', async () => {
    const entities = makeEntityStoreStub()
    const links = makeLinksStoreStub()
    const crm = makeCrmStub()
    const exec = createComposeExecutor({ entities: entities.stub, links: links.stub, crm: crm.stub })

    const writes: CompositionWrite = {
      primary: {
        ref: 'primary',
        kind: 'repository',
        display_name: 'belvedere',
        canonical_id: 'https://github.com/whatever/belvedere',
        attributes: { provider: 'github' },
      },
    }
    const out = await exec.write(writes, baseCtx())
    expect(out.entityIds.primary).toBeDefined()
    expect(entities.created).toHaveLength(1)
    expect(entities.created[0]?.params.kind).toBe('repository')
    expect(entities.created[0]?.params.attributes?._provenance).toMatchObject({
      created_by_rule: 'rule-test',
      boundary: 'connector',
    })
  })

  it('routes person kind through CRM.createContact and resolves entity id', async () => {
    const entities = makeEntityStoreStub()
    const links = makeLinksStoreStub()
    const crm = makeCrmStub()

    // Pre-seed the byName map so resolveCrmEntityId finds the entity row that
    // the CRM tool would have written atomically alongside the contact.
    const ent = makeEntity({ id: 'ent-person-1', kind: 'person', displayName: 'Alice Chen', canonicalId: 'alice@acme.com' })
    entities.byName.set('person:alice chen', ent)
    entities.byCanonical.set('person:alice@acme.com', ent)

    const exec = createComposeExecutor({ entities: entities.stub, links: links.stub, crm: crm.stub })
    const writes: CompositionWrite = {
      primary: {
        ref: 'primary',
        kind: 'person',
        display_name: 'Alice Chen',
        canonical_id: 'alice@acme.com',
      },
    }
    const out = await exec.write(writes, baseCtx())
    expect(out.entityIds.primary).toBe('ent-person-1')
    expect(crm.calls.find((c) => c.method === 'createContact')).toBeDefined()
    expect(entities.created).toHaveLength(0)  // CRM path, not direct EntityStore.create
  })

  it('writes composed entities + edge with resolved refs', async () => {
    const entities = makeEntityStoreStub()
    const links = makeLinksStoreStub()
    const crm = makeCrmStub()

    const personEnt = makeEntity({ id: 'ent-person', kind: 'person', displayName: 'Alice', canonicalId: 'alice@acme.com' })
    const companyEnt = makeEntity({ id: 'ent-company', kind: 'company', displayName: 'acme.com', canonicalId: 'acme.com' })
    entities.byName.set('person:alice', personEnt)
    entities.byName.set('company:acme.com', companyEnt)
    entities.byCanonical.set('person:alice@acme.com', personEnt)
    entities.byCanonical.set('company:acme.com', companyEnt)

    const exec = createComposeExecutor({ entities: entities.stub, links: links.stub, crm: crm.stub })
    const writes: CompositionWrite = {
      primary: { ref: 'primary', kind: 'person', display_name: 'Alice', canonical_id: 'alice@acme.com' },
      entities: [
        { ref: 'employer', kind: 'company', display_name: 'acme.com', canonical_id: 'acme.com' },
      ],
      edges: [
        { source_ref: 'primary', target_ref: 'employer', edge_type: 'works_at' },
      ],
    }
    const out = await exec.write(writes, baseCtx())
    expect(out.entityIds.primary).toBe('ent-person')
    expect(out.entityIds.employer).toBe('ent-company')
    expect(out.edgeIds).toHaveLength(1)
    expect(links.created[0]?.edgeType).toBe('works_at')
    expect(links.created[0]?.sourceId).toBe('ent-person')
    expect(links.created[0]?.targetId).toBe('ent-company')
  })

  it('dedups non-CRM entity by canonical_id, supersedes when attributes differ', async () => {
    const entities = makeEntityStoreStub()
    const links = makeLinksStoreStub()
    const crm = makeCrmStub()

    const existing = makeEntity({
      id: 'ent-existing',
      kind: 'repository',
      displayName: 'belvedere',
      canonicalId: 'https://github.com/whatever/belvedere',
      attributes: { provider: 'github' },
    })
    entities.byCanonical.set('repository:https://github.com/whatever/belvedere', existing)

    const exec = createComposeExecutor({ entities: entities.stub, links: links.stub, crm: crm.stub })
    const writes: CompositionWrite = {
      primary: {
        ref: 'primary',
        kind: 'repository',
        display_name: 'belvedere',
        canonical_id: 'https://github.com/whatever/belvedere',
        attributes: { provider: 'github', default_branch: 'main' }, // adds default_branch
      },
    }
    const out = await exec.write(writes, baseCtx())
    expect(out.entityIds.primary).toBe('ent-existing')
    expect(entities.stub.supersedeAttributes).toHaveBeenCalled()
    expect(entities.stub.create).not.toHaveBeenCalled()
  })

  it('skips edges with unresolved refs but writes remaining edges', async () => {
    const entities = makeEntityStoreStub()
    const links = makeLinksStoreStub()
    const crm = makeCrmStub()

    const ent1 = makeEntity({ id: 'ent-1', kind: 'project', displayName: 'x', canonicalId: null })
    const ent2 = makeEntity({ id: 'ent-2', kind: 'project', displayName: 'y', canonicalId: null })
    entities.byName.set('project:x', ent1)
    entities.byName.set('project:y', ent2)

    const exec = createComposeExecutor({ entities: entities.stub, links: links.stub, crm: crm.stub })
    const writes: CompositionWrite = {
      primary: { ref: 'primary', kind: 'project', display_name: 'x' },
      entities: [{ ref: 'sibling', kind: 'project', display_name: 'y' }],
      edges: [
        { source_ref: 'primary', target_ref: 'sibling', edge_type: 'mentioned' },
        { source_ref: 'primary', target_ref: 'missing', edge_type: 'mentioned' },  // missing ref
      ],
    }
    const out = await exec.write(writes, baseCtx())
    expect(out.edgeIds).toHaveLength(1)  // only the first edge wrote
  })
})
