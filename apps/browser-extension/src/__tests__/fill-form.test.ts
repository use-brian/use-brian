// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { waitForDomQuiet } from '../dom-settle.js'
import { formFieldOperation, parseFormFields } from '../fill-form.js'
import { TabExecutor, retryableAfterReattach } from '../executor.js'

function input(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.firstElementChild as HTMLElement
}

describe('batch form validation and native operations', () => {
  it.each([
    {}, { fields: [] }, { fields: Array(51).fill({ action: 'fill', ref: '@e1', value: '' }) },
    { fields: [{ action: 'click', ref: '@e1' }] },
    { fields: [{ action: 'check', ref: '@e1', checked: 'false' }] },
    { fields: [{ action: 'fill', ref: '@e1', value: 12 }] },
    { fields: [{ action: 'fill', ref: '@e1', value: '', script: 'bad' }] },
  ])('rejects malformed arguments before execution: %j', args => {
    expect(() => parseFormFields(args)).toThrow('Invalid fillForm')
  })

  it.each(['fill', 'select'])('enforces the 20,000 character %s value boundary', action => {
    expect(parseFormFields({ fields: [{ action, ref: 'a', value: 'x'.repeat(20000) }] })).toHaveLength(1)
    expect(() => parseFormFields({ fields: [{ action, ref: 'a', value: 'x'.repeat(20001) }] })).toThrow('Invalid fillForm')
  })

  it('uses prototype setters, dispatches input/change, and verifies controlled values', () => {
    const el = input('<input>') as HTMLInputElement
    const ownSetter = vi.fn()
    Object.defineProperty(el, 'value', { set: ownSetter, get: () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!.call(el) })
    const events: string[] = []
    el.addEventListener('input', () => events.push('input'))
    el.addEventListener('change', () => events.push('change'))
    const field = { action: 'fill', ref: '@e1', value: 'hello' } as const
    expect(formFieldOperation.call(el, field, 'set')).toBeNull()
    expect(ownSetter).not.toHaveBeenCalled()
    expect(events).toEqual(['input', 'change'])
    el.addEventListener('input', () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, 'reset'))
    expect(formFieldOperation.call(el, field, 'set')).toMatch(/retain/)
  })

  it('selects exact option values', () => {
    const select = input('<select><option value="a">A</option><option value="b">B</option></select>')
    expect(formFieldOperation.call(select, { action: 'select', ref: 'r', value: 'b' }, 'set')).toEqual({ selectedValue: 'b' })
    expect(formFieldOperation.call(select, { action: 'select', ref: 'r', value: 'missing' }, 'validate')).toMatch(/unavailable/)
  })

  it('selects unique enabled labels or text and verifies the resolved HTML value', () => {
    const el = input('<select><option value="">Choose</option><option value="ca" label="Canada">Canadian destination</option></select>') as HTMLSelectElement
    for (const label of ['Canada', 'Canadian destination', ' Canada ']) {
      const field = { action: 'select', ref: 'r', value: label } as const
      expect(formFieldOperation.call(el, field, 'validate')).toBeNull()
      expect(formFieldOperation.call(el, field, 'set')).toEqual({ selectedValue: 'ca' })
      expect(el.value).toBe('ca')
      expect(formFieldOperation.call(el, field, 'verify', 'ca')).toBeNull()
    }
  })

  it('gives exact option values precedence over labels and rejects disabled exact values', () => {
    const el = input('<select><option value="us">Canada</option><option value="Canada">Other country</option></select>') as HTMLSelectElement
    const field = { action: 'select', ref: 'r', value: 'Canada' } as const
    expect(formFieldOperation.call(el, field, 'set')).toEqual({ selectedValue: 'Canada' })
    expect(el.selectedIndex).toBe(1)
    el.options[1]!.disabled = true
    expect(formFieldOperation.call(el, field, 'set')).toMatch(/unavailable/)
  })

  it('ignores disabled label matches, including disabled optgroups', () => {
    const el = input('<select><option value="disabled" disabled>Canada</option><optgroup disabled><option value="group">Canada</option></optgroup><option value="ca">Canada</option></select>') as HTMLSelectElement
    expect(formFieldOperation.call(el, { action: 'select', ref: 'r', value: 'Canada' }, 'set')).toEqual({ selectedValue: 'ca' })
    el.options[2]!.disabled = true
    expect(formFieldOperation.call(el, { action: 'select', ref: 'r', value: 'Canada' }, 'validate')).toMatch(/unavailable/)
  })

  it.each([
    '<select><option value="a">Same</option><option value="b">Same</option></select>',
    '<select><option value="a" label="Same">First</option><option value="b">Same</option></select>',
    '<select><option value="Same">First</option><option value="Same">Second</option></select>',
  ])('rejects ambiguous matches without events or mutation: %s', html => {
    const el = input(html) as HTMLSelectElement
    const before = el.value
    const event = vi.fn()
    el.addEventListener('input', event)
    for (const mode of ['validate', 'set'] as const) expect(formFieldOperation.call(el, { action: 'select', ref: 'r', value: 'Same' }, mode)).toMatch(/ambiguous/)
    expect(el.value).toBe(before)
    expect(event).not.toHaveBeenCalled()
  })

  it('does not redirect verification when labels later map to another value', () => {
    const el = input('<select><option value="a">Alpha</option><option value="b">Beta</option></select>') as HTMLSelectElement
    const field = { action: 'select', ref: 'r', value: 'Alpha' } as const
    expect(formFieldOperation.call(el, field, 'set')).toEqual({ selectedValue: 'a' })
    el.options[0]!.text = 'Old label'
    el.options[1]!.text = 'Alpha'
    expect(formFieldOperation.call(el, field, 'verify', 'a')).toBeNull()
    el.value = 'b'
    expect(formFieldOperation.call(el, field, 'verify', 'a')).toMatch(/did not retain/)
  })

  it.each(['checkbox', 'radio'])('uses native %s activation with one click/input/change and no duplicate events', type => {
    const el = input(`<input type="${type}">`) as HTMLInputElement
    const ownClick = vi.fn()
    el.click = ownClick // use the prototype, never a page-owned instance override
    const events: string[] = []
    let applicationChecked = false
    el.addEventListener('click', () => { applicationChecked = el.checked })
    for (const event of ['click', 'input', 'change']) el.addEventListener(event, () => events.push(event))
    const field = { action: 'check', ref: 'r', checked: true } as const
    expect(formFieldOperation.call(el, field, 'validate')).toBeNull()
    expect(events).toEqual([])
    expect(formFieldOperation.call(el, field, 'set')).toBeNull()
    expect(events).toEqual(['click', 'input', 'change'])
    expect(ownClick).not.toHaveBeenCalled()
    expect(applicationChecked).toBe(true)
    expect(formFieldOperation.call(el, field, 'verify')).toBeNull()
    expect(formFieldOperation.call(el, field, 'set')).toBeNull()
    expect(el.checked).toBe(true)
    expect(events).toEqual(['click', 'input', 'change']) // no-op, not another toggle
  })

  it.each(['checkbox', 'radio'])('does not activate an already unchecked %s', type => {
    const el = input(`<input type="${type}">`) as HTMLInputElement
    const event = vi.fn()
    for (const name of ['click', 'input', 'change']) el.addEventListener(name, event)
    expect(formFieldOperation.call(el, { action: 'check', ref: 'r', checked: false }, 'set')).toBeNull()
    expect(el.checked).toBe(false)
    expect(event).not.toHaveBeenCalled()
  })

  it('unchecks a checkbox through native activation and rejects direct radio unchecking', () => {
    const checkbox = input('<input type="checkbox" checked>') as HTMLInputElement
    const events: string[] = []
    for (const name of ['click', 'input', 'change']) checkbox.addEventListener(name, () => events.push(name))
    expect(formFieldOperation.call(checkbox, { action: 'check', ref: 'r', checked: false }, 'set')).toBeNull()
    expect(checkbox.checked).toBe(false)
    expect(events).toEqual(['click', 'input', 'change'])
    const radio = input('<input type="radio" checked>') as HTMLInputElement
    const click = vi.fn()
    radio.addEventListener('click', click)
    for (const mode of ['validate', 'set'] as const) {
      expect(formFieldOperation.call(radio, { action: 'check', ref: 'r', checked: false }, mode)).toMatch(/cannot be safely unchecked/)
    }
    expect(radio.checked).toBe(true)
    expect(click).not.toHaveBeenCalled()
  })

  it('reports failed verification when checkbox activation is canceled', () => {
    const el = input('<input type="checkbox">') as HTMLInputElement
    el.addEventListener('click', event => event.preventDefault())
    expect(formFieldOperation.call(el, { action: 'check', ref: 'r', checked: true }, 'set')).toMatch(/did not retain/)
    expect(el.checked).toBe(false)
  })

  it.each(['<button>Submit</button>', '<button type="button">Button</button>', '<input type="submit">', '<input type="button">', '<a href="#">Link</a>', '<div role="checkbox">Custom</div>', '<input type="checkbox" disabled>'])('never activates an invalid checked target: %s', html => {
    const form = input(`<form>${html}</form>`)
    const el = form.firstElementChild as HTMLElement
    const event = vi.fn()
    for (const name of ['click', 'submit', 'input', 'change']) form.addEventListener(name, event)
    for (const mode of ['validate', 'set'] as const) {
      expect(formFieldOperation.call(el, { action: 'check', ref: 'r', checked: true }, mode)).not.toBeNull()
    }
    expect(event).not.toHaveBeenCalled()
  })

  it.each(['<input type="file">', '<button>Submit</button>', '<input disabled>', '<input readonly>'])('rejects unsafe/noneditable targets %s', html => {
    expect(formFieldOperation.call(input(html), { action: 'fill', ref: 'r', value: 'x' }, 'validate')).not.toBeNull()
  })

  it('detects replacement during an event', () => {
    const el = input('<input>')
    el.addEventListener('input', () => el.remove())
    expect(formFieldOperation.call(el, { action: 'fill', ref: 'r', value: 'x' }, 'set')).toMatch(/replaced/)
  })
})

async function executorFixture(fail?: { index: number; mode: string }) {
  const calls: Array<[number, string]> = []
  const sendCommand = vi.fn(async (_tab, method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: String(params.backendNodeId) } }
    if (method === 'Runtime.callFunctionOn') {
      const index = Number(params.objectId)
      const mode = params.arguments[1].value
      calls.push([index, mode])
      return { result: { value: fail?.index === index && fail.mode === mode ? 'rejected' : null } }
    }
    return {}
  })
  vi.stubGlobal('chrome', { debugger: { attach: vi.fn(), sendCommand }, tabs: { get: vi.fn(async () => ({ url: 'https://example.com' })) } })
  const executor = new TabExecutor()
  await executor.attach(1)
  Object.assign(executor, { lastSnapshot: { refToBackendNodeId: new Map([['a', 1], ['b', 2], ['c', 3]]) } })
  return { executor, calls, sendCommand }
}
const fields = ['a', 'b', 'c'].map(ref => ({ action: 'fill', ref, value: 'x' }))

describe('batch executor', () => {
  it('prevalidates all targets and then sets/verifies sequentially', async () => {
    const { executor, calls } = await executorFixture()
    expect((await executor.fillForm({ fields })).fields.map(f => f.status)).toEqual(['success', 'success', 'success'])
    expect(calls.slice(0, 3)).toEqual([[1, 'validate'], [2, 'validate'], [3, 'validate']])
    expect(calls.filter(c => c[1] !== 'validate')).toEqual([[1, 'set'], [1, 'verify'], [2, 'set'], [2, 'verify'], [3, 'set'], [3, 'verify'], [1, 'verify'], [2, 'verify'], [3, 'verify']])
    expect(calls.filter(c => c[1] === 'validate')).toHaveLength(fields.length)
    expect(calls).toHaveLength(4 * fields.length)
    expect(retryableAfterReattach('fillForm')).toBe(false)
  })
  it('detects a 30ms async input rollback before reporting final success', async () => {
    const { executor, sendCommand } = await executorFixture()
    const el = input('<input value="old">') as HTMLInputElement
    el.addEventListener('input', () => { setTimeout(() => { el.value = 'old' }, 30) })
    const original = sendCommand.getMockImplementation()!
    const verificationValues: string[] = []
    sendCommand.mockImplementation(async (...args) => {
      if (args[1] === 'Runtime.evaluate') {
        expect(args[2].awaitPromise).toBe(true)
        await waitForDomQuiet(100, 750)
        return {}
      }
      if (args[1] === 'Runtime.callFunctionOn') {
        expect(args[2].objectId).toBe('1')
        const mode = args[2].arguments[1].value
        if (mode === 'verify') verificationValues.push(el.value)
        return { result: { value: formFieldOperation.call(el, args[2].arguments[0].value, mode) } }
      }
      return original(...args)
    })
    const result = await executor.fillForm({ fields: [fields[0]] })
    expect(verificationValues).toEqual(['x', 'old'])
    expect(result.fields[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/did not retain/) })
    expect(el.value).toBe('old')
    expect(sendCommand.mock.calls.filter(call => call[1] === 'DOM.resolveNode')).toHaveLength(1)
    expect(sendCommand.mock.calls.at(-1)?.[1]).toBe('Runtime.releaseObjectGroup')
  })
  it('rejects duplicate refs before any CDP calls or writes', async () => {
    const { executor, sendCommand } = await executorFixture()
    sendCommand.mockClear()
    await expect(executor.fillForm({ fields: [fields[0], fields[0]] })).rejects.toThrow('Invalid fillForm')
    expect(sendCommand).not.toHaveBeenCalled()
  })
  it('does not mutate anything if prevalidation fails', async () => {
    const { executor, calls, sendCommand } = await executorFixture({ index: 2, mode: 'validate' })
    expect((await executor.fillForm({ fields })).fields.map(f => f.status)).toEqual(['skipped', 'failed', 'skipped'])
    expect(calls.some(c => c[1] === 'set')).toBe(false)
    expect(sendCommand.mock.calls.some(call => call[1] === 'Runtime.evaluate')).toBe(false)
  })
  it('preserves partial progress and skips the rest after verification failure', async () => {
    const { executor, calls } = await executorFixture({ index: 2, mode: 'verify' })
    expect((await executor.fillForm({ fields })).fields.map(f => f.status)).toEqual(['success', 'failed', 'skipped'])
    expect(calls).not.toContainEqual([3, 'set'])
  })
  it('stops on navigation after an event without retrying or filling the next field', async () => {
    const { executor, sendCommand, calls } = await executorFixture()
    const original = sendCommand.getMockImplementation()!
    sendCommand.mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[1] === 'Runtime.callFunctionOn' && args[2].arguments[1].value === 'set') {
        vi.mocked(chrome.tabs.get).mockResolvedValue({ url: 'https://example.com/next' } as chrome.tabs.Tab)
      }
      return result
    })
    const result = await executor.fillForm({ fields })
    expect(result.fields.map(f => f.status)).toEqual(['failed', 'skipped', 'skipped'])
    expect(calls).not.toContainEqual([2, 'set'])
  })
  it('stops when a later target is replaced by an earlier field event', async () => {
    const { executor, sendCommand, calls } = await executorFixture()
    const original = sendCommand.getMockImplementation()!
    let mutated = false
    sendCommand.mockImplementation(async (...args) => {
      if (args[1] === 'Runtime.callFunctionOn') {
        const mode = args[2].arguments[1].value
        if (mutated && args[2].objectId === '2') return { result: { value: 'Target was replaced' } }
        if (mode === 'set') mutated = true
      }
      return original(...args)
    })
    expect((await executor.fillForm({ fields })).fields.map(f => f.status)).toEqual(['success', 'failed', 'skipped'])
    expect(calls).not.toContainEqual([2, 'set'])
  })
  it('final-verifies all successes even if several earlier values were undone', async () => {
    const { executor, sendCommand, calls } = await executorFixture()
    const original = sendCommand.getMockImplementation()!
    let allWritten = false
    sendCommand.mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[1] === 'Runtime.callFunctionOn') {
        const mode = args[2].arguments[1].value
        if (args[2].objectId === '3' && mode === 'set') allWritten = true
        if (allWritten && args[2].objectId !== '3' && mode === 'verify') return { result: { value: 'Field did not retain the requested value.' } }
      }
      return result
    })
    expect((await executor.fillForm({ fields })).fields.map(f => f.status)).toEqual(['failed', 'failed', 'success'])
    expect(calls.slice(-3)).toEqual([[1, 'verify'], [2, 'verify'], [3, 'verify']])
  })
  it('final-verifies earlier successes after a later write fails', async () => {
    const { executor, sendCommand } = await executorFixture()
    const original = sendCommand.getMockImplementation()!
    let failed = false
    sendCommand.mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[1] === 'Runtime.callFunctionOn') {
        const mode = args[2].arguments[1].value
        if (args[2].objectId === '2' && mode === 'set') {
          failed = true
          return { result: { value: 'Event replaced controls' } }
        }
        if (failed && args[2].objectId === '1' && mode === 'verify') return { result: { value: 'Earlier value reset' } }
      }
      return result
    })
    expect((await executor.fillForm({ fields })).fields.map(f => f.status)).toEqual(['failed', 'failed', 'skipped'])
  })
  it('detects actual radio-group side effects at final verification', async () => {
    const { executor, sendCommand } = await executorFixture()
    document.body.innerHTML = '<input type="radio" name="group"><input type="radio" name="group">'
    const radios = Array.from(document.querySelectorAll('input'))
    const original = sendCommand.getMockImplementation()!
    sendCommand.mockImplementation(async (...args) => {
      if (args[1] === 'Runtime.callFunctionOn') {
        return { result: { value: formFieldOperation.call(radios[Number(args[2].objectId) - 1]!, args[2].arguments[0].value, args[2].arguments[1].value) } }
      }
      return original(...args)
    })
    const result = await executor.fillForm({ fields: [{ action: 'check', ref: 'a', checked: true }, { action: 'check', ref: 'b', checked: true }] })
    expect(result.fields.map(f => f.status)).toEqual(['failed', 'success'])
    expect(radios.map(r => r.checked)).toEqual([false, true])
  })
  it('retains the resolved select value for final verification after later field events', async () => {
    const { executor, sendCommand } = await executorFixture()
    document.body.innerHTML = '<select><option value="a">Alpha</option><option value="b">Beta</option></select><input>'
    const select = document.querySelector('select')!
    const text = document.querySelector('input')!
    text.addEventListener('input', () => {
      select.options[0]!.text = 'Old label'
      select.options[1]!.text = 'Alpha'
      select.value = 'b'
    })
    const nodes = [select, text]
    const original = sendCommand.getMockImplementation()!
    sendCommand.mockImplementation(async (...args) => {
      if (args[1] === 'Runtime.callFunctionOn') return { result: { value: formFieldOperation.call(nodes[Number(args[2].objectId) - 1]!, args[2].arguments[0].value, args[2].arguments[1].value, args[2].arguments[2]?.value) } }
      return original(...args)
    })
    const result = await executor.fillForm({ fields: [{ action: 'select', ref: 'a', value: 'Alpha' }, { action: 'fill', ref: 'b', value: 'hello' }] })
    expect(result.fields.map(f => f.status)).toEqual(['failed', 'success'])
    expect(result.fields[0]?.error).toMatch(/did not retain/)
  })
  it('prevalidates real DOM types before performing any writes', async () => {
    const { executor, sendCommand } = await executorFixture()
    document.body.innerHTML = '<input><button>Submit</button><input>'
    const nodes = Array.from(document.body.children) as HTMLElement[]
    const original = sendCommand.getMockImplementation()!
    const events = vi.fn()
    nodes[0]!.addEventListener('input', events)
    sendCommand.mockImplementation(async (...args) => {
      if (args[1] === 'Runtime.callFunctionOn') return { result: { value: formFieldOperation.call(nodes[Number(args[2].objectId) - 1]!, args[2].arguments[0].value, args[2].arguments[1].value) } }
      return original(...args)
    })
    expect((await executor.fillForm({ fields })).fields.map(f => f.status)).toEqual(['skipped', 'failed', 'skipped'])
    expect((nodes[0] as HTMLInputElement).value).toBe('')
    expect(events).not.toHaveBeenCalled()
  })
  it('refuses a detached current target immediately before writing and skips the rest', async () => {
    const { executor, sendCommand } = await executorFixture()
    document.body.innerHTML = '<input><input><input>'
    const nodes = Array.from(document.querySelectorAll('input'))
    nodes[0]!.addEventListener('input', () => nodes[1]!.remove())
    const original = sendCommand.getMockImplementation()!
    sendCommand.mockImplementation(async (...args) => {
      if (args[1] === 'Runtime.callFunctionOn') return { result: { value: formFieldOperation.call(nodes[Number(args[2].objectId) - 1]!, args[2].arguments[0].value, args[2].arguments[1].value) } }
      return original(...args)
    })
    expect((await executor.fillForm({ fields })).fields.map(f => f.status)).toEqual(['success', 'failed', 'skipped'])
    expect(nodes.map(n => n.value)).toEqual(['x', '', ''])
  })
  it('rejects stale refs before mutations', async () => {
    const { executor, calls } = await executorFixture()
    const result = await executor.fillForm({ fields: [...fields, { action: 'fill', ref: 'missing', value: '' }] })
    expect(result.fields[3]?.status).toBe('failed')
    expect(calls.some(c => c[1] === 'set')).toBe(false)
  })
})
