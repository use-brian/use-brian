import { describe, expect, it } from 'vitest'
import {
  ACTION_CURSOR_MARKER,
  buildActionCursorArmScript,
  encodeActionCursorArmScript,
} from '../action-cursor.js'

describe('[COMP:sandbox/action-cursor] Brian action cursor page expression', () => {
  it('is self-contained, inert, reduced-motion aware, and short-lived', () => {
    const source = buildActionCursorArmScript('pointer')

    expect(() => new Function(`return ${source}`)).not.toThrow()
    expect(source).toContain(ACTION_CURSOR_MARKER)
    expect(source).toContain('attachShadow({ mode: "closed" })')
    expect(source).toContain('pointer-events:none')
    expect(source).toContain('contain:layout style;')
    expect(source).not.toContain('contain:layout style paint')
    expect(source).toContain('aria-hidden')
    expect(source).toContain('prefers-reduced-motion:reduce')
    expect(source).toContain('setTimeout(cleanup, 1500)')
  })

  it('encodes distinct pointer and typing arming expressions for agent-browser', () => {
    const pointer = Buffer.from(encodeActionCursorArmScript('pointer'), 'base64').toString('utf8')
    const typing = Buffer.from(encodeActionCursorArmScript('typing'), 'base64').toString('utf8')

    expect(pointer).toBe(buildActionCursorArmScript('pointer'))
    expect(typing).toBe(buildActionCursorArmScript('typing'))
    expect(pointer).not.toBe(typing)
  })
})
