import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingBatch, PipelineBResult } from '@use-brian/core'
import type { BrainAuth } from '../../brain-mcp/auth.js'
import type { BrainEpisodeInput } from '../../ingest-port.js'
import type {
  ProgrammaticCaptureRule,
  ProgrammaticCaptureStore,
  ProgrammaticCaptureTarget,
} from '../../db/programmatic-capture-store.js'

const db = vi.hoisted(() => ({
  append: vi.fn(),
  finish: vi.fn(),
  getReceipt: vi.fn(),
  drop: vi.fn(),
  reserve: vi.fn(),
}))

vi.mock('../../db/pending-ingest-batches-store.js', () => ({
  appendProgrammaticBatchEvent: db.append,
  finishRealtimeProgrammaticEvent: db.finish,
  getProgrammaticReceipt: db.getReceipt,
  recordDroppedProgrammaticEvent: db.drop,
  reserveRealtimeProgrammaticEvent: db.reserve,
}))

import {
  ProgrammaticCaptureError,
  createProgrammaticBatchProcessor,
  createProgrammaticCaptureRouter,
} from '../programmatic-capture.js'

const AUTH: BrainAuth = {
  keyId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  scope: 'read_write',
  maxClearance: 'internal',
  authKind: 'api_key',
  storeScope: 'none',
  agentScope: 'none',
  captureAssistantId: '33333333-3333-4333-8333-333333333333',
  captureProfileId: null,
}

function rule(overrides: Partial<ProgrammaticCaptureRule> = {}): ProgrammaticCaptureRule {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    profileId: '55555555-5555-4555-8555-555555555555',
    ruleOrder: 0,
    filterType: 'always',
    filterParams: {},
    routingMode: 'scheduled',
    routingSchedule: '*/15 * * * *',
    routingTimezone: 'UTC',
    episodeSensitivity: null,
    compartments: [],
    projectIds: [],
    ...overrides,
  }
}

function target(rules: ProgrammaticCaptureRule[], partitionBy: ProgrammaticCaptureTarget['partitionBy'] = 'session'): ProgrammaticCaptureTarget {
  return {
    workspaceId: AUTH.workspaceId,
    ownerUserId: '66666666-6666-4666-8666-666666666666',
    assistantId: AUTH.captureAssistantId!,
    assistantName: 'Story assistant',
    assistantClearance: 'confidential',
    assistantDefaultCompartments: ['team:77777777-7777-4777-8777-777777777777'],
    assistantDefaultProjectId: '88888888-8888-4888-8888-888888888888',
    profileId: '55555555-5555-4555-8555-555555555555',
    profileName: 'Writer capture',
    partitionBy,
    rules,
  }
}

function store(resolved: ProgrammaticCaptureTarget | null): ProgrammaticCaptureStore {
  return {
    resolveTargetSystem: vi.fn().mockResolvedValue(resolved),
    resolveBatchTargetSystem: vi.fn().mockResolvedValue(resolved && {
      workspaceId: resolved.workspaceId,
      ownerUserId: resolved.ownerUserId,
      assistantId: resolved.assistantId,
      assistantName: resolved.assistantName,
      assistantClearance: resolved.assistantClearance,
      assistantDefaultCompartments: resolved.assistantDefaultCompartments,
      assistantDefaultProjectId: resolved.assistantDefaultProjectId,
      profileId: resolved.profileId,
      profileName: resolved.profileName,
    }),
    listProfiles: vi.fn(),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    addRule: vi.fn(),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
    setAssistantProfile: vi.fn(),
  } as unknown as ProgrammaticCaptureStore
}

describe('[COMP:api/programmatic-capture] routed producer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.append.mockResolvedValue({
      duplicate: false,
      status: 'queued',
      batchId: '99999999-9999-4999-8999-999999999999',
      firesAt: new Date('2026-09-03T10:15:00.000Z'),
    })
    db.drop.mockResolvedValue({ duplicate: false, status: 'dropped', batchId: null, firesAt: null })
    db.reserve.mockResolvedValue(true)
    db.finish.mockResolvedValue(undefined)
  })

  it('queues a scheduled match without calling the extraction model', async () => {
    const ingest = vi.fn()
    const route = createProgrammaticCaptureRouter({
      store: store(target([rule()])),
      ingest,
      now: () => new Date('2026-09-03T10:01:00.000Z'),
    })

    const result = await route(AUTH, {
      eventId: 'message-7',
      sessionId: 'draft-42',
      role: 'user',
      content: 'Explore a quieter opening scene.',
      metadata: { stage: 'outline' },
    })

    expect(result.outcome).toBe('queued')
    expect(ingest).not.toHaveBeenCalled()
    expect(db.append).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: AUTH.captureAssistantId,
      partitionKey: 'session:draft-42',
      episodeSensitivity: 'internal',
      compartments: ['team:77777777-7777-4777-8777-777777777777'],
      projectIds: ['88888888-8888-4888-8888-888888888888'],
      event: expect.objectContaining({ eventId: 'message-7', content: 'Explore a quieter opening scene.' }),
    }))
  })

  it('uses first-match-wins and records a drop receipt', async () => {
    const dropAssistant = rule({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      filterType: 'role_match',
      filterParams: { values: ['assistant'] },
      routingMode: 'drop',
      routingSchedule: null,
    })
    const route = createProgrammaticCaptureRouter({
      store: store(target([dropAssistant, rule({ ruleOrder: 1 })])),
      ingest: vi.fn(),
    })
    const result = await route(AUTH, {
      eventId: 'assistant-1',
      sessionId: 'draft-42',
      role: 'assistant',
      content: 'Generated prose that should not be captured.',
    })
    expect(result.outcome).toBe('dropped')
    expect(db.drop).toHaveBeenCalledWith(expect.objectContaining({ ruleId: dropAssistant.id }))
    expect(db.append).not.toHaveBeenCalled()
  })

  it('fails closed before appending when a required partition id is absent', async () => {
    const route = createProgrammaticCaptureRouter({
      store: store(target([rule()], 'subject')),
      ingest: vi.fn(),
    })
    await expect(route(AUTH, { eventId: 'message-8', content: 'No subject id.' }))
      .rejects.toMatchObject({ code: 'capture_partition_missing' } satisfies Partial<ProgrammaticCaptureError>)
    expect(db.append).not.toHaveBeenCalled()
  })

  it('runs realtime extraction once and completes the receipt', async () => {
    const ingest = vi.fn(async () => ({ memories: [], entities: [], tasks: [], entityLinks: [] } as unknown as PipelineBResult))
    const realtime = rule({ routingMode: 'realtime', routingSchedule: null })
    const route = createProgrammaticCaptureRouter({ store: store(target([realtime])), ingest })
    const result = await route(AUTH, {
      eventId: 'message-9',
      content: 'A complete, urgent observation.',
    })
    expect(result.outcome).toBe('processed')
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(db.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })
})

describe('[COMP:api/programmatic-capture] pooled processor', () => {
  it('orders one window and invokes Pipeline B exactly once for the whole batch', async () => {
    const resolved = target([rule()])
    const ingest = vi.fn(async (_input: BrainEpisodeInput) => ({} as PipelineBResult))
    const process = createProgrammaticBatchProcessor({ store: store(resolved), ingest })
    const batch: PendingBatch = {
      id: '99999999-9999-4999-8999-999999999999',
      workspaceId: AUTH.workspaceId,
      assistantId: resolved.assistantId,
      partitionKey: 'session:draft-42',
      ruleId: resolved.rules[0]!.id,
      source: 'programmatic',
      firesAt: new Date('2026-09-03T11:00:00.000Z'),
      createdAt: new Date('2026-09-03T10:00:00.000Z'),
      episodeSensitivity: 'internal',
      compartments: [],
      projectIds: [],
      events: [
        {
          eventId: 'later', content: 'Second thought', occurredAt: '2026-09-03T10:02:00.000Z',
          receivedAt: '2026-09-03T10:02:01.000Z', role: 'assistant', metadata: {},
          principalKind: 'api_key', principalId: AUTH.keyId,
        },
        {
          eventId: 'earlier', content: 'First thought', occurredAt: '2026-09-03T10:01:00.000Z',
          receivedAt: '2026-09-03T10:01:01.000Z', role: 'user', metadata: { stage: 'draft' },
          principalKind: 'api_key', principalId: AUTH.keyId,
        },
      ],
    }

    await process(batch)

    expect(ingest).toHaveBeenCalledTimes(1)
    const input = ingest.mock.calls[0]![0]
    expect(input.content.indexOf('First thought')).toBeLessThan(input.content.indexOf('Second thought'))
    expect(input.sourceRef).toMatchObject({
      capture_mode: 'routed_batch',
      profile_id: resolved.profileId,
      partition_key: 'session:draft-42',
      message_count: 2,
      principal_refs: [`api_key:${AUTH.keyId}`],
    })
  })
})
