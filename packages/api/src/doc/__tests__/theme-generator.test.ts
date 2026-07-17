import { describe, it, expect } from 'vitest'
import type { LLMProvider, StreamChunk } from '@use-brian/core'
import { CORE_TOKENS } from '@use-brian/shared'

import {
  generateCustomTheme,
  refineCustomTheme,
  ThemeGenerationError,
} from '../theme-generator.js'

/**
 * Mock provider: emits `response` as one text_delta then a message_end with
 * usage. Exercises generateCustomTheme without a real model.
 */
function mockProvider(response: string): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: response } as StreamChunk
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 80, outputTokens: 60 },
      } as StreamChunk
    },
  } as unknown as LLMProvider
}

const VALID_SEED =
  '{"name":"Deep Focus","description":"Calm oceanic blues.","primary":"#0EA5E9","accent":"#14B8A6","neutral":"#0F2A3A","mood":"muted"}'

describe('[COMP:doc/theme-generator] generateCustomTheme', () => {
  it('parses a seed and builds full light+dark tokens', async () => {
    const result = await generateCustomTheme({
      provider: mockProvider(VALID_SEED),
      prompt: 'calm deep-ocean blues, focused',
    })
    expect(result.name).toBe('Deep Focus')
    expect(result.description).toBe('Calm oceanic blues.')
    expect(result.seed.primary).toBe('#0EA5E9')
    // No explicit appearance + a non-dark mood → derives 'light'.
    expect(result.seed.appearance).toBe('light')
    expect(Object.keys(result.tokens.light).sort()).toEqual([...CORE_TOKENS].sort())
    expect(Object.keys(result.tokens.dark).sort()).toEqual([...CORE_TOKENS].sort())
    expect(result.usage?.outputTokens).toBe(60)
  })

  it('keeps an explicit dark appearance and caps the name at two words', async () => {
    const dark =
      '{"name":"Velvet Midnight Noir","description":"Sleek dark surface.","appearance":"dark","primary":"#8B5CF6","accent":"#22D3EE","neutral":"#1A1A22","mood":"vivid"}'
    const result = await generateCustomTheme({ provider: mockProvider(dark), prompt: 'fancy dark theme' })
    expect(result.seed.appearance).toBe('dark')
    expect(result.name).toBe('Velvet Midnight') // 3 words → first two
    expect(result.seed.name).toBe('Velvet Midnight')
  })

  it('derives a dark appearance from a dark mood when the model omits appearance', async () => {
    const legacy =
      '{"name":"Coal","primary":"#8B5CF6","accent":"#22D3EE","neutral":"#1A1A22","mood":"dark"}'
    const result = await generateCustomTheme({ provider: mockProvider(legacy), prompt: 'dark' })
    expect(result.seed.appearance).toBe('dark')
  })

  it('tolerates markdown fences and surrounding prose around the JSON', async () => {
    const wrapped = 'Here you go:\n```json\n' + VALID_SEED + '\n```\nHope that helps!'
    const result = await generateCustomTheme({ provider: mockProvider(wrapped), prompt: 'x' })
    expect(result.seed.accent).toBe('#14B8A6')
  })

  it('throws ThemeGenerationError on unparseable output', async () => {
    await expect(
      generateCustomTheme({ provider: mockProvider('sorry, I cannot do that'), prompt: 'x' }),
    ).rejects.toBeInstanceOf(ThemeGenerationError)
  })

  it('throws ThemeGenerationError when the seed fails validation', async () => {
    // Missing required `neutral` + a non-hex primary.
    const bad = '{"name":"X","primary":"blue","accent":"#14B8A6","mood":"muted"}'
    await expect(
      generateCustomTheme({ provider: mockProvider(bad), prompt: 'x' }),
    ).rejects.toBeInstanceOf(ThemeGenerationError)
  })

  it('rejects an empty prompt before calling the model', async () => {
    await expect(
      generateCustomTheme({ provider: mockProvider(VALID_SEED), prompt: '   ' }),
    ).rejects.toBeInstanceOf(ThemeGenerationError)
  })
})

describe('[COMP:doc/theme-generator] refineCustomTheme', () => {
  const CURRENT = {
    name: 'Deep Focus',
    description: 'Calm oceanic blues.',
    primary: '#0EA5E9',
    accent: '#14B8A6',
    neutral: '#0F2A3A',
    mood: 'muted' as const,
  }

  it('applies the adjusted seed but keeps the existing name', async () => {
    // Model returns a refined seed that even tries to rename — name must stay.
    const adjusted =
      '{"name":"Renamed By Model","description":"Warmer take.","primary":"#F97316","accent":"#FACC15","neutral":"#2A1D1A","mood":"vivid"}'
    const result = await refineCustomTheme({
      provider: mockProvider(adjusted),
      currentSeed: CURRENT,
      instruction: 'make it warmer and punchier',
    })
    expect(result.name).toBe('Deep Focus') // name held stable
    expect(result.seed.primary).toBe('#F97316')
    expect(result.seed.mood).toBe('vivid')
    expect(Object.keys(result.tokens.light).sort()).toEqual([...CORE_TOKENS].sort())
  })

  it('flips appearance to dark when the instruction asks for it', async () => {
    const darker =
      '{"name":"whatever","description":"Darker take.","appearance":"dark","primary":"#0EA5E9","accent":"#14B8A6","neutral":"#0F1A24","mood":"muted"}'
    const result = await refineCustomTheme({
      provider: mockProvider(darker),
      currentSeed: CURRENT,
      instruction: 'make it darker',
    })
    expect(result.seed.appearance).toBe('dark')
  })

  it('preserves the prior appearance when the model omits it', async () => {
    const noAppearance =
      '{"name":"whatever","description":"Warmer.","primary":"#F97316","accent":"#FACC15","neutral":"#2A1D1A","mood":"muted"}'
    const result = await refineCustomTheme({
      provider: mockProvider(noAppearance),
      currentSeed: { ...CURRENT, appearance: 'dark' as const },
      instruction: 'warmer',
    })
    expect(result.seed.appearance).toBe('dark')
  })

  it('throws ThemeGenerationError on unusable output', async () => {
    await expect(
      refineCustomTheme({ provider: mockProvider('nope'), currentSeed: CURRENT, instruction: 'x' }),
    ).rejects.toBeInstanceOf(ThemeGenerationError)
  })

  it('rejects an empty instruction before calling the model', async () => {
    await expect(
      refineCustomTheme({ provider: mockProvider(VALID_SEED), currentSeed: CURRENT, instruction: ' ' }),
    ).rejects.toBeInstanceOf(ThemeGenerationError)
  })
})
