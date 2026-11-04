import { describe, it, expect } from 'vitest'
import { interpolateString, interpolateValue } from '../interpolation.js'

const SCOPE = {
  vars: { name: 'Alex', count: 3, info: { city: 'HK' } },
  input: { greeting: 'hi' },
}

describe('[COMP:workflow/interpolation] {{vars.X}} substitution', () => {
  it('makes bounded single-line Unicode previews without changing full values or evaluating inserted tokens', () => {
    const scope = { vars: {}, input: {}, prev: { body: '  Hello\nworld 😀 more text  ', literal: '{{input.secret}}' } }
    expect(interpolateString('{{prev.body | preview:14}}', scope)).toBe('Hello world 😀…')
    expect(interpolateString('{{prev.body | preview:1000}}', scope)).toBe('Hello world 😀 more text')
    expect(interpolateString('{{prev.body | preview:1}}', scope)).toBe('…')
    expect(interpolateString('{{prev.body}}', scope)).toBe(scope.prev.body)
    expect(interpolateString('{{prev.literal | preview:100}}', scope)).toBe('{{input.secret}}')
    expect(interpolateString('{{prev.missing | preview:140}}', scope)).toBe('')
    expect(interpolateString('{{prev.body | preview:0}}', scope)).toBe('{{prev.body | preview:0}}')
  })

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

describe('[COMP:workflow/interpolation] {{lastRun.X}} cross-run substitution', () => {
  const WITH_LAST_RUN = {
    vars: {},
    input: {},
    lastRun: {
      status: 'completed',
      summary: 'shipped 2 posts',
      todo: ['follow up with Acme', 'draft Q3 plan'],
      blockers: ['waiting on legal sign-off'],
      state: { cursor: 42, lastTopic: 'pricing' },
    },
  }

  it('substitutes a scalar lastRun field', () => {
    expect(interpolateString('prior: {{lastRun.summary}}', WITH_LAST_RUN)).toBe('prior: shipped 2 posts')
  })

  it('inlines JSON for lastRun array / object fields', () => {
    expect(interpolateString('{{lastRun.todo}}', WITH_LAST_RUN)).toBe('["follow up with Acme","draft Q3 plan"]')
    expect(interpolateString('{{lastRun.state}}', WITH_LAST_RUN)).toBe('{"cursor":42,"lastTopic":"pricing"}')
  })

  it('resolves nested lastRun.state paths', () => {
    expect(interpolateString('{{lastRun.state.lastTopic}}', WITH_LAST_RUN)).toBe('pricing')
  })

  it('resolves every {{lastRun.X}} to empty string when there is no prior run', () => {
    expect(interpolateString('todo: {{lastRun.todo}}!', SCOPE)).toBe('todo: !')
  })
})
