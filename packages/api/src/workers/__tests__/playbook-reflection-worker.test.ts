import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/playbook-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/playbook-store.js')>()
  return {
    ...actual,
    listReflectableAssistants: vi.fn(),
    countPendingPlaybookSuggestions: vi.fn(),
    samplePlaybookEvidence: vi.fn(),
    listPlaybookCorpus: vi.fn(),
    insertPlaybookRules: vi.fn(),
  }
})

import { createPlaybookReflectionWorker, type PlaybookReflectionEvent } from '../playbook-reflection-worker.js'
import {
  countPendingPlaybookSuggestions,
  insertPlaybookRules,
  listPlaybookCorpus,
  listReflectableAssistants,
  samplePlaybookEvidence,
} from '../../db/playbook-store.js'

const mockList = vi.mocked(listReflectableAssistants)
const mockPending = vi.mocked(countPendingPlaybookSuggestions)
const mockEvidence = vi.mocked(samplePlaybookEvidence)
const mockCorpus = vi.mocked(listPlaybookCorpus)
const mockInsert = vi.mocked(insertPlaybookRules)

const ASSISTANT = {
  assistantId: 'a-1',
  workspaceId: 'w-1',
  attributionUserId: 'u-owner',
  charter: { mission: 'Own support', success: 'Resolved in one reply', instructions: 'Be terse' },
  name: 'Support Bot',
}

const EVIDENCE = Array.from({ length: 8 }, (_, i) => ({
  sessionId: `s-${i % 2}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `message ${i}`,
  createdAt: '2026-08-01T00:00:00Z',
}))

function collectEvents() {
  const events: PlaybookReflectionEvent[] = []
  return { events, onEvent: (e: PlaybookReflectionEvent) => events.push(e) }
}

beforeEach(() => {
  mockList.mockReset()
  mockPending.mockReset()
  mockEvidence.mockReset()
  mockCorpus.mockReset()
  mockInsert.mockReset()
  mockCorpus.mockResolvedValue([])
  mockInsert.mockImplementation(async (_id, s) => ({ activated: s.length, suggested: 0 }))
})

describe('[COMP:workers/playbook-reflection] Playbook reflection worker', () => {
  it('grades an eligible assistant and inserts parsed rules as suggestions', async () => {
    mockList.mockResolvedValue([ASSISTANT])
    mockPending.mockResolvedValue(0)
    mockEvidence.mockResolvedValue(EVIDENCE)
    const modelCall = vi.fn().mockResolvedValue(
      '{"assessment": "Mostly good, but reopened threads twice.", "rules": [{"rule": "Confirm the resolution before closing a thread", "rationale": "Two threads were reopened after premature closes"}]}',
    )
    const { events, onEvent } = collectEvents()
    const worker = createPlaybookReflectionWorker({ modelCall, onEvent })

    await worker.tick()

    // The model call carries the rubric and the evidence, and the system
    // prompt carries the golden-source constraint (auto-admission's bar:
    // rules trace to human input only).
    const req = modelCall.mock.calls[0][0]
    expect(req.prompt).toContain('Resolved in one reply')
    expect(req.prompt).toContain('message 0')
    expect(req.systemPrompt).toContain('Golden-source constraint')
    expect(req.systemPrompt).toContain('HUMAN input')
    expect(req.attribution).toEqual({ userId: 'u-owner', assistantId: 'a-1' })

    // Rules land with session provenance, auto-admitted at the store.
    expect(mockInsert).toHaveBeenCalledTimes(1)
    const [assistantId, suggestions] = mockInsert.mock.calls[0]
    expect(assistantId).toBe('a-1')
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].rule).toBe('Confirm the resolution before closing a thread')
    expect((suggestions[0].provenance as { sessionIds: string[] }).sessionIds).toEqual(['s-0', 's-1'])
    expect((suggestions[0].provenance as { assessment: string }).assessment).toContain('reopened')

    expect(events).toContainEqual({
      type: 'assistant_processed', assistantId: 'a-1', activated: 1, suggested: 0,
    })
    expect(events.at(-1)).toEqual({
      type: 'tick_complete', processedCount: 1, suggestedCount: 1, skippedCount: 0, errorCount: 0,
    })
  })

  it('feeds existing and rejected rules to the prompt as the do-not-repropose corpus', async () => {
    mockList.mockResolvedValue([ASSISTANT])
    mockPending.mockResolvedValue(0)
    mockEvidence.mockResolvedValue(EVIDENCE)
    mockCorpus.mockResolvedValue([
      { rule: 'Already active rule', status: 'active' },
      { rule: 'Owner said no to this', status: 'rejected' },
    ])
    const modelCall = vi.fn().mockResolvedValue('{"assessment": "fine", "rules": []}')
    const worker = createPlaybookReflectionWorker({ modelCall })

    await worker.tick()

    const prompt = modelCall.mock.calls[0][0].prompt as string
    expect(prompt).toContain('Already active rule')
    const rejectedIdx = prompt.indexOf('Owner said no to this')
    expect(rejectedIdx).toBeGreaterThan(prompt.indexOf('never re-propose'))
  })

  it('skips when the suggestion inbox is full — no model call spent', async () => {
    mockList.mockResolvedValue([ASSISTANT])
    mockPending.mockResolvedValue(5)
    const modelCall = vi.fn()
    const { events, onEvent } = collectEvents()
    const worker = createPlaybookReflectionWorker({ modelCall, onEvent })

    await worker.tick()

    expect(modelCall).not.toHaveBeenCalled()
    expect(events).toContainEqual({ type: 'assistant_skipped', assistantId: 'a-1', reason: 'inbox_full' })
  })

  it('skips when the window holds too little evidence — no model call spent', async () => {
    mockList.mockResolvedValue([ASSISTANT])
    mockPending.mockResolvedValue(0)
    mockEvidence.mockResolvedValue(EVIDENCE.slice(0, 3))
    const modelCall = vi.fn()
    const { events, onEvent } = collectEvents()
    const worker = createPlaybookReflectionWorker({ modelCall, onEvent })

    await worker.tick()

    expect(modelCall).not.toHaveBeenCalled()
    expect(events).toContainEqual({ type: 'assistant_skipped', assistantId: 'a-1', reason: 'no_evidence' })
  })

  it('a malformed model response degrades to a skip, never a throw, and caps rules at 3', async () => {
    mockList.mockResolvedValue([
      ASSISTANT,
      { ...ASSISTANT, assistantId: 'a-2', name: 'Second' },
    ])
    mockPending.mockResolvedValue(0)
    mockEvidence.mockResolvedValue(EVIDENCE)
    const modelCall = vi
      .fn()
      .mockResolvedValueOnce('I refuse to answer in JSON today.')
      .mockResolvedValueOnce(
        JSON.stringify({
          assessment: 'ok',
          rules: [1, 2, 3, 4, 5].map((i) => ({ rule: `Rule ${i}`, rationale: 'r' })),
        }),
      )
    const { events, onEvent } = collectEvents()
    const worker = createPlaybookReflectionWorker({ modelCall, onEvent })

    await worker.tick()

    expect(events).toContainEqual({ type: 'assistant_skipped', assistantId: 'a-1', reason: 'parse_failed' })
    // Second assistant still processed; rules capped at 3.
    const [, suggestions] = mockInsert.mock.calls[0]
    expect(suggestions).toHaveLength(3)
    expect(events.at(-1)).toMatchObject({ type: 'tick_complete', errorCount: 0 })
  })

  it('one assistant erroring does not abort the tick for the rest', async () => {
    mockList.mockResolvedValue([
      ASSISTANT,
      { ...ASSISTANT, assistantId: 'a-2', name: 'Second' },
    ])
    mockPending.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(0)
    mockEvidence.mockResolvedValue(EVIDENCE)
    const modelCall = vi.fn().mockResolvedValue('{"assessment": "ok", "rules": []}')
    const { events, onEvent } = collectEvents()
    const worker = createPlaybookReflectionWorker({ modelCall, onEvent })

    await worker.tick()

    expect(events).toContainEqual({ type: 'error', assistantId: 'a-1', error: 'db down' })
    expect(events.at(-1)).toMatchObject({ type: 'tick_complete', processedCount: 1, errorCount: 1 })
  })
})
