import { describe, it, expect } from 'vitest'
import {
  colorForUserId,
  CURSOR_PALETTE,
  readableTextColor,
} from '../cursor-color.js'

describe('[COMP:app-web/cursor-color] colorForUserId', () => {
  it('is deterministic for the same id', () => {
    expect(colorForUserId('user-abc')).toBe(colorForUserId('user-abc'))
  })

  it('always returns a color from the palette', () => {
    for (const id of ['a', 'user-1', 'Assistant', '00000000-0000-0000-0000-000000000000']) {
      expect(CURSOR_PALETTE).toContain(colorForUserId(id))
    }
  })

  it('spreads distinct ids across more than one color', () => {
    const colors = new Set(
      Array.from({ length: 50 }, (_, i) => colorForUserId(`user-${i}`)),
    )
    expect(colors.size).toBeGreaterThan(1)
  })

  it('handles the empty string without throwing', () => {
    expect(CURSOR_PALETTE).toContain(colorForUserId(''))
  })
})

describe('[COMP:app-web/cursor-color] readableTextColor', () => {
  it('uses dark text on light swatches (amber)', () => {
    expect(readableTextColor('#FFB224')).toBe('#1f2937')
  })

  it('uses white text on dark swatches (blue/purple/red)', () => {
    expect(readableTextColor('#3E63DD')).toBe('#ffffff')
    expect(readableTextColor('#8E4EC6')).toBe('#ffffff')
    expect(readableTextColor('#E5484D')).toBe('#ffffff')
  })

  it('every palette colour resolves to one of the two text colours', () => {
    for (const c of CURSOR_PALETTE) {
      expect(['#1f2937', '#ffffff']).toContain(readableTextColor(c))
    }
  })

  it('defaults to white for non-hex input (e.g. a CSS var fallback)', () => {
    expect(readableTextColor('var(--primary)')).toBe('#ffffff')
    expect(readableTextColor('')).toBe('#ffffff')
  })

  it('accepts shorthand 3-digit hex', () => {
    expect(readableTextColor('#fff')).toBe('#1f2937')
    expect(readableTextColor('#000')).toBe('#ffffff')
  })
})
