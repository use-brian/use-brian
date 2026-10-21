import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { applyChatAppearance, readChatAppearance } from '../appearance.js'
import { AssistantAvatar } from '../AssistantAvatar.js'
import { ChatComposer } from '../ChatComposer.js'

function root() {
  const values = new Map<string, string>()
  const classes = new Set<string>()
  return { values, classes, element: {
    classList: { contains: (key: string) => classes.has(key), toggle: (key: string, on: boolean) => on ? classes.add(key) : classes.delete(key) },
    style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key), colorScheme: '' },
  } as unknown as HTMLElement }
}
afterEach(() => vi.unstubAllGlobals())
describe('[COMP:chat-ui/appearance] shared app chat presentation', () => {
  it('reads the rendered theme and ignores unrelated CSS properties', () => {
    const h = root(); h.classes.add('dark')
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (key: string) => key === '--background' ? ' rgb(25, 25, 25) ' : '' }))
    expect(readChatAppearance(h.element)).toEqual({ dark: true, tokens: { '--background': 'rgb(25, 25, 25)' } })
  })
  it('updates light, dark and custom colors and clears a previous theme on reset', () => {
    vi.stubGlobal('CSS', { supports: () => true })
    const h = root()
    applyChatAppearance(h.element, { dark: true, tokens: { '--background': '#191919', '--foreground': '#D4D4D4' } })
    expect(h.classes.has('dark')).toBe(true); expect(h.element.style.colorScheme).toBe('dark')
    applyChatAppearance(h.element, { dark: false, tokens: { '--background': '#f0faf8' } })
    expect(h.values.get('--background')).toBe('#f0faf8'); expect(h.values.has('--foreground')).toBe(false)
    expect(h.classes.has('dark')).toBe(false)
  })
  it('refuses stylesheet injection, URLs, oversized values and unknown properties', () => {
    vi.stubGlobal('CSS', { supports: (_key: string, value: string) => value !== 'invalid' })
    const h = root()
    applyChatAppearance(h.element, { dark: false, tokens: { '--background': 'red; color: green', '--foreground': 'url(https://example.com)', '--ring': 'invalid', '--input': 'x'.repeat(1025), '--unknown': 'red', '--font-rocknroll': 'system-ui, sans-serif' } })
    expect([...h.values.entries()]).toEqual([['--font-rocknroll', 'system-ui, sans-serif']])
    applyChatAppearance(h.element, { dark: 'yes', tokens: {} })
    expect(h.values.size).toBe(1)
  })
  it('uses the same deterministic assistant artwork and opt-in composer action', () => {
    const props = { id: 'assistant-1', name: 'Example assistant', iconSeed: 42 }
    expect(renderToStaticMarkup(<AssistantAvatar {...props} />)).toBe(renderToStaticMarkup(<AssistantAvatar {...props} />))
    const markup = renderToStaticMarkup(<ChatComposer appearance="app" value="Draft" onChange={() => {}} onSend={() => {}} />)
    expect(markup).toContain('data-brian-chat-action="send"'); expect(markup).toContain('Draft')
    const queued = renderToStaticMarkup(<ChatComposer appearance="app" sendButtonTone="secondary" value="Next message" onChange={() => {}} onSend={() => {}} />)
    expect(queued).toContain('data-brian-chat-action="secondary"')
  })
})
