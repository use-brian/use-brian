import { describe, it, expect, vi, type Mock } from 'vitest'
import {
  promoteMemoryToEntity,
  PromotionDenied,
  type MemoryForPromotion,
  type EntitySnapshotForPromotion,
  type MemoryToEntityPromotionPorts,
  type SupersedeEntityFn,
} from '../memory-to-entity-promotion.js'

const WORKSPACE = 'ws-1'
const AUTHOR = 'user-author'
const STRANGER = 'user-stranger'
const ASSISTANT = 'asst-1'

function makeMemory(overrides: Partial<MemoryForPromotion> = {}): MemoryForPromotion {
  return {
    id: 'mem-1',
    userId: null,
    assistantId: ASSISTANT,
    summary: 'Acme prefers email outreach',
    detail: null,
    sensitivity: 'internal',
    createdByUserId: AUTHOR,
    validTo: null,
    retractedAt: null,
    workspaceId: WORKSPACE,
    ...overrides,
  }
}

function makeEntity(overrides: Partial<EntitySnapshotForPromotion> = {}): EntitySnapshotForPromotion {
  return {
    id: 'ent-1',
    workspaceId: WORKSPACE,
    attributes: { website: 'acme.com' },
    validTo: null,
    retractedAt: null,
    ...overrides,
  }
}

interface Wiring {
  ports: MemoryToEntityPromotionPorts
  supersede: Mock<SupersedeEntityFn>
}

function makePorts(opts: {
  memory?: MemoryForPromotion | null
  entity?: EntitySnapshotForPromotion | null
  newEntityId?: string
} = {}): Wiring {
  const supersede = vi.fn(async () => ({ newEntityId: opts.newEntityId ?? 'ent-2' }))
  const ports: MemoryToEntityPromotionPorts = {
    getMemoryForPromotion: async () =>
      opts.memory === undefined ? makeMemory() : opts.memory,
    getEntityForPromotion: async () =>
      opts.entity === undefined ? makeEntity() : opts.entity,
    supersedeEntity: supersede,
  }
  return { ports, supersede }
}

async function expectDenied(
  promise: Promise<unknown>,
  reason: PromotionDenied['reason'],
) {
  await expect(promise).rejects.toBeInstanceOf(PromotionDenied)
  await expect(promise).rejects.toMatchObject({ reason })
}

describe('[COMP:brain/memory-to-entity-promotion] promoteMemoryToEntity', () => {
  describe('happy path', () => {
    it('returns the supersession result and merges the attribute', async () => {
      const { ports, supersede } = makePorts({
        entity: makeEntity({ attributes: { website: 'acme.com', tier: 'A' } }),
        newEntityId: 'ent-new',
      })

      const result = await promoteMemoryToEntity(ports, {
        memoryId: 'mem-1',
        targetEntityId: 'ent-1',
        attributeKey: 'preferred_outreach',
        attributeValue: 'email',
        actorUserId: AUTHOR,
      })

      expect(result).toEqual({
        oldEntityId: 'ent-1',
        newEntityId: 'ent-new',
        attributeKey: 'preferred_outreach',
      })
      expect(supersede).toHaveBeenCalledTimes(1)
      expect(supersede).toHaveBeenCalledWith({
        oldEntityId: 'ent-1',
        mergedAttributes: {
          website: 'acme.com',
          tier: 'A',
          preferred_outreach: 'email',
        },
        promotedByUserId: AUTHOR,
        sourceMemoryId: 'mem-1',
      })
    })

    it('overwrites a colliding attribute key', async () => {
      const { ports, supersede } = makePorts({
        entity: makeEntity({ attributes: { tier: 'B' } }),
      })

      await promoteMemoryToEntity(ports, {
        memoryId: 'mem-1',
        targetEntityId: 'ent-1',
        attributeKey: 'tier',
        attributeValue: 'A',
        actorUserId: AUTHOR,
      })

      expect(supersede.mock.calls[0][0].mergedAttributes).toEqual({ tier: 'A' })
    })

    it('accepts nested JSON values', async () => {
      const { ports, supersede } = makePorts()
      const nested = { stage: 'evaluation', notes: ['intro', 'pricing'] }

      await promoteMemoryToEntity(ports, {
        memoryId: 'mem-1',
        targetEntityId: 'ent-1',
        attributeKey: 'investor_status',
        attributeValue: nested,
        actorUserId: AUTHOR,
      })

      expect(supersede.mock.calls[0][0].mergedAttributes.investor_status).toEqual(nested)
    })
  })

  describe('memory guards', () => {
    it('rejects memory_not_found', async () => {
      const { ports, supersede } = makePorts({ memory: null })
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
        'memory_not_found',
      )
      expect(supersede).not.toHaveBeenCalled()
    })

    it('rejects memory_retracted', async () => {
      const { ports, supersede } = makePorts({
        memory: makeMemory({ retractedAt: new Date('2026-04-01') }),
      })
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
        'memory_retracted',
      )
      expect(supersede).not.toHaveBeenCalled()
    })

    it('rejects memory_superseded', async () => {
      const { ports, supersede } = makePorts({
        memory: makeMemory({ validTo: new Date('2026-04-01') }),
      })
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
        'memory_superseded',
      )
      expect(supersede).not.toHaveBeenCalled()
    })
  })

  describe('Promote-to-team gate', () => {
    it('rejects not_author when caller did not create the memory', async () => {
      const { ports, supersede } = makePorts()
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: STRANGER,
        }),
        'not_author',
      )
      expect(supersede).not.toHaveBeenCalled()
    })
  })

  describe('widening guard', () => {
    it('rejects when memory is already workspace-canonical (NULL, NULL)', async () => {
      const { ports, supersede } = makePorts({
        memory: makeMemory({ userId: null, assistantId: null }),
      })
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
        'not_widening',
      )
      expect(supersede).not.toHaveBeenCalled()
    })

    it('accepts (user, NULL) workspace_shared memories', async () => {
      const { ports } = makePorts({
        memory: makeMemory({ userId: AUTHOR, assistantId: null }),
      })
      await expect(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
      ).resolves.toMatchObject({ attributeKey: 'k' })
    })

    it('accepts (user, assistant) personal memories', async () => {
      const { ports } = makePorts({
        memory: makeMemory({ userId: AUTHOR, assistantId: ASSISTANT }),
      })
      await expect(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
      ).resolves.toMatchObject({ attributeKey: 'k' })
    })
  })

  describe('entity guards', () => {
    it('rejects entity_not_found', async () => {
      const { ports, supersede } = makePorts({ entity: null })
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
        'entity_not_found',
      )
      expect(supersede).not.toHaveBeenCalled()
    })

    it('rejects entity_retracted', async () => {
      const { ports, supersede } = makePorts({
        entity: makeEntity({ retractedAt: new Date('2026-04-01') }),
      })
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
        'entity_retracted',
      )
      expect(supersede).not.toHaveBeenCalled()
    })

    it('rejects entity_superseded', async () => {
      const { ports, supersede } = makePorts({
        entity: makeEntity({ validTo: new Date('2026-04-01') }),
      })
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
        'entity_superseded',
      )
      expect(supersede).not.toHaveBeenCalled()
    })
  })

  describe('workspace boundary', () => {
    it('rejects workspace_mismatch', async () => {
      const { ports, supersede } = makePorts({
        entity: makeEntity({ workspaceId: 'ws-2' }),
      })
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: 'k',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
        'workspace_mismatch',
      )
      expect(supersede).not.toHaveBeenCalled()
    })
  })

  describe('attribute key validation', () => {
    it('rejects empty string', async () => {
      const { ports, supersede } = makePorts()
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: '',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
        'invalid_attribute_key',
      )
      expect(supersede).not.toHaveBeenCalled()
    })

    it('rejects __proto__-style keys', async () => {
      const { ports, supersede } = makePorts()
      await expectDenied(
        promoteMemoryToEntity(ports, {
          memoryId: 'mem-1',
          targetEntityId: 'ent-1',
          attributeKey: '__proto__',
          attributeValue: 'v',
          actorUserId: AUTHOR,
        }),
        'invalid_attribute_key',
      )
      expect(supersede).not.toHaveBeenCalled()
    })
  })
})
