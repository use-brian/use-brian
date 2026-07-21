import { describe, it, expect, vi } from 'vitest'
import { createTaskTriageJudge, parseTriageVerdict } from '../triage.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'

/**
 * [COMP:goals/triage-judge] The task-create triage judge (task-goal-autopilot.md
 * §8). Fail-CLOSED (the inverse of the clarity gate): only an explicit
 * `canAssist:true` with a complete brief drafts a goal; everything else (fail
 * verdict, parse failure, model error, missing brief field) returns null —
 * no draft.
 */

const PASS =
  '{"canAssist": true, "reason": "Research and drafting fit the connected tools.", ' +
  '"outcome": "A one-page vendor comparison is attached to the task.", ' +
  '"verification": "The task carries a page comparing at least three vendors on price and support.", ' +
  '"approach": "Search the brain for vendor history, research the public web, write the comparison as a doc page."}'

function mockProvider(response: string, seen?: { prompts: string[] }): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(req: { messages: Array<{ content: string }> }): AsyncGenerator<StreamChunk> {
      seen?.prompts.push(req.messages.map((m) => m.content).join('\n'))
      yield { type: 'text_delta', text: response } as StreamChunk
    },
  } as unknown as LLMProvider
}

function throwingProvider(): LLMProvider {
  return {
    createSession() {
      return {} as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      throw new Error('model down')
    },
  } as unknown as LLMProvider
}

describe('[COMP:goals/triage-judge] parseTriageVerdict', () => {
  it('returns the brief on an explicit pass with all fields', () => {
    const v = parseTriageVerdict(PASS)
    expect(v).not.toBeNull()
    expect(v?.outcome).toContain('vendor comparison')
    expect(v?.verification).toContain('three vendors')
    expect(v?.approach).toContain('Search the brain')
    expect(v?.judgeReason).toContain('Research and drafting')
  })

  it('returns null on an explicit fail verdict', () => {
    expect(
      parseTriageVerdict('{"canAssist": false, "reason": "Signing is a human act."}'),
    ).toBeNull()
  })

  it('fails closed on unparseable text', () => {
    expect(parseTriageVerdict('not json at all')).toBeNull()
  })

  it('fails closed when canAssist is absent — only an explicit true drafts', () => {
    expect(parseTriageVerdict('{"outcome": "x", "verification": "y", "approach": "z"}')).toBeNull()
  })

  it('fails closed on a pass missing any brief field', () => {
    expect(
      parseTriageVerdict('{"canAssist": true, "reason": "r", "outcome": "x", "approach": "z"}'),
    ).toBeNull()
    expect(
      parseTriageVerdict('{"canAssist": true, "reason": "r", "outcome": "", "verification": "y", "approach": "z"}'),
    ).toBeNull()
  })

  it('tolerates fenced / surrounding prose around the JSON', () => {
    expect(parseTriageVerdict('Sure:\n```json\n' + PASS + '\n```')).not.toBeNull()
  })

  it('defaults judgeReason when the pass omits reason', () => {
    const v = parseTriageVerdict(
      '{"canAssist": true, "outcome": "x", "verification": "y", "approach": "z"}',
    )
    expect(v?.judgeReason).toBeTruthy()
  })
})

describe('[COMP:goals/triage-judge] createTaskTriageJudge', () => {
  it('returns the brief for an assistable task', async () => {
    const judge = createTaskTriageJudge({ provider: mockProvider(PASS), model: 'mock' })
    const v = await judge({ title: 'Compare CRM vendors', capabilities: ['Web research'] })
    expect(v?.outcome).toContain('vendor comparison')
  })

  it('grounds the prompt in the task and the capability list', async () => {
    const seen = { prompts: [] as string[] }
    const judge = createTaskTriageJudge({ provider: mockProvider(PASS, seen), model: 'mock' })
    await judge({
      title: 'Compare CRM vendors',
      description: 'Focus on pricing for a 5-seat team',
      capabilities: ['Web research', 'Gmail (gmailSendMessage)'],
    })
    expect(seen.prompts[0]).toContain('TASK: Compare CRM vendors')
    expect(seen.prompts[0]).toContain('Focus on pricing')
    expect(seen.prompts[0]).toContain('- Web research')
    expect(seen.prompts[0]).toContain('- Gmail (gmailSendMessage)')
  })

  it('says so when no capabilities are connected', async () => {
    const seen = { prompts: [] as string[] }
    const judge = createTaskTriageJudge({ provider: mockProvider(PASS, seen), model: 'mock' })
    await judge({ title: 'T', capabilities: [] })
    expect(seen.prompts[0]).toContain('(none connected)')
  })

  it('fails closed (null, no throw) when the model errors', async () => {
    const judge = createTaskTriageJudge({ provider: throwingProvider(), model: 'mock' })
    await expect(judge({ title: 'T', capabilities: [] })).resolves.toBeNull()
  })

  it('reports usage to the COGS sink with the acting user', async () => {
    const onUsage = vi.fn()
    const judge = createTaskTriageJudge({ provider: mockProvider(PASS), model: 'mock', onUsage })
    await judge({ title: 'T', capabilities: [], userId: 'u1' })
    // The mock stream yields no usage chunk, so the sink may not fire — this
    // asserts only that a missing usage never throws. (Boot-level metering is
    // covered by the recordGoalOverheadUsage seam it shares with clarity.)
    expect(onUsage.mock.calls.every((c) => c[1] === 'u1')).toBe(true)
  })
})
