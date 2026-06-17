import { describe, it, expect } from 'vitest'
import { interpolateString, interpolateValue } from '../interpolation.js'

const SCOPE = {
  vars: { name: 'Alex', count: 3, info: { city: 'HK' } },
  input: { greeting: 'hi' },
}

describe('[COMP:workflow/interpolation] {{vars.X}} substitution', () => {
  it('substitutes a single token', () => {
    expect(interpolateString('hello {{vars.name}}', SCOPE)).toBe('hello Alex')
  })

  it('substitutes multiple tokens', () => {
    expect(interpolateString('{{input.greeting}} {{vars.name}}, count={{vars.count}}', SCOPE)).toBe('hi Alex, count=3')
  })

  it('handles nested paths', () => {
    expect(interpolateString('{{vars.info.city}}', SCOPE)).toBe('HK')
  })

  it('replaces missing tokens with empty string', () => {
    expect(interpolateString('x={{vars.missing}}!', SCOPE)).toBe('x=!')
  })

  it('inlines JSON for object values', () => {
    expect(interpolateString('{{vars.info}}', SCOPE)).toBe('{"city":"HK"}')
  })

  it('does not interpolate paths outside vars/input', () => {
    expect(interpolateString('{{nope.x}}', SCOPE)).toBe('')
  })

  it('deep-walks objects + arrays', () => {
    const result = interpolateValue(
      {
        name: '{{vars.name}}',
        nums: [1, '{{vars.count}}', { nested: '{{vars.name}}!' }],
        leftAlone: 42,
        bool: true,
      },
      SCOPE,
    )
    expect(result).toEqual({
      name: 'Alex',
      nums: [1, '3', { nested: 'Alex!' }],
      leftAlone: 42,
      bool: true,
    })
  })

  it('tolerates whitespace inside the braces', () => {
    expect(interpolateString('{{  vars.name  }}', SCOPE)).toBe('Alex')
  })
})
