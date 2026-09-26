import { describe, it, expect } from 'vitest'
import { composeWrappers, wrapTextLoopPrevention, detectBlockRestart } from '../wrappers.js'
import type { StreamChunk, StreamFn } from '../types.js'
import { collectStream } from '../accumulator.js'

/** Create a mock StreamFn that yields the given chunks */
function mockStream(chunks: StreamChunk[]): StreamFn {
  return async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
  }
}

function textChunks(texts: string[]): StreamChunk[] {
  return [
    { type: 'message_start', model: 'test' },
    ...texts.map((t): StreamChunk => ({ type: 'text_delta', text: t })),
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
  ]
}

describe('[COMP:providers/text-loop] Text loop prevention', () => {
  const contractFields = JSON.stringify({ title: 'Confidentiality agreement', values: {
    PARTY_NAME: 'Example Professional Consultancy Services Company Limited',
    SIGNATURE_NAME: 'Example Professional Consultancy Services Company Limited',
    NOTICE_NAME: 'Example Professional Consultancy Services Company Limited',
    ADDRESS: 'Suite 2501 Tesbury Centre Hong Kong',
  } }, null, 2)

  it('preserves repeated legal names in bounded tool-free JSON across chunk boundaries', async () => {
    const chunks = contractFields.match(/.{1,17}|\n/g)!
    const response = await collectStream(composeWrappers(mockStream(textChunks(chunks)), wrapTextLoopPrevention())({
      model: 'test', messages: [], systemPrompt: 'Fill template fields', responseFormat: 'json', maxTokens: 6000,
    }))
    const text = response.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
    expect(text).toBe(contractFields)
    expect(JSON.parse(text).values.NOTICE_NAME).toBe('Example Professional Consultancy Services Company Limited')
  })

  it.each([undefined, 0, Infinity, NaN])('does not exempt JSON without a finite positive budget: %s', async (maxTokens) => {
    const response = await collectStream(composeWrappers(mockStream(textChunks(contractFields.split(/(?<=\n)/))), wrapTextLoopPrevention())({
      model: 'test', messages: [], systemPrompt: 'test', responseFormat: 'json', maxTokens,
    }))
    const text = response.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
    expect(text).not.toBe(contractFields)
  })

  it('retains degenerate and restart detection for bounded JSON', async () => {
    for (const chunks of [ ['{"title":"Example", "text":"', '\b'.repeat(20), '"}'], [contractFields, contractFields] ]) {
      const response = await collectStream(composeWrappers(mockStream(textChunks(chunks)), wrapTextLoopPrevention())({
        model: 'test', messages: [], systemPrompt: 'test', responseFormat: 'json', maxTokens: 6000,
      }))
      const text = response.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
      expect(text).toBe(chunks[0])
    }
  })

  it('keeps phrase detection for tool-enabled JSON requests', async () => {
    const response = await collectStream(composeWrappers(mockStream(textChunks(contractFields.split(/(?<=\n)/))), wrapTextLoopPrevention())({
      model: 'test', messages: [], systemPrompt: 'test', responseFormat: 'json', maxTokens: 6000,
      tools: [{ name: 'example', description: 'Example tool', parameters: { type: 'object', properties: {} } }],
    }))
    const text = response.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
    expect(text).not.toBe(contractFields)
  })

  it('passes through normal text without interference', async () => {
    const stream = composeWrappers(
      mockStream(textChunks(['Hello, ', 'how are you ', 'doing today?'])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    expect(text).toBe('Hello, how are you doing today?')
    expect(response.stopReason).toBe('end_turn')
  })

  it('detects degenerate backspace spam', async () => {
    const stream = composeWrappers(
      mockStream(textChunks(['Good answer. ', '\b\b\b\b\b\b\b\b\b\b'])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    // Should have clean text only (the retry also loops, so we get truncated)
    // Since the mock stream always produces the same output, both attempts loop
    expect(text).toContain('Good answer.')
    expect(text).not.toContain('\b')
  })

  it('detects zero-width character spam', async () => {
    const zwj = '\u200B\u200C\u200D'
    const stream = composeWrappers(
      mockStream(textChunks(['Start. ', zwj.repeat(5)])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    expect(text).toContain('Start.')
    expect(text).not.toContain('\u200B')
  })

  it('detects single character infinite repetition', async () => {
    const stream = composeWrappers(
      mockStream(textChunks(['Hello ', 'aaaaaaaaaa'])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    expect(text).toContain('Hello')
  })

  it('detects n-gram repetition (4-gram appearing 3+ times)', async () => {
    // Build text where "the quick brown fox" repeats 3+ times
    const repeatedPhrase = 'the quick brown fox '
    const normalText = 'This is a perfectly normal introduction to the topic. '
    const loopingText = normalText + repeatedPhrase.repeat(4)

    // Split into streaming chunks (word by word)
    const words = loopingText.split(' ').filter(Boolean)
    const chunks = words.map((w) => w + ' ')

    const stream = composeWrappers(
      mockStream(textChunks(chunks)),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    // Should contain the normal text but stop before/during the loop
    expect(text).toContain('normal introduction')
  })

  it('detects a whole-answer restart the n-gram window misses (block-restart)', () => {
    // A ~130-word answer with a distinctive opening, repeated 3×. The repeat
    // period exceeds the 100-word n-gram window, so detectNgramRepetition is
    // blind to it; the opening fingerprint reappears verbatim, so the
    // block-restart detector catches it.
    const answer =
      'I found the issue with the failing workflow configuration after a careful review. ' +
      'The steps were pointed at an assistant name instead of a valid identifier, which ' +
      'is why every run rejected at validation time before any work could begin. The fix ' +
      'I propose repoints all four steps at the primary assistant so the run can proceed ' +
      'cleanly from start to finish without any further manual intervention required here. '
    const looping = answer + answer + answer

    const { looping: detected, cleanEnd } = detectBlockRestart(looping)
    expect(detected).toBe(true)
    // Trims to the first clean copy — the second occurrence starts at answer.length.
    expect(cleanEnd).toBe(answer.length)
    expect(looping.slice(0, cleanEnd)).toBe(answer)
  })

  it('block-restart does not flag normal long-form prose', () => {
    const prose =
      'The company brain grows more useful the longer a team relies on it every day. ' +
      'Memory accumulates around people, customers, deals, and the decisions that shaped them. ' +
      'Retrieval surfaces the right context at the moment a question is actually asked aloud. ' +
      'None of these sentences share an opening fingerprint with the first, so nothing trips. '
    const { looping } = detectBlockRestart(prose)
    expect(looping).toBe(false)
  })

  it('block-restart stays off for short answers (under the min buffer)', () => {
    const { looping } = detectBlockRestart('Short reply. Short reply. Short reply.')
    expect(looping).toBe(false)
  })

  it('marks a token-capped restart loop incomplete (the prod incident)', async () => {
    // Reproduces session abab9918: the model restarted its whole answer until
    // the output-token cap and the stream ended on `max_tokens` mid-sentence.
    // The repeat period (~65 words) exceeds the 100-word n-gram window, so only
    // the block-restart detector fires. With it, the wrapper aborts the loop and
    // marks the truncated output `incomplete`.
    const answer =
      'I found the issue with the failing workflow configuration after a careful review. ' +
      'The steps were pointed at an assistant name instead of a valid identifier, which ' +
      'is why every run rejected at validation time before any work could begin. The fix ' +
      'I propose repoints all four steps at the primary assistant so the run can proceed ' +
      'cleanly from start to finish without any further manual intervention required here. '
    const words = (answer + answer + answer).split(' ').filter(Boolean)
    const chunks: StreamChunk[] = [
      { type: 'message_start', model: 'test' },
      ...words.map((w): StreamChunk => ({ type: 'text_delta', text: w + ' ' })),
      // The model ran to the cap mid-loop, like the real turn (output_tokens 4186).
      { type: 'message_end', stopReason: 'max_tokens', usage: { inputTokens: 0, outputTokens: 4186 } },
    ]

    const stream = composeWrappers(
      mockStream(chunks),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    // Pre-fix this passed straight through as `max_tokens`; the block-restart
    // detector fires and reports the incomplete prefix.
    expect(response.stopReason).toBe('incomplete')
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')
    expect(text).toContain('I found the issue')
  })

  it('passes a markdown table through untouched (prod 2026-07-19)', async () => {
    // Session b8e567d6: a Telegram answer comparing three card tiers. The
    // 4-column delimiter row tokenized to `| :--- | :---` three times over and
    // tripped the n-gram detector, killing every attempt at `| :---`.
    const answer = [
      '這三張卡（綠卡、藍卡、黑卡）的本地日常簽賬回贈基本上是一樣的，最核心的差別在於「海外簽賬」：',
      '',
      '### 1. 里數回贈比例差別',
      '',
      '| 簽賬類別 | 綠卡 (普通版) | 藍卡 (優先理財) | 黑卡 (優先私人理財) |',
      '| :--- | :--- | :--- | :--- |',
      '| 本地簽賬 | HK$6/里 | HK$6/里 | HK$6/里 |',
      '| 海外簽賬 | HK$6/里 | HK$4/里 | HK$4/里 |',
      '',
      '以上係三個 tier 的主要分別。',
    ].join('\n')

    // Character-by-character, the way a real provider streams it.
    const stream = composeWrappers(
      mockStream(textChunks([...answer])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    // Delivered verbatim: not truncated at the delimiter row, not duplicated.
    expect(text).toBe(answer)
  })

  it('passes a fenced ASCII progress table through untouched (prod 2026-08-19)', async () => {
    // Session ac542985: a Slack pipeline-progress answer rendered one stage
    // track per deal row inside a ```text fence. The 4-gram `● Lead ─ ○` hit
    // the 3× threshold on the third row and — text already downstream — every
    // resend truncated at the identical character, leaving an unclosed fence.
    const answer = [
      '*PIPELINE PROGRESS*',
      '',
      '```text',
      'HKSTP         ● Lead ─ ○ Qualified ─ ○ Proposal ─ ○ Negotiation ─ ○ Won',
      'Bagel Factory ● Lead ─ ○ Qualified ─ ○ Proposal ─ ○ Negotiation ─ ○ Won',
      'OASA          ● Lead ─ ○ Qualified ─ ○ Proposal ─ ○ Negotiation ─ ○ Won',
      '```',
      '',
      'All three deals are at the Lead stage.',
    ].join('\n')

    // Character-by-character, the way a real provider streams it.
    const stream = composeWrappers(
      mockStream(textChunks([...answer])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    expect(text).toBe(answer)
  })

  it('still detects a prose loop even when the answer also carries a fence', async () => {
    // The fence exclusion must not blind the detector to loops in the prose
    // around it — only tokens inside the fence stop counting.
    const fenced = 'Status:\n\n```text\nHKSTP ● Lead ─ ○ Won\n```\n\nNow the summary of it all. '
    const looping = 'the same phrase again ' // trips the 4-gram threshold
    const answer = fenced + looping.repeat(4)

    const stream = composeWrappers(
      mockStream(textChunks([...answer])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    // Truncated: the emitted prefix survives, the loop tail does not.
    expect(text.startsWith('Status:')).toBe(true)
    expect(text.length).toBeLessThan(answer.length)
    expect(response.stopReason).toBe('incomplete')
  })

  it('truncates rather than duplicating once text is downstream', async () => {
    // The protocol has no retraction, so a loop detected after emission must
    // close the message, never re-stream. Prod 2026-07-19 shipped attempt-1 +
    // attempt-2 + clean-text concatenated into one reply.
    const opening = 'Here is the honest summary of what the audit turned up today. '
    const looping = 'the same phrase again ' // trips the 4-gram threshold
    const answer = opening + looping.repeat(4)

    const stream = composeWrappers(
      mockStream(textChunks([...answer])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    // Clean prefix survives, exactly once, and the turn still finalizes.
    expect(text).toContain('honest summary')
    expect(text.match(/honest summary/g)).toHaveLength(1)
    expect(text.startsWith(opening)).toBe(true)
    expect(response.stopReason).toBe('incomplete')
  })

  it('still retries when the loop starts before anything is emitted', async () => {
    // Degenerate spam in the very first chunk: nothing has reached the
    // consumer, so retrying is safe and the good attempt is delivered whole.
    let attempt = 0
    const inner: StreamFn = async function* () {
      attempt++
      yield { type: 'message_start', model: 'test' }
      if (attempt === 1) {
        yield { type: 'text_delta', text: '\b\b\b\b\b\b\b\b\b\b\b\b' }
      } else {
        yield { type: 'text_delta', text: 'A clean answer on the second attempt.' }
      }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }
    }

    const response = await collectStream(
      composeWrappers(inner, wrapTextLoopPrevention())({
        model: 'test',
        messages: [],
        systemPrompt: 'test',
      }),
    )

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    expect(attempt).toBe(2)
    expect(text).toBe('A clean answer on the second attempt.')
  })

  it('does not interfere with tool use chunks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'message_start', model: 'test' },
      { type: 'text_delta', text: 'Let me check. ' },
      { type: 'tool_use_start', id: 'call_1', name: 'weather' },
      { type: 'tool_use_delta', id: 'call_1', input: '{"city":"Tokyo"}' },
      { type: 'tool_use_end', id: 'call_1' },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
    ]

    const stream = composeWrappers(
      mockStream(chunks),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    expect(response.stopReason).toBe('tool_use')
    expect(response.content.some((b) => b.type === 'tool_use')).toBe(true)
  })
})

// ── Layout runs of rule characters (2026-09-17) ─────────────────
// Token-level streaming guarantees the 10-char tail lands inside any 10+ run,
// so a markdown table delimiter row or a horizontal rule used to truncate the
// answer at that exact point. The compaction summarizer hit it on the OSS
// stack: `| Item | Decision | Details |` and nothing after.

function charChunks(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

async function passThrough(text: string, chunk = 2): Promise<string> {
  const stream = composeWrappers(mockStream(textChunks(charChunks(text, chunk))), wrapTextLoopPrevention())
  const response = await collectStream(stream({ model: 'test', messages: [], systemPrompt: 'test' }))
  return response.content.filter((b) => b.type === 'text').map((b) => b.type === 'text' ? b.text : '').join('')
}

describe('[COMP:providers/text-loop] Layout runs of rule characters are not loops', () => {
  it('passes a markdown table with wide delimiter cells through untouched on token-sized deltas', async () => {
    const table =
      '## Decisions\n| Item | Decision | Details |\n|------------|----------------|--------------|\n' +
      '| Codename | BLUEFIN-2291 | confirmed |\n| Budget | 47,300 USD | hard cap |\n| Vendor | Meridian | via Rotterdam |\n'
    expect(await passThrough(table, 2)).toBe(table)
    expect(await passThrough(table, 1)).toBe(table)
  })

  it('passes horizontal rules, dividers, borders, and dot leaders through untouched', async () => {
    for (const rule of ['-'.repeat(30), '='.repeat(40), '─'.repeat(24), '_'.repeat(20), '*'.repeat(12), '.'.repeat(16)]) {
      const text = `Section one.\n\n${rule}\n\nSection two, with the answer that must survive.\n`
      expect(await passThrough(text, 2)).toBe(text)
    }
  })

  it('still aborts a genuine rule-character loop once the run passes the layout limit', async () => {
    const text = 'Loading' + '-'.repeat(400)
    const out = await passThrough(text, 2)
    expect(out.length).toBeLessThan(text.length)
    expect(out.length).toBeGreaterThanOrEqual('Loading'.length + 200 - 2)
  })

  it('keeps the 10-char rule for non-layout characters', async () => {
    const text = 'Result: ' + 'a'.repeat(40)
    const out = await passThrough(text, 2)
    expect(out.length).toBeLessThan('Result: '.length + 12)
  })
})

describe('[COMP:providers/text-loop] OCR comparison tables', () => {
  const header = '| Field name | Template value | Document value | Comparison status |\n| --- | --- | --- | --- |\n'
  const fields = ['Account holder', 'Account number', 'Bank name', 'Branch address', 'Currency', 'Signature']
  const table = (count: number, account = 1) => header + Array.from({ length: count }, (_, i) =>
    `| ${fields[i] ?? `Additional field ${i}`} | Account ${account} value ${i} | Pending OCR | Pending OCR |\n`).join('')

  it.each([1, 7, 83, 100000])('preserves six and 58 differing fields, chunk size %s', async size => {
    for (const count of [6, 58]) {
      const text = table(count)
      expect(await passThrough(text, size)).toBe(text)
    }
  })

  it.each([1, 31, 100000])('preserves shared headers and field names across varied accounts (%s)', async size => {
    const text = [1, 2, 3, 4].map(account => table(6, account)).join('\n')
    expect(await passThrough(text, size)).toBe(text)
  })

  it('supports omitted outer pipes, incomplete last rows and both fence styles', async () => {
    for (const fence of ['', '```markdown\n', '~~~markdown\n']) {
      const body = table(6).split('\n').map(line => line.replace(/^\| /, '').replace(/ \|$/, '')).join('\n')
      const text = fence + body + (fence ? fence.slice(0, 3) + '\n' : '') + 'Done.'
      expect(await passThrough(text, 1)).toBe(text)
    }
    const partial = table(6) + '| Another field | Pending OCR | Pending OCR'
    expect(await passThrough(partial, 1)).toBe(partial)
  })

  it('keeps a long stream of distinct rows intact across the detection window', async () => {
    const text = table(1200)
    expect(text.length).toBeGreaterThan(64 * 1024)
    expect(await passThrough(text, 4096)).toBe(text)
    const noOuterPipes = text.replace(/^\| /gm, '').replace(/ \|$/gm, '')
    expect(await passThrough(noOuterPipes, 4096)).toBe(noOuterPipes)
  })

  it.each([1, 19, 100000])('detects identical complete rows and table blocks (%s), without replay', async size => {
    for (const text of [
      header + '| Account number | Pending OCR | Pending OCR | Pending OCR |\n'.repeat(12),
      (table(6) + '\n').repeat(4),
      'Comparison results:\n\n' + (table(58) + '\n').repeat(4),
      '```markdown\n' + '| Same row | Pending OCR |\n'.repeat(12) + '```',
      'A prose introduction. ' + 'the same phrase again '.repeat(20),
      table(6) + 'the same phrase again '.repeat(20),
    ]) {
      let attempts = 0
      const inner: StreamFn = async function* () {
        attempts++
        yield* mockStream(textChunks(['Opening.\n', ...charChunks(text, size)]))({ model: 'test', messages: [], systemPrompt: '' })
      }
      const response = await collectStream(composeWrappers(inner, wrapTextLoopPrevention())({ model: 'test', messages: [], systemPrompt: '' }))
      const output = response.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('')
      expect(response.stopReason).toBe('incomplete')
      expect(attempts).toBe(1)
      expect(output.length).toBeLessThan(text.length + 'Opening.\n'.length)
      expect(output.match(/Opening\./g)).toHaveLength(1)
    }
  })
})

describe('[COMP:providers/text-loop] Incomplete output contract', () => {
  it('does not retry an already-emitted tool call when the first text delta loops', async () => {
    let attempts = 0
    const inner: StreamFn = async function* () {
      attempts++
      yield { type: 'message_start', model: 'test' }
      yield { type: 'tool_use_start', id: 'call_1', name: 'write' }
      yield { type: 'tool_use_delta', id: 'call_1', input: '{}' }
      yield { type: 'tool_use_end', id: 'call_1' }
      yield { type: 'text_delta', text: '\b'.repeat(12) }
      yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 12, outputTokens: 34 } }
    }
    const response = await collectStream(composeWrappers(inner, wrapTextLoopPrevention())({ model: 'test', messages: [], systemPrompt: '' }))
    expect(attempts).toBe(1)
    expect(response.stopReason).toBe('incomplete')
    expect(response.content.filter(b => b.type === 'tool_use')).toHaveLength(1)
    expect(response.usage).toMatchObject({ inputTokens: 12, outputTokens: 34 })
  })

  it('marks exhaustion of the safe pre-emission retry incomplete', async () => {
    let attempts = 0
    const inner: StreamFn = async function* () {
      attempts++
      yield* mockStream(textChunks(['\b'.repeat(12)]))({ model: 'test', messages: [], systemPrompt: '' })
    }
    const response = await collectStream(composeWrappers(inner, wrapTextLoopPrevention())({ model: 'test', messages: [], systemPrompt: '' }))
    expect(attempts).toBe(2)
    expect(response.stopReason).toBe('incomplete')
  })

  it('checks the complete final row at EOF without a newline', async () => {
    const text = '| Field | Value |\n| --- | --- |\n' + Array(3).fill('| Account | Pending OCR |').join('\n')
    const response = await collectStream(composeWrappers(mockStream(textChunks([...text])), wrapTextLoopPrevention())({ model: 'test', messages: [], systemPrompt: '' }))
    expect(response.stopReason).toBe('incomplete')
  })
})
