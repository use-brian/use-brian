import { describe, it, expect } from 'vitest'
import type {
  LLMProvider,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
  Message,
} from '../../providers/types.js'
import {
  queryLoop,
  looksLikeInstructionLeak,
  stripInstructionLeakPrefix,
  type QueryEvent,
} from '../query-loop.js'

// Scripted provider — same shape as query-loop.empty-retry.test.ts.
function scriptedProvider(scripts: StreamChunk[][]): {
  provider: LLMProvider
  calls: { messages: Message[]; sendOpts?: SendOptions }[]
} {
  const calls: { messages: Message[]; sendOpts?: SendOptions }[] = []
  let turn = 0
  function streamNext(): AsyncIterable<StreamChunk> {
    const chunks = scripts[Math.min(turn, scripts.length - 1)]
    turn++
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }
  const session: ProviderSession = {
    send(messages, opts) {
      calls.push({ messages, sendOpts: opts })
      return streamNext()
    },
  }
  return {
    calls,
    provider: {
      name: 'scripted',
      models: ['mock-model'],
      stream: () => streamNext(),
      createSession: (_o: SessionOptions) => session,
    },
  }
}

const ctx = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'test',
  channelType: 'web',
  channelId: 'c',
  abortSignal: new AbortController().signal,
}

const textChunks = (text: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
]

async function runLoop(provider: LLMProvider): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const e of queryLoop({
    provider,
    model: 'mock-model',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'hello' }],
    tools: new Map(),
    context: ctx,
    maxTurns: 10,
  })) {
    events.push(e)
  }
  return events
}

describe('[COMP:engine/leak-sanitiser] looksLikeInstructionLeak — plan-tail patterns', () => {
  // The exact string Flash 3.5 emitted as the WHOLE final turn on Anson /
  // GRI 2026-05-27 (session 19e48b38) after the loop-detector blocked
  // duplicate tool calls. This is the canonical repro.
  it('catches " Then, answer the user\'s question."', () => {
    expect(looksLikeInstructionLeak(" Then, answer the user's question.")).toBe(true)
  })

  it('catches "Now I\'ll reply to the user with the findings."', () => {
    expect(looksLikeInstructionLeak("Now I'll reply to the user with the findings.")).toBe(true)
  })

  it('catches "Respond to the user now."', () => {
    expect(looksLikeInstructionLeak('Respond to the user now.')).toBe(true)
  })

  it('catches "Address the user\'s question."', () => {
    expect(looksLikeInstructionLeak("Address the user's question.")).toBe(true)
  })

  // Self-referential delivery-process narration. The exact ~700-char leak
  // GM Bro's daily-summary cron shipped to a Telegram topic on 2026-06-20
  // (session 26cc0330): the model narrated its own dispatch process and dumped
  // chain-of-thought instead of a summary. Length-unbounded, so the ≤200-char
  // plan-tail gate misses it; the new opener/user-facing anchors catch it.
  const JUN20_LEAK = [
    'Wait for my next reply before sending the final user-facing text.',
    '',
    'I searched your Google Calendar and Tasks for Saturday, June 20, but both returned no entries for today. Your schedule appears to be completely clear with no pending tasks on your default list.',
    '',
    'Wait, I should check if there are other calendars or task lists before concluding. I\'ll do one quick check for other task lists. (I already did `googleTasksListTaskLists` and it returned empty? No, I didn\'t see the output of `googleTasksListTaskLists` because I misread the tool call results or it was empty).',
    '',
    'Wait, the previous `googleTasksListTaskLists` result was `{"matched":0,"returned":0,"truncated":false,"items":[]}`. This is very unusual. Usually, there is at least a `@default` list.',
    '',
    'Let me try a broader search for any calendar events in the next 7 days just to confirm connectivity.',
  ].join('\n')

  it('catches the 2026-06-20 GM Bro cron leak (700 chars, > the 200-char gate)', () => {
    expect(JUN20_LEAK.length).toBeGreaterThan(200)
    expect(looksLikeInstructionLeak(JUN20_LEAK)).toBe(true)
  })

  it('catches "Wait for my next reply..." on its own', () => {
    expect(looksLikeInstructionLeak('Wait for my next reply before I send the summary.')).toBe(true)
  })

  it('catches "...the final user-facing message..." mid-text', () => {
    expect(
      looksLikeInstructionLeak('Calendar is clear today. The final user-facing message should note that.'),
    ).toBe(true)
  })

  // Negative cases — these are real user-facing replies that happen to
  // contain "user" or "question" or "then". The detector must not fire.
  it('does NOT fire on a dev/design reply that mentions user-facing copy or sending', () => {
    // "user-facing" without the "final … " framing, and a send/await verb
    // that is NOT about the model's own reply, must both pass through.
    expect(
      looksLikeInstructionLeak('I tightened the user-facing copy on the onboarding button.'),
    ).toBe(false)
    expect(
      looksLikeInstructionLeak('I drafted the announcement. Before sending the message to the team, want to review it?'),
    ).toBe(false)
    expect(
      looksLikeInstructionLeak('Wait for the next sprint to ship the migration.'),
    ).toBe(false)
  })

  // Negative status reports open with "No <thing>" all the time — and a
  // workflow step prompt that mandates a verbatim fallback ("If none are
  // returned, output exactly: …") phrases it exactly that way. The 2026-07-02
  // triplication incident (Daily GitHub Dev Work Summary, run 26d50608): the
  // then-present `^no\b` opener anchor suppressed the mandated fallback,
  // EMPTY_RETRY re-prompted twice, and the callee executor concatenated all
  // three streamed attempts into "…hours.No recorded…hours.No recorded…".
  it('does NOT fire on a negative status report opening with "No"', () => {
    expect(
      looksLikeInstructionLeak('No recorded GitHub activity in the last 24 hours.'),
    ).toBe(false)
    expect(looksLikeInstructionLeak('No meetings on your calendar today.')).toBe(false)
    expect(looksLikeInstructionLeak('No new emails since yesterday evening.')).toBe(false)
  })

  it('still catches the genuine "No …" leaks via the substring pass', () => {
    expect(looksLikeInstructionLeak('No further tool calls.')).toBe(true)
    expect(looksLikeInstructionLeak('No sycophancy. No pre-announcements.')).toBe(true)
  })

  it('does NOT fire on a normal multi-paragraph reply', () => {
    const real = [
      'I created three tasks in your GRI workspace:',
      '',
      '1. Build GRI scoring engine',
      '2. Create social media accounts (@GlobalRunnerIndex)',
      '3. Formalize the business framework',
      '',
      'I held off on deleting the old memories — the deletion request needs your confirmation in the panel above.',
    ].join('\n')
    expect(looksLikeInstructionLeak(real)).toBe(false)
  })

  it('does NOT fire on a reply that uses "then" as a temporal connector', () => {
    expect(looksLikeInstructionLeak('Then we can ship the migration on Monday.')).toBe(false)
  })

  it('does NOT fire on a long reply that mentions "the user" in passing', () => {
    // Length-bounded: only short text gates third-person "the user"
    // patterns so we don't sanitise away a real reply that happens to
    // discuss users-as-subject (e.g. a doc explaining a feature).
    const long = 'In the new flow, the user lands on /onboard after Google sign-in. ' +
      'From there the assistant is created and the workspace bootstraps in the background. ' +
      'If the user already has a workspace, the redirect skips to /chat. ' +
      'The full path is wired in proxy.ts and tested in proxy.test.ts.'
    expect(looksLikeInstructionLeak(long)).toBe(false)
  })
})

describe('[COMP:engine/leak-sanitiser] stripInstructionLeakPrefix — scaffold primer', () => {
  // Canonical repro: the model emitted this marker before its real reply
  // after a tool-budget cap (2026-06-02, session b0903ea6). The whole-text
  // detector missed it because marker + reply ran to 209 chars (> the ≤200
  // plan-tail gate). The prefix-strip keeps the real reply, removes the marker.
  it('strips "Your reply to the user MUST start here:" and keeps the reply', () => {
    const leak =
      '\n\nYour reply to the user MUST start here:\nSaved "polish workflow interface" to your tasks.'
    expect(stripInstructionLeakPrefix(leak)).toBe('Saved "polish workflow interface" to your tasks.')
  })

  it('strips primer variants (begins/goes/starts here, final/user-facing)', () => {
    for (const [leak, body] of [
      ['Your response to the user begins here:\nDone.', 'Done.'],
      ['The reply goes here:\nAll set.', 'All set.'],
      ['Final reply must start here:\nOk.', 'Ok.'],
      ['User-facing answer starts here:\nHere you go.', 'Here you go.'],
    ] as const) {
      expect(stripInstructionLeakPrefix(leak)).toBe(body)
    }
  })

  it('leaves a genuine reply that opens "Reply to your question:" intact', () => {
    // No scaffold verb (here/must/start/…), so it is NOT a primer.
    const real = 'Reply to your question about pricing:\n- Pro is $20/mo'
    expect(stripInstructionLeakPrefix(real)).toBe(real)
  })

  it('leaves ordinary replies untouched', () => {
    for (const real of [
      'Saved "polish workflow interface" to your tasks.',
      "Here's the answer:\nfoo",
      'Response time was slow because the upstream API lagged.',
    ]) {
      expect(stripInstructionLeakPrefix(real)).toBe(real)
    }
  })
})

describe('[COMP:engine/leak-sanitiser] query-loop turn boundary', () => {
  it('strips a scaffold-primer prefix in place and keeps the reply (no retry)', async () => {
    // The primer + a full reply arrive as ONE turn. Unlike the leak-only
    // case below, we keep the real reply that follows the marker — there is
    // no tool budget to retry after a cap — so only ONE send() happens and
    // the persisted text is the clean reply.
    const { provider, calls } = scriptedProvider([
      textChunks('Your reply to the user MUST start here:\nSaved the task — due tomorrow.'),
    ])
    const events = await runLoop(provider)
    const turnComplete = events.find((e) => e.type === 'turn_complete')
    if (turnComplete?.type !== 'turn_complete') throw new Error('expected turn_complete')
    const finalText = turnComplete.response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    expect(finalText).toBe('Saved the task — due tomorrow.')
    expect(calls).toHaveLength(1)
  })

  it('strips a leak-only assistant turn and re-prompts via EMPTY_RETRY_PLAN', async () => {
    // Repro: model emits the leak as its whole turn, then the empty
    // retry succeeds. The user-facing text contains BOTH the streamed
    // leak (we can't unstream it) AND the recovery reply, but the
    // sanitised response.content carries only the recovery — that's
    // what gets persisted, so future turns aren't context-poisoned.
    const { provider, calls } = scriptedProvider([
      textChunks(" Then, answer the user's question."),
      textChunks('Three tasks created — see the panel.'),
    ])

    const events = await runLoop(provider)
    const turnComplete = events.find((e) => e.type === 'turn_complete')
    expect(turnComplete?.type).toBe('turn_complete')
    if (turnComplete?.type !== 'turn_complete') return
    const finalText = turnComplete.response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    expect(finalText).toBe('Three tasks created — see the panel.')
    // 2 send() calls: initial leak turn, EMPTY_RETRY_PLAN re-prompt.
    expect(calls).toHaveLength(2)
  })

  it('strips a self-referential delivery-narration turn and re-prompts (2026-06-20 repro)', async () => {
    // GM Bro cron shape: the whole turn is the model narrating its own
    // dispatch ("Wait for my next reply before sending the final user-facing
    // text.") with no tool_use and no real answer. Suppress → EMPTY_RETRY_PLAN
    // re-prompt → clean summary. Without the fix this shipped to Telegram.
    const { provider, calls } = scriptedProvider([
      textChunks(
        'Wait for my next reply before sending the final user-facing text.\n\n' +
          'I searched your Google Calendar and Tasks but both returned no entries. ' +
          'Let me try a broader search to confirm connectivity.',
      ),
      textChunks('Your Saturday is clear — no calendar events and no pending tasks.'),
    ])
    const events = await runLoop(provider)
    const turnComplete = events.find((e) => e.type === 'turn_complete')
    if (turnComplete?.type !== 'turn_complete') throw new Error('expected turn_complete')
    const finalText = turnComplete.response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    expect(finalText).toBe('Your Saturday is clear — no calendar events and no pending tasks.')
    expect(calls).toHaveLength(2)
  })

  it('does NOT sanitise a clean assistant turn', async () => {
    const { provider, calls } = scriptedProvider([
      textChunks('Three tasks created — see the panel.'),
    ])
    const events = await runLoop(provider)
    const turnComplete = events.find((e) => e.type === 'turn_complete')
    if (turnComplete?.type !== 'turn_complete') {
      throw new Error('expected turn_complete')
    }
    const finalText = turnComplete.response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    expect(finalText).toBe('Three tasks created — see the panel.')
    // No retry — clean turn exits the loop directly.
    expect(calls).toHaveLength(1)
  })
})
