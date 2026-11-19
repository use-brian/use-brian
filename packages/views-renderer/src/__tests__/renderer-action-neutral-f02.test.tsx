/** [COMP:views/properties] Renderer-owned chrome and editor callback contracts.
 * Hook harness: inspect real JSX/handlers without a DOM dependency. These are
 * unit checks, not browser assertions about native paint or focus management.
 */
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '../widgets/Button.js'
import { CheckboxProperty } from '../properties/checkbox.js'
import { FilesProperty } from '../properties/files.js'
import type { PropertyEditorProps } from '../properties/types.js'
import type { FileRef } from '../types.js'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: (initial: unknown) => {
      const index = hooks.cursor++
      if (!(index in hooks.values)) hooks.values[index] = initial
      return [hooks.values[index], (next: unknown) => {
        hooks.values[index] = typeof next === 'function'
          ? (next as (previous: unknown) => unknown)(hooks.values[index])
          : next
      }]
    },
  }
})

type Element = ReactElement<{
  children?: Element | Element[] | string
  className?: string
  [key: string]: any
}>
function tree(root: Element): Element[] {
  const children = [root.props.children].flat(Infinity) as unknown[]
  return [root, ...children.flatMap((child) =>
    child && typeof child === 'object' && 'props' in child ? tree(child as Element) : [])]
}
function editor(module: typeof CheckboxProperty, props: PropertyEditorProps): Element {
  hooks.cursor = 0
  return module.Editor(props) as Element
}
function button(root: Element, text: string): Element {
  return tree(root).find((el) => el.type === 'button' && el.props.children === text)!
}
function checkbox(root: Element): Element {
  return tree(root).find((el) => el.type === 'input')!
}
function classes(el: Element): string[] { return el.props.className!.split(/\s+/) }
const file: FileRef = { bucket: 'file_cache', path: 'one', mimeType: 'text/plain', sizeBytes: 8, name: 'notes.txt' }

beforeEach(() => { hooks.values = []; hooks.cursor = 0 })

describe('[COMP:views/properties] F02 neutral renderer action chrome', () => {
  it('pairs neutral action tokens and focus without changing action dispatch', () => {
    const onAction = vi.fn()
    const params = { row: 'one' }
    const el = Button({ text: 'Run', action: { id: 'run', params }, onAction }) as Element
    expect(classes(el)).toEqual(expect.arrayContaining([
      'bg-action', 'text-action-foreground', 'hover:bg-action/90', 'focus-visible:outline-foreground/50',
    ]))
    expect(el.props.className).not.toContain('primary')
    expect(el.props.type).toBe('button')
    el.props.onClick()
    expect(onAction).toHaveBeenCalledExactlyOnceWith('run', params)
    expect(onAction.mock.calls[0]![1]).toBe(params)
    expect(() => (Button({ text: 'Run', action: { id: 'run' } }) as Element).props.onClick()).not.toThrow()
  })

  it('keeps the checked cell decorative, compact, disabled and read-only', () => {
    const cell = CheckboxProperty.Cell({ value: 'true' }) as Element
    expect(cell.props).toMatchObject({ checked: true, disabled: true, readOnly: true })
    expect(classes(cell)).toEqual(expect.arrayContaining(['h-3.5', 'w-3.5', 'accent-action']))
    expect(cell.props.onChange).toBeUndefined()
  })

  it('gives the enabled editor a neutral accent/focus and associated larger target', () => {
    const root = editor(CheckboxProperty, { value: null, onCommit: vi.fn(), onCancel: vi.fn() })
    const input = checkbox(root)
    expect(root.type).toBe('label')
    expect(classes(root)).toEqual(expect.arrayContaining(['h-11', 'w-11', 'md:h-auto', 'md:w-auto', '[@media(pointer:coarse)]:h-11']))
    expect(input.props['aria-label']).toBeTruthy()
    expect(input.props.disabled).toBeUndefined()
    expect(input.props.checked).toBe(false)
    expect(classes(input)).toEqual(expect.arrayContaining(['accent-action', 'focus-visible:outline-foreground/50']))
  })

  it.each([
    ['false', true, 'true'], ['true', false, 'false'], [null, true, 'true'],
  ] as const)('commits a flipped %s value with the existing string wire shape', (value, checked, expected) => {
    const props = { value, onCommit: vi.fn(), onCancel: vi.fn() }
    const input = checkbox(editor(CheckboxProperty, props))
    input.props.onChange({ target: { checked } })
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(expected)
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(checkbox(editor(CheckboxProperty, props)).props.checked).toBe(checked)
  })

  it('cancels an unchanged checkbox and handles Escape without committing', () => {
    const props = { value: 'true', onCommit: vi.fn(), onCancel: vi.fn() }
    const input = checkbox(editor(CheckboxProperty, props))
    input.props.onChange({ target: { checked: true } })
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    const preventDefault = vi.fn()
    input.props.onKeyDown({ key: 'Escape', preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(props.onCancel).toHaveBeenCalledTimes(2)
    input.props.onKeyDown({ key: 'Enter', preventDefault })
    expect(props.onCancel).toHaveBeenCalledTimes(2)
    expect(props.onCommit).not.toHaveBeenCalled()
  })

  it('uses neutral file Save/drop/focus chrome and preserves uploading disabled gates', () => {
    const props = { value: null, onCommit: vi.fn(), onCancel: vi.fn() }
    let root = editor(FilesProperty, props)
    expect(classes(button(root, 'Save'))).toEqual(expect.arrayContaining(['border-action', 'bg-action', 'text-action-foreground', 'hover:bg-action/90']))
    for (const control of tree(root).filter((el) => el.type === 'button')) {
      expect(classes(control)).toContain('focus-visible:outline-foreground/50')
    }
    const drop = tree(root).find((el) => el.props.onDragOver)!
    const preventDefault = vi.fn()
    drop.props.onDragOver({ preventDefault })
    root = editor(FilesProperty, props)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(tree(root).find((el) => el.props.onDrop)!.props.className).toContain('border-foreground/50 bg-foreground/10')
    expect(tree(root).map((el) => el.props.className ?? '').join(' ')).not.toContain('primary')
    hooks.values[1] = true // files editor's uploading state
    root = editor(FilesProperty, props)
    expect(button(root, 'Save').props.disabled).toBe(true)
    expect(button(root, 'Pick').props.disabled).toBe(true)
    expect(button(root, 'Cancel').props.disabled).toBeUndefined()
  })

  it('preserves file Save no-op cancellation, explicit Cancel and removal-to-null commit', () => {
    const props = { value: { type: 'files' as const, files: [file] }, onCommit: vi.fn(), onCancel: vi.fn() }
    let root = editor(FilesProperty, props)
    button(root, 'Save').props.onClick()
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    button(root, 'Cancel').props.onClick()
    expect(props.onCancel).toHaveBeenCalledTimes(2)
    expect(props.onCommit).not.toHaveBeenCalled()
    const remove = tree(root).find((el) => el.props['aria-label'] === 'Remove notes.txt')!
    const preventDefault = vi.fn()
    remove.props.onMouseDown({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    root = editor(FilesProperty, props)
    button(root, 'Save').props.onClick()
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('commits an edited attachment list as a files widget', () => {
    const props = { value: null, onCommit: vi.fn(), onCancel: vi.fn() }
    editor(FilesProperty, props)
    hooks.values[0] = [file]
    button(editor(FilesProperty, props), 'Save').props.onClick()
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith({ type: 'files', files: [file] })
    expect(props.onCancel).not.toHaveBeenCalled()
  })
})
