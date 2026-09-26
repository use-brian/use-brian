import { describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@use-brian/core'
import { closeProviderError } from '../chat-provider-error.js'

function setup(turnCount = 0) {
  const controller = new AbortController()
  const events: string[] = []
  const rows: string[] = []
  const turns = Array.from({ length: turnCount }, (_, i) => ({
    content: [{ type: 'tool_use', id: `call-${i}`, name: 'extractDocument', input: {} }] as ContentBlock[],
    toolResults: [{ type: 'tool_result', toolUseId: `call-${i}`, name: 'extractDocument', content: JSON.stringify({ extractionId: `extraction-${i}`, evidence: 'retained evidence' }) }] as ContentBlock[],
  }))
  const options = {
    error: new Error('Stream idle 30000ms'), turns,
    hasDeliveredText: false, alreadyDelivered: false, signal: controller.signal,
    canWrite: vi.fn(async () => true),
    persist: vi.fn(async (text: string) => { rows.push(text); events.push('persist') }),
    deliver: vi.fn((_text: string) => { events.push('text_delta') }),
  }
  return { options, controller, events, rows }
}

describe('provider-error closing response', () => {
  it.each([12, 19, 21])('closes %i tool-only turns without touching evidence or extraction ids', async (count) => {
    const { options, events, rows } = setup(count)
    const original = structuredClone(options.turns)
    expect(await closeProviderError(options)).toBe(true)
    expect(options.turns).toEqual(original)
    expect(events).toEqual(['persist', 'text_delta'])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('timed out')
    expect(rows[0]).toContain('may be incomplete')
    expect(rows[0]).toContain('before retrying actions')
    expect(rows[0].length).toBeLessThan(500)
    expect(options.deliver).toHaveBeenCalledWith(rows[0])
  })

  it('persists and delivers a bounded zero-turn timeout response', async () => {
    const { options, rows } = setup()
    expect(await closeProviderError(options)).toBe(true)
    expect(rows[0]).toContain('response may be incomplete')
    expect(rows[0]).not.toContain('tool activity')
  })

  it.each(['delivered', 'buffered'] as const)('closes even an existing %s partial answer', async (kind) => {
    const { options } = setup(1)
    if (kind === 'delivered') options.hasDeliveredText = true
    if (kind === 'buffered') options.turns.push({ content: [{ type: 'text', text: 'Partial answer' }], toolResults: [] })
    expect(await closeProviderError(options)).toBe(true)
    expect(options.persist).toHaveBeenCalledTimes(1)
  })

  it('does not mistake earlier tool narration for a final answer', async () => {
    const { options, rows } = setup(1)
    options.turns[0].content.unshift({ type: 'text', text: 'I will check the document.' })
    expect(await closeProviderError(options)).toBe(true)
    expect(rows[0]).toContain('timed out')
  })

  it.each(['cancelled', 'lease-lost', 'remote-stop', 'cancel-during-check'] as const)('does not write after %s', async (kind) => {
    const { options, controller } = setup(1)
    if (kind === 'cancelled') controller.abort()
    else options.canWrite.mockImplementation(async () => {
      if (kind === 'cancel-during-check') controller.abort()
      return kind === 'cancel-during-check'
    })
    expect(await closeProviderError(options)).toBe(false)
    expect(options.persist).not.toHaveBeenCalled()
    expect(options.deliver).not.toHaveBeenCalled()
  })

  it('fails closed when the lease cannot be checked or persistence fails', async () => {
    const { options } = setup()
    options.canWrite.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(closeProviderError(options)).rejects.toThrow('database unavailable')
    expect(options.persist).not.toHaveBeenCalled()
    options.persist.mockRejectedValueOnce(new Error('write failed'))
    await expect(closeProviderError(options)).rejects.toThrow('write failed')
    expect(options.deliver).not.toHaveBeenCalled()
  })

  it('does not run a second fallback after a closing response', async () => {
    const { options } = setup(1)
    options.alreadyDelivered = await closeProviderError(options)
    expect(await closeProviderError(options)).toBe(false)
    expect(options.persist).toHaveBeenCalledTimes(1)
    expect(options.deliver).toHaveBeenCalledTimes(1)
  })

  it('does not stream a closing response if cancelled during persistence', async () => {
    const { options, controller } = setup()
    options.persist.mockImplementation(async () => { controller.abort() })
    expect(await closeProviderError(options)).toBe(true)
    expect(options.deliver).not.toHaveBeenCalled()
  })

  it.each([
    new Error('Gemini API error 429: {"error":{"message":"secret body timeout","status":"RESOURCE_EXHAUSTED"}}'),
    Object.assign(new Error('private upstream body'), { status: 429 }),
  ])('reports exhausted rate limits safely', async error => {
    const { options, rows } = setup(1)
    options.error = error
    await closeProviderError(options)
    expect(rows[0]).toContain('rate limit')
    expect(rows[0]).not.toMatch(/connection failed|timed out|secret|private|RESOURCE_EXHAUSTED/)
    expect(rows[0]).toContain('results already recorded are preserved')
    expect(rows[0]).toContain('may be incomplete')
  })

  it('does not expose arbitrary upstream error content', async () => {
    const { options, rows } = setup()
    options.error = new Error('secret endpoint credentials')
    await closeProviderError(options)
    expect(rows[0]).toContain('model connection failed')
    expect(rows[0]).not.toContain('credentials')
  })

})
