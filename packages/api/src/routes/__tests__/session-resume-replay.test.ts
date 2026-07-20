import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '@use-brian/core'
import { resolveResumeOutcomeNote } from '../session-resume-replay.js'

// ─────────────────────────────────────────────────────────────────────
// `resolveResumeOutcomeNote` (WU-6.4 — Path B durable chat resume).
// Pins the outcome-note branching the resume worker hands to the
// continuation turn: approved runs the frozen tool; rejected / expired /
// missing-tool / bad-input / tool-error all resolve to a relayable note
// rather than throwing.
// ─────────────────────────────────────────────────────────────────────

const context: ToolContext = {
  userId: 'user-1',
  assistantId: 'asst-1',
  sessionId: 'sess-1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'web-1',
  abortSignal: new AbortController().signal,
}

function toolMap(...tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]))
}

const okTool = buildTool({
  name: 'sendThing',
  description: 'send a thing',
  inputSchema: z.object({ to: z.string() }),
  isReadOnly: false,
  isConcurrencySafe: false,
  async execute(input) {
    return { data: `sent to ${(input as { to: string }).to}` }
  },
})

describe('[COMP:brain/session-resume-worker] resolveResumeOutcomeNote', () => {
  it('approved: runs the suspended tool and reports success', async () => {
    const note = await resolveResumeOutcomeNote(
      toolMap(okTool),
      {
        suspendedToolName: 'sendThing',
        suspendedToolInput: { to: 'alice@example.com' },
        approvalStatus: 'approved',
        rejectReason: null,
        answerText: null,
        approvalKind: 'tool_invocation',
      },
      context,
    )
    expect(note).toMatch(/executed successfully/i)
    expect(note).toContain('sent to alice@example.com')
  })

  it('approved: missing tool resolves to a graceful note (no throw)', async () => {
    const note = await resolveResumeOutcomeNote(
      toolMap(),
      {
        suspendedToolName: 'sendThing',
        suspendedToolInput: { to: 'alice@example.com' },
        approvalStatus: 'approved',
        rejectReason: null,
        answerText: null,
        approvalKind: 'tool_invocation',
      },
      context,
    )
    expect(note).toMatch(/no longer available/i)
  })

  it('approved: invalid frozen input resolves to a graceful note', async () => {
    const note = await resolveResumeOutcomeNote(
      toolMap(okTool),
      {
        suspendedToolName: 'sendThing',
        suspendedToolInput: { wrong: 'shape' },
        approvalStatus: 'approved',
        rejectReason: null,
        answerText: null,
        approvalKind: 'tool_invocation',
      },
      context,
    )
    expect(note).toMatch(/arguments are no longer valid/i)
  })

  it('approved: a tool returning isError is reported as a failure', async () => {
    const errTool = buildTool({
      name: 'sendThing',
      description: 'send a thing',
      inputSchema: z.object({ to: z.string() }),
      isReadOnly: false,
      isConcurrencySafe: false,
      async execute() {
        return { data: 'quota exceeded', isError: true }
      },
    })
    const note = await resolveResumeOutcomeNote(
      toolMap(errTool),
      {
        suspendedToolName: 'sendThing',
        suspendedToolInput: { to: 'alice@example.com' },
        approvalStatus: 'approved',
        rejectReason: null,
        answerText: null,
        approvalKind: 'tool_invocation',
      },
      context,
    )
    expect(note).toMatch(/failed/i)
    expect(note).toContain('quota exceeded')
  })

  it('approved: a tool that throws resolves to a graceful note (no throw)', async () => {
    const throwTool = buildTool({
      name: 'sendThing',
      description: 'send a thing',
      inputSchema: z.object({ to: z.string() }),
      isReadOnly: false,
      isConcurrencySafe: false,
      async execute() {
        throw new Error('connection reset')
      },
    })
    const note = await resolveResumeOutcomeNote(
      toolMap(throwTool),
      {
        suspendedToolName: 'sendThing',
        suspendedToolInput: { to: 'alice@example.com' },
        approvalStatus: 'approved',
        rejectReason: null,
        answerText: null,
        approvalKind: 'tool_invocation',
      },
      context,
    )
    expect(note).toMatch(/threw an error/i)
    expect(note).toContain('connection reset')
  })

  it('rejected: surfaces the reject reason and does not run the tool', async () => {
    let ran = false
    const spyTool = buildTool({
      name: 'sendThing',
      description: 'send a thing',
      inputSchema: z.object({ to: z.string() }),
      isReadOnly: false,
      isConcurrencySafe: false,
      async execute() {
        ran = true
        return { data: 'ok' }
      },
    })
    const note = await resolveResumeOutcomeNote(
      toolMap(spyTool),
      {
        suspendedToolName: 'sendThing',
        suspendedToolInput: { to: 'alice@example.com' },
        approvalStatus: 'rejected',
        rejectReason: 'too risky',
        answerText: null,
        approvalKind: 'tool_invocation',
      },
      context,
    )
    expect(note).toMatch(/declined/i)
    expect(note).toContain('too risky')
    expect(ran).toBe(false)
  })

  it('expired: reports the action was not performed', async () => {
    const note = await resolveResumeOutcomeNote(
      toolMap(okTool),
      {
        suspendedToolName: 'sendThing',
        suspendedToolInput: { to: 'alice@example.com' },
        approvalStatus: 'expired',
        rejectReason: null,
        answerText: null,
        approvalKind: 'tool_invocation',
      },
      context,
    )
    expect(note).toMatch(/expired/i)
    expect(note).toMatch(/not performed/i)
  })

  // askQuestion suspend-resume — kind='question' branch.
  // See docs/architecture/engine/askquestion-suspend-resume.md.
  it('question approved: outcome note carries the user answer back to the loop', async () => {
    const note = await resolveResumeOutcomeNote(
      toolMap(okTool),
      {
        suspendedToolName: 'askQuestion',
        suspendedToolInput: { question: 'Which MeshJS?' },
        approvalStatus: 'approved',
        rejectReason: null,
        answerText: 'the Cardano SDK',
        approvalKind: 'question',
      },
      context,
    )
    expect(note).toMatch(/Resumed after question/i)
    expect(note).toContain('the Cardano SDK')
    // Should never reference the legacy "tool executed" verbiage for a question.
    expect(note).not.toMatch(/executed successfully/i)
  })

  it('question rejected (cancelled): asks the model to acknowledge cancellation', async () => {
    const note = await resolveResumeOutcomeNote(
      toolMap(okTool),
      {
        suspendedToolName: 'askQuestion',
        suspendedToolInput: { question: 'Which MeshJS?' },
        approvalStatus: 'rejected',
        rejectReason: 'cancelled',
        answerText: null,
        approvalKind: 'question',
      },
      context,
    )
    expect(note).toMatch(/cancel/i)
    expect(note).not.toMatch(/declined the pending action/i)
  })

  it('question expired: tells the model no answer came in', async () => {
    const note = await resolveResumeOutcomeNote(
      toolMap(okTool),
      {
        suspendedToolName: 'askQuestion',
        suspendedToolInput: { question: 'Which MeshJS?' },
        approvalStatus: 'expired',
        rejectReason: null,
        answerText: null,
        approvalKind: 'question',
      },
      context,
    )
    expect(note).toMatch(/expired/i)
    expect(note).toMatch(/no answer/i)
  })

  it('question approved with empty answerText: falls back to a generic continuation note', async () => {
    const note = await resolveResumeOutcomeNote(
      toolMap(okTool),
      {
        suspendedToolName: 'askQuestion',
        suspendedToolInput: { question: 'Which MeshJS?' },
        approvalStatus: 'approved',
        rejectReason: null,
        answerText: '',
        approvalKind: 'question',
      },
      context,
    )
    expect(note).toMatch(/empty answer/i)
  })
})
