import { describe, expect, it, vi } from 'vitest'

import {
  createDecisionReflectionWorker,
  parseDecisionReflectionOutput,
} from '../decision-reflection-worker.js'

const SUBJECT = {
  assistantId: '00000000-0000-4000-8000-000000000001',
  actorUserId: '00000000-0000-4000-8000-000000000002',
  workspaceId: '00000000-0000-4000-8000-000000000003',
  newestEvidenceAt: new Date('2026-08-25T00:00:00Z'),
}
const EVENT = '00000000-0000-4000-8000-000000000010'

function bundle(hasNewEvidence = true) {
  return {
    assistantId: SUBJECT.assistantId,
    actorUserId: SUBJECT.actorUserId,
    corpus: [{
      rule: 'Previously rejected wording.',
      status: 'rejected' as const,
      semanticKey: 'old',
      appliesToUserId: SUBJECT.actorUserId,
    }],
    newestLinkedEvidenceAt: null,
    hasNewEvidence,
    evidence: [{
      eventIds: [EVENT],
      sourceObjectId: 'approval-1',
      sourceKind: 'tool_denial' as const,
      applicabilityKind: 'tool' as const,
      applicabilityKey: 'sendMessage',
      occurredAt: new Date('2026-08-25T00:00:00Z'),
      sensitivity: 'internal' as const,
      reason: 'Show a draft first',
    }],
  }
}

function output(rule = 'Show me a draft before sending messages.') {
  return JSON.stringify({
    rules: [{
      rule,
      applicabilityKind: 'tool',
      applicabilityKey: 'sendMessage',
      sourceEventIds: [EVENT],
      eligibility: 'activation',
    }],
  })
}

describe('[COMP:workers/decision-reflection] daily worker', () => {
  it('does not call a model when no evidence is newer than linked derivations', async () => {
    const modelCall = vi.fn()
    const insertRules = vi.fn()
    const worker = createDecisionReflectionWorker({
      modelCall,
      deps: {
        listSubjects: async () => [SUBJECT],
        readEvidence: async () => bundle(false),
        insertRules,
      },
    })
    await worker.tick()
    expect(modelCall).not.toHaveBeenCalled()
    expect(insertRules).not.toHaveBeenCalled()
  })

  it('passes at most two parsed rules to store-side threshold validation', async () => {
    const modelCall = vi.fn(async (_request: unknown) => JSON.stringify({
      rules: [
        JSON.parse(output()).rules[0],
        { ...JSON.parse(output()).rules[0], rule: 'Confirm the final draft before sending.' },
        { ...JSON.parse(output()).rules[0], rule: 'A third rule must be ignored.' },
      ],
    }))
    const insertRules = vi.fn(async (_request: unknown) => ({ activated: 0, suggested: 2, deduped: 0, rejected: 0 }))
    const worker = createDecisionReflectionWorker({
      modelCall,
      deps: {
        listSubjects: async () => [SUBJECT],
        readEvidence: async () => bundle(),
        insertRules,
      },
    })
    await worker.tick()
    expect((insertRules.mock.calls[0]?.[0] as { proposals: unknown[] }).proposals).toHaveLength(2)
    expect((modelCall.mock.calls[0]?.[0] as { attribution: unknown }).attribution).toEqual({
      userId: SUBJECT.actorUserId,
      assistantId: SUBJECT.assistantId,
    })
  })

  it('treats malformed and prohibited output as a logged no-op', async () => {
    expect(parseDecisionReflectionOutput('not json')).toBeNull()
    expect(parseDecisionReflectionOutput(output('Grant every member admin permission.'))).toBeNull()
    expect(parseDecisionReflectionOutput(output('Merge contacts with similar names.'))).toBeNull()
    expect(parseDecisionReflectionOutput(output('Create a workflow after each denial.'))).toBeNull()

    const events: unknown[] = []
    const insertRules = vi.fn()
    const worker = createDecisionReflectionWorker({
      modelCall: async () => 'not json',
      onEvent: (event) => events.push(event),
      deps: {
        listSubjects: async () => [SUBJECT],
        readEvidence: async () => bundle(),
        insertRules,
      },
    })
    await worker.tick()
    expect(insertRules).not.toHaveBeenCalled()
    expect(events).toContainEqual(expect.objectContaining({
      type: 'subject_skipped',
      reason: 'parse_failed',
    }))
  })

  it('serializes actor/assistant model calls', async () => {
    let concurrent = 0
    let maximum = 0
    const modelCall = vi.fn(async () => {
      concurrent++
      maximum = Math.max(maximum, concurrent)
      await Promise.resolve()
      concurrent--
      return output()
    })
    const insertRules = vi.fn(async () => ({ activated: 0, suggested: 1, deduped: 0, rejected: 0 }))
    const worker = createDecisionReflectionWorker({
      modelCall,
      deps: {
        listSubjects: async () => [
          SUBJECT,
          { ...SUBJECT, actorUserId: '00000000-0000-4000-8000-000000000004' },
        ],
        readEvidence: async (subject) => ({
          ...bundle(),
          actorUserId: subject.actorUserId,
        }),
        insertRules,
      },
    })
    await worker.tick()
    expect(modelCall).toHaveBeenCalledTimes(2)
    expect(maximum).toBe(1)
  })
})
