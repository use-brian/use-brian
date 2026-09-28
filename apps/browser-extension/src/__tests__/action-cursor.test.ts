// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTION_CURSOR_BEFORE_CAPTURE, buildActionCursorArmExpression } from '../action-cursor.js'
import { formFieldOperation, type FormField } from '../fill-form.js'

const key = Symbol.for('use-brian.action-cursor.v1')
const state = () => (window as unknown as Record<symbol, any>)[key]
const evaluate = (expression: string) => new Function(`return (${expression})`)()

afterEach(() => {
  state()?.cleanup?.()
  clearTimeout(state()?.hideTimer)
  state()?.host.remove()
  delete (window as unknown as Record<symbol, unknown>)[key]
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('action cursor presentation', () => {
  it('shows trusted pointer movement and a press pulse, without an accessible/hit-testable control', () => {
    vi.useFakeTimers()
    evaluate(buildActionCursorArmExpression('pointer'))
    const cursor = state()
    expect(cursor.host.getAttribute('aria-hidden')).toBe('true')
    expect(cursor.host.inert).toBe(true)
    expect(cursor.host.shadowRoot).toBeNull()
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 80 }))
    expect(cursor.host.style.transform).toBe('translate3d(120px,80px,0)')
    document.dispatchEvent(new MouseEvent('mousedown', { clientX: 140, clientY: 90 }))
    expect(cursor.ring.classList.contains('on')).toBe(true)
    expect(cursor.cleanup).toBeNull()
    vi.advanceTimersByTime(4000)
    expect(cursor.host.isConnected).toBe(false)
    expect(state()).toBeUndefined()
  })

  it('removes unused arming DOM too', () => {
    vi.useFakeTimers()
    evaluate(buildActionCursorArmExpression('typing'))
    vi.advanceTimersByTime(4000)
    expect(state()).toBeUndefined()
  })

  it.each([
    ['<input>', { action: 'fill', ref: 'r', value: 'hello' }],
    ['<input type="checkbox">', { action: 'check', ref: 'r', checked: true }],
    ['<select><option>a</option><option>b</option></select>', { action: 'select', ref: 'r', value: 'b' }],
  ] as Array<[string, FormField]>)('scrolls only the committed target before focus/write and pulses even if already focused: %s', (html, field) => {
    document.body.innerHTML = html
    const target = document.body.firstElementChild as HTMLElement
    let top = 2000
    const order: string[] = []
    target.scrollIntoView = vi.fn(options => {
      expect(options).toEqual({ behavior: 'instant', block: 'center', inline: 'nearest' })
      order.push('scroll')
      top = 100
    })
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => ({ left: 20, top, width: 100, height: 30 }) as DOMRect)
    target.addEventListener('focus', () => order.push('focus'))
    target.addEventListener('input', () => order.push('input'))
    // Execute the serialized function, just as CDP does (including revalidation).
    const operation = evaluate(formFieldOperation.toString()) as typeof formFieldOperation
    expect(operation.call(target, field, 'validate')).toBeNull()
    expect(order).toEqual([])
    expect(state()).toBeUndefined()
    evaluate(buildActionCursorArmExpression('typing'))
    operation.call(target, field, 'set')
    expect(order.slice(0, 3)).toEqual(['scroll', 'focus', 'input'])
    expect(document.activeElement).toBe(target)
    expect(state().host.style.transform).toBe('translate3d(70px,115px,0)')
    expect(state().ring.classList.contains('on')).toBe(true)
    state().host.style.opacity = '0'
    operation.call(target, field, 'set')
    expect(state().host.style.opacity).toBe('1')
    const count = order.length
    operation.call(target, field, 'verify')
    expect(order).toHaveLength(count)
  })

  it('does not write or retarget when focus replaces the exact resolved node', () => {
    document.body.innerHTML = '<input>'
    const target = document.querySelector('input')!
    target.addEventListener('focus', () => target.replaceWith(document.createElement('input')))
    const event = vi.fn()
    target.addEventListener('input', event)
    expect(formFieldOperation.call(target, { action: 'fill', ref: 'r', value: 'secret' }, 'set')).toMatch(/no longer attached/)
    expect(target.value).toBe('')
    expect(document.querySelector('input')!.value).toBe('')
    expect(event).not.toHaveBeenCalled()
  })

  it('finishes cursor movement before screenshot and bounds the paint wait in background tabs', async () => {
    vi.useFakeTimers()
    evaluate(buildActionCursorArmExpression('pointer'))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 60 }))
    const finish = vi.fn()
    state().host.getAnimations = () => [{ finish }]
    vi.stubGlobal('requestAnimationFrame', vi.fn()) // background tab: no frames
    const paint = evaluate(ACTION_CURSOR_BEFORE_CAPTURE)
    expect(finish).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    await paint
    expect(state().host.style.opacity).toBe('1')
  })
})
