/**
 * Workflow auto-titler. Pure-text checks for `sanitizeWorkflowTitle` plus a
 * provider-mocked integration that exercises the streaming + fallback path.
 *
 * [COMP:workflow/auto-title]
 */

import { describe, it, expect } from 'vitest'
import {
  generateWorkflowTitle,
  sanitizeWorkflowTitle,
} from '../auto-title.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'

function makeProvider(chunks: StreamChunk[]): LLMProvider {
  return {
    name: 'mock',
    models: ['gemini-3.1-flash-lite'],
    stream: async function* () {
      for (const c of chunks) yield c
    },
    createSession() {
      throw new Error('createSession unused by auto-titler')
    },
  }
}

function makeThrowingProvider(error: Error): LLMProvider {
  return {
    name: 'mock-throw',
    models: ['gemini-3.1-flash-lite'],
    stream: async function* () {
      throw error
      // typescript needs a yield somewhere for it to be an AsyncGenerator
      // eslint-disable-next-line no-unreachable
      yield { type: 'text_delta', text: '' } as StreamChunk
    },
    createSession() {
      throw new Error('unused')
    },
  }
}

describe('[COMP:workflow/auto-title] sanitizeWorkflowTitle', () => {
  it('strips markdown emphasis + headings', () => {
    expect(sanitizeWorkflowTitle('## **Daily** _Oil_ Digest')).toBe('Daily Oil Digest')
  })
  it('strips trailing punctuation + enclosing quotes', () => {
    expect(sanitizeWorkflowTitle('"Pill Reminder"')).toBe('Pill Reminder')
    expect(sanitizeWorkflowTitle('Pill Reminder!')).toBe('Pill Reminder')
  })
  it('takes the first line only', () => {
    expect(sanitizeWorkflowTitle('Title Line\nExplanation here')).toBe('Title Line')
  })
  it('word-boundary trims to max', () => {
    const long = 'Daily Oil and Gas Market Briefing for the Investment Team'
    const out = sanitizeWorkflowTitle(long, 30)
    expect(out.length).toBeLessThanOrEqual(30)
    expect(out.endsWith(' ')).toBe(false)
  })
})

describe('[COMP:workflow/auto-title] generateWorkflowTitle', () => {
  it('cleans a streamed title and returns the model name', async () => {
    const provider = makeProvider([
      { type: 'message_start', model: 'gemini-3.1-flash-lite' },
      { type: 'text_delta', text: '**Morning** Pill Reminder' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4 } },
    ])
    const out = await generateWorkflowTitle(provider, {
      instructions: 'Remind me to take my pill at 8am every day',
      schedule: { type: 'daily', time: '08:00' },
      timezone: 'Asia/Hong_Kong',
    })
    expect(out.title).toBe('Morning Pill Reminder')
    expect(out.model).toBe('gemini-3.1-flash-lite')
    expect(out.usage?.inputTokens).toBe(10)
  })

  it('keeps a short single-word title verbatim when the model returns one (e.g. "Ping Me")', async () => {
    // Per the new prompt the model is expected to preserve user phrasing for
    // terse inputs rather than invent a longer formal alternative. The helper
    // must NOT second-guess that and overwrite with a fallback.
    const provider = makeProvider([
      { type: 'message_start', model: 'gemini-3.1-flash-lite' },
      { type: 'text_delta', text: 'Ping Me' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
    ])
    const out = await generateWorkflowTitle(provider, { instructions: 'ping me' })
    expect(out.title).toBe('Ping Me')
  })

  it('returns null when the model emits nothing', async () => {
    const provider = makeProvider([
      { type: 'message_start', model: 'gemini-3.1-flash-lite' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 0 } },
    ])
    const out = await generateWorkflowTitle(provider, { instructions: 'one' })
    expect(out.title).toBeNull()
  })

  it('returns null on provider failure without throwing (caller keeps the placeholder)', async () => {
    const provider = makeThrowingProvider(new Error('429 quota'))
    const out = await generateWorkflowTitle(provider, { instructions: 'Send a daily summary' })
    expect(out.title).toBeNull()
  })

  it('returns null with no input', async () => {
    const provider = makeProvider([
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
    const out = await generateWorkflowTitle(provider, {})
    expect(out.title).toBeNull()
    expect(out.model).toBeNull()
  })
})
