/**
 * [COMP:views/diagram] Auto-contrast label ink for the Mermaid polish pass.
 *
 * `polishSvg` recolours every node's label ink from the node's fill so the
 * text stays legible whether the fill came from the on-brand theme wash or a
 * model-authored `classDef` stage colour (yellow / green / blue …). The DOM
 * walk itself needs a browser env (deferred — this package runs in `node`;
 * see render.test.tsx), but the luminance decision is pure and is the part
 * that fixes the washed-out-labels bug, so we lock it down here.
 */
import { describe, it, expect } from 'vitest'
import { readableInk, parseColor } from '../widgets/Diagram.js'

const DARK_INK = '#1c2330'
const LIGHT_INK = '#f4f6fb'

describe('[COMP:views/diagram] readableInk', () => {
  it('puts dark ink on light / pastel fills (the stage colours from the screenshot)', () => {
    expect(readableInk('#ffffff')).toBe(DARK_INK) // white node
    expect(readableInk('#ffeb3b')).toBe(DARK_INK) // bright yellow "Feature Suggestions"
    expect(readableInk('#90ee90')).toBe(DARK_INK) // light green "Shipped to Production"
    expect(readableInk('#ffcc80')).toBe(DARK_INK) // orange "Planned Enhancements"
    expect(readableInk('#fff')).toBe(DARK_INK) // short hex
  })

  it('puts light ink on dark fills (dark-mode theme wash)', () => {
    expect(readableInk('#000000')).toBe(LIGHT_INK)
    expect(readableInk('#191919')).toBe(LIGHT_INK) // dark-mode --background
    expect(readableInk('#1f4e79')).toBe(LIGHT_INK) // deep blue
  })

  it('accepts rgb()/rgba() fills, not just hex', () => {
    expect(readableInk('rgb(25, 25, 25)')).toBe(LIGHT_INK)
    expect(readableInk('rgba(255, 255, 255, 0.9)')).toBe(DARK_INK)
  })

  it('falls back to dark ink for unparseable colours (oklch, named, garbage)', () => {
    expect(readableInk('oklch(0.7 0.1 250)')).toBe(DARK_INK)
    expect(readableInk('rebeccapurple')).toBe(DARK_INK)
    expect(readableInk('')).toBe(DARK_INK)
  })
})

describe('[COMP:views/diagram] parseColor', () => {
  it('parses hex (3- and 6-digit, with/without hash)', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255])
    expect(parseColor('#2383e2')).toEqual([35, 131, 226])
    expect(parseColor('2383e2')).toEqual([35, 131, 226])
  })

  it('parses rgb() and rgba(), dropping alpha', () => {
    expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30])
    expect(parseColor('rgba(10,20,30,0.5)')).toEqual([10, 20, 30])
  })

  it('returns null for colours it cannot read', () => {
    expect(parseColor('oklch(0.7 0.1 250)')).toBeNull()
    expect(parseColor('transparent')).toBeNull()
    expect(parseColor('')).toBeNull()
  })
})
