/**
 * Unit tests for the conversational skill draft turn.
 * Component tag: [COMP:skills/draft-generator].
 *
 * Mock provider (same shape as the theme-generator tests): one text_delta +
 * a message_end with usage. Verifies the two-shape output contract
 * (draft+message / reply), transcript → message assembly (grounding on the
 * first user message, current draft + attachments on the last), the
 * freshest-window trim, fence-forgiving parsing, and the research turn's
 * constrained query loop (tool execution via an injected stub registry).
 */

import { describe, it, expect } from 'vitest'
import { buildTool, type LLMProvider, type Message, type StreamChunk, type Tool } from '@use-brian/core'
import { z } from 'zod'

import {
  generateSkillDraft,
  SkillDraftError,
  type SkillDraftContext,
  type SkillDraftFields,
} from '../draft-generator.js'

type Captured = { systemPrompt?: string; messages?: Message[]; model?: string }

function mockProvider(response: string, capture?: Captured): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(params: {
      model: string
      systemPrompt: string
      messages: Message[]
    }): AsyncGenerator<StreamChunk> {
      if (capture) {
        capture.systemPrompt = params.systemPrompt
        capture.messages = params.messages
        capture.model = params.model
      }
      yield { type: 'text_delta', text: response } as StreamChunk
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 200, outputTokens: 150 },
      } as StreamChunk
    },
  } as unknown as LLMProvider
}

/** Text of a message whether it's a plain string or content blocks. */
function textOf(message: Message | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
}

const EMPTY_CONTEXT: SkillDraftContext = { memories: [], entities: [], existingSkills: [] }

const VALID_DRAFT =
  '{"action":"draft","name":"Draft the weekly investor update","description":"Writes the Friday investor email the way the team does.","whenToUse":"When asked for the weekly investor update.","content":"# Steps\\n1. Gather metrics.\\n2. Draft.","sensitivity":"confidential","message":"Drafted it from your Friday update routine."}'

const VALID_REPLY = '{"action":"reply","message":"Who receives the update, and what cadence?"}'

const CURRENT_DRAFT: SkillDraftFields = {
  name: 'Weekly investor update',
  description: 'Writes the Friday email.',
  whenToUse: 'Friday updates.',
  content: '# Steps\n1. Gather metrics.\n2. Draft.\n3. Send.',
  sensitivity: 'internal',
}

describe('[COMP:skills/draft-generator] generateSkillDraft', () => {
  it('parses a draft response (with markdown fences) into the draft shape with its narration message', async () => {
    const result = await generateSkillDraft({
      provider: mockProvider('```json\n' + VALID_DRAFT + '\n```'),
      transcript: [{ role: 'user', content: 'draft our weekly investor update' }],
      context: EMPTY_CONTEXT,
      builderSkill: '## methodology',
    })
    expect(result.kind).toBe('draft')
    if (result.kind !== 'draft') throw new Error('unreachable')
    expect(result.draft.name).toBe('Draft the weekly investor update')
    expect(result.draft.sensitivity).toBe('confidential')
    expect(result.message).toBe('Drafted it from your Friday update routine.')
    expect(result.usage?.outputTokens).toBe(150)
  })

  it('returns a reply (no draft change) when the model answers or asks questions', async () => {
    const result = await generateSkillDraft({
      provider: mockProvider(VALID_REPLY),
      transcript: [{ role: 'user', content: 'make a skill' }],
      context: EMPTY_CONTEXT,
      builderSkill: '',
    })
    expect(result.kind).toBe('reply')
    if (result.kind !== 'reply') throw new Error('unreachable')
    expect(result.message).toContain('Who receives the update')
  })

  it('throws SkillDraftError on unparseable / invalid model output', async () => {
    await expect(
      generateSkillDraft({
        provider: mockProvider('sorry, I cannot do that'),
        transcript: [{ role: 'user', content: 'draft our weekly investor update' }],
        context: EMPTY_CONTEXT,
        builderSkill: '',
      }),
    ).rejects.toThrow(SkillDraftError)
    await expect(
      generateSkillDraft({
        provider: mockProvider('{"action":"draft","name":"x"}'), // missing required fields
        transcript: [{ role: 'user', content: 'draft our weekly investor update' }],
        context: EMPTY_CONTEXT,
        builderSkill: '',
      }),
    ).rejects.toThrow(SkillDraftError)
  })

  it('assembles the conversation: grounding on the first user message, current draft + attachments on the last', async () => {
    const capture: Captured = {}
    await generateSkillDraft({
      provider: mockProvider(VALID_DRAFT, capture),
      transcript: [
        { role: 'user', content: 'weekly investor update' },
        { role: 'assistant', content: 'Who receives it?' },
        { role: 'user', content: 'Our angels. Also tighten step 2.' },
      ],
      template: {
        name: 'Investor update',
        whenToUse: 'weekly investor mail',
        content: '# Template steps',
      },
      currentDraft: CURRENT_DRAFT,
      attachments: {
        blocks: [{ type: 'image', mimeType: 'image/png', data: 'aGk=' }],
        textParts: ['<attached_file id="f-1" name="example.png" type="image/png">[image]</attached_file>'],
      },
      context: {
        memories: ['Team prefers bullet-point updates'],
        entities: ['Acme Fund (company)'],
        existingSkills: [{ name: 'Weekly pipeline recap', whenToUse: 'weekly recap' }],
      },
      builderSkill: '## 1. Decide: clarify or draft',
    })

    expect(capture.systemPrompt).toContain('## 1. Decide: clarify or draft')
    const messages = capture.messages!
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])

    // Grounding rides the FIRST user message only.
    const first = textOf(messages[0])
    expect(first).toContain('weekly investor update')
    expect(first).toContain('Starting template: "Investor update"')
    expect(first).toContain('# Template steps')
    expect(first).toContain('Team prefers bullet-point updates')
    expect(first).toContain('Acme Fund (company)')
    expect(first).toContain('Weekly pipeline recap')

    // Middle turn stays verbatim.
    expect(textOf(messages[1])).toBe('Who receives it?')

    // The LAST user message carries the live document + the attachment
    // envelope, and the media block rides as a content block.
    const last = messages[2]!
    const lastText = textOf(last)
    expect(lastText).toContain('Also tighten step 2.')
    expect(lastText).toContain('## Current draft')
    expect(lastText).toContain('3. Send.')
    expect(lastText).toContain('<attached_file id="f-1"')
    expect(Array.isArray(last.content)).toBe(true)
    const blocks = last.content as Array<{ type: string }>
    expect(blocks.some((b) => b.type === 'image')).toBe(true)
  })

  it('trims to the freshest window and never opens on an assistant turn', async () => {
    const capture: Captured = {}
    const transcript: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (let i = 0; i < 9; i++) {
      transcript.push({ role: 'user', content: `user turn ${i}` })
      transcript.push({ role: 'assistant', content: `assistant turn ${i}` })
    }
    transcript.push({ role: 'user', content: 'final ask' })

    await generateSkillDraft({
      provider: mockProvider(VALID_DRAFT, capture),
      transcript,
      context: EMPTY_CONTEXT,
      builderSkill: '',
    })

    const messages = capture.messages!
    expect(messages.length).toBeLessThanOrEqual(12)
    expect(messages[0]!.role).toBe('user')
    expect(textOf(messages[messages.length - 1])).toContain('final ask')
  })

  it('rejects an empty transcript and a transcript not ending on a user turn', async () => {
    await expect(
      generateSkillDraft({
        provider: mockProvider(VALID_DRAFT),
        transcript: [{ role: 'user', content: '   ' }],
        context: EMPTY_CONTEXT,
        builderSkill: '',
      }),
    ).rejects.toThrow(SkillDraftError)
    await expect(
      generateSkillDraft({
        provider: mockProvider(VALID_DRAFT),
        transcript: [
          { role: 'user', content: 'draft it' },
          { role: 'assistant', content: 'done' },
        ],
        context: EMPTY_CONTEXT,
        builderSkill: '',
      }),
    ).rejects.toThrow(SkillDraftError)
  })

  it('research turn: runs the constrained loop, executes the injected search tool, and parses the FINAL turn', async () => {
    const searched: string[] = []
    const stubSearch: Tool = buildTool({
      name: 'webSearch',
      description: 'stub',
      inputSchema: z.object({ query: z.string() }),
      isConcurrencySafe: true,
      isReadOnly: true,
      async execute(input: { query: string }) {
        searched.push(input.query)
        return { data: { results: [{ title: 'SOP guide', url: 'https://x', snippet: 's' }] } }
      },
    }) as Tool

    // Turn 1: the model calls webSearch. Turn 2: it returns the JSON draft.
    let call = 0
    const provider = {
      createSession() {
        return { thoughtSignature: undefined } as never
      },
      async *stream(): AsyncGenerator<StreamChunk> {
        call += 1
        if (call === 1) {
          yield { type: 'tool_use_start', id: 't-1', name: 'webSearch' } as StreamChunk
          yield { type: 'tool_use_delta', id: 't-1', input: '{"query":"competitor analysis SOP"}' } as StreamChunk
          yield { type: 'tool_use_end', id: 't-1' } as StreamChunk
          yield {
            type: 'message_end',
            stopReason: 'tool_use',
            usage: { inputTokens: 100, outputTokens: 20 },
          } as StreamChunk
          return
        }
        yield { type: 'text_delta', text: VALID_DRAFT } as StreamChunk
        yield {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 150, outputTokens: 90 },
        } as StreamChunk
      },
    } as unknown as LLMProvider

    const result = await generateSkillDraft({
      provider,
      transcript: [{ role: 'user', content: 'research what a good competitor analysis includes, then draft it' }],
      context: EMPTY_CONTEXT,
      builderSkill: '',
      research: true,
      researchTools: new Map([['webSearch', stubSearch]]),
      identity: { userId: 'u-1', workspaceId: 'w-1' },
    })

    expect(searched).toEqual(['competitor analysis SOP'])
    expect(call).toBe(2)
    expect(result.kind).toBe('draft')
    if (result.kind !== 'draft') throw new Error('unreachable')
    expect(result.draft.name).toBe('Draft the weekly investor update')
  })

  it('mentions web grounding in the system prompt only on research turns', async () => {
    const plain: Captured = {}
    await generateSkillDraft({
      provider: mockProvider(VALID_DRAFT, plain),
      transcript: [{ role: 'user', content: 'draft it' }],
      context: EMPTY_CONTEXT,
      builderSkill: '',
    })
    expect(plain.systemPrompt).not.toContain('Web grounding is ON')

    const research: Captured = {}
    await generateSkillDraft({
      provider: mockProvider(VALID_DRAFT, research),
      transcript: [{ role: 'user', content: 'draft it' }],
      context: EMPTY_CONTEXT,
      builderSkill: '',
      research: true,
      researchTools: new Map(),
    })
    expect(research.systemPrompt).toContain('Web grounding is ON')
  })
})
