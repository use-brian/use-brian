/**
 * Tags property — free-form multi-tag. Server bindings emit a Container
 * widget with Badge children (one per tag). Empty cells render as
 * em-dash.
 *
 * Phase-2 editor: comma-separated chip editor. The visible input takes
 * commas/Enter to add a chip; Backspace on an empty input removes the
 * last chip. Escape cancels. Commit returns a Container of Badge
 * widgets to match the cell-shape contract (`tagValues` recovers the
 * string list).
 *
 * [COMP:views/property-tags]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue, A2UIWidget } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Badge } from '../widgets/Badge.js'
import { Empty } from './empty.js'

function tagValues(v: A2UIRowValue): string[] | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && v.type === 'container') {
    const tags: string[] = []
    for (const child of v.children) {
      if (typeof child === 'object' && child.type === 'badge') tags.push(child.text)
    }
    return tags
  }
  if (typeof v === 'string') {
    return v.length === 0 ? [] : [v]
  }
  return null
}

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const tags = tagValues(props.value)
  if (tags === null || tags.length === 0) return <Empty />
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {tags.map((t, i) => (
        <Badge key={i} text={t} />
      ))}
    </span>
  )
}

function tagsToContainer(tags: string[]): A2UIWidget {
  return {
    type: 'container',
    direction: 'row',
    children: tags.map((t) => ({ type: 'badge', text: t })),
  }
}

function Editor(props: PropertyEditorProps): JSX.Element {
  const initial = tagValues(props.value) ?? []
  const [tags, setTags] = useState<string[]>(initial)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  function commit(nextTags: string[]): void {
    // Dedup while preserving order; drop empties.
    const seen = new Set<string>()
    const cleaned: string[] = []
    for (const t of nextTags) {
      const trimmed = t.trim()
      if (trimmed.length === 0) continue
      if (seen.has(trimmed)) continue
      seen.add(trimmed)
      cleaned.push(trimmed)
    }
    // Compare to initial — no-op if unchanged.
    const same =
      cleaned.length === initial.length &&
      cleaned.every((t, i) => t === initial[i])
    if (same) {
      props.onCancel()
      return
    }
    props.onCommit(cleaned.length === 0 ? null : tagsToContainer(cleaned))
  }

  function flushDraftAndCommit(): void {
    const pending = draft.trim()
    const next = pending.length > 0 ? [...tags, pending] : tags
    commit(next)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      flushDraftAndCommit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onCancel()
      return
    }
    if (e.key === ',') {
      e.preventDefault()
      const pending = draft.trim()
      if (pending.length > 0) {
        setTags((prev) => [...prev, pending])
        setDraft('')
      }
      return
    }
    if (e.key === 'Backspace' && draft.length === 0 && tags.length > 0) {
      e.preventDefault()
      setTags((prev) => prev.slice(0, -1))
    }
  }

  function removeChip(idx: number): void {
    setTags((prev) => prev.filter((_, i) => i !== idx))
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-1 rounded-sm border border-border bg-background px-2 py-1">
      {tags.map((t, i) => (
        <span
          key={`${t}-${i}`}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs"
        >
          {t}
          <button
            type="button"
            aria-label={`Remove ${t}`}
            className="text-muted-foreground hover:text-foreground"
            onMouseDown={(e) => {
              // Prevent input blur firing flush-commit before remove.
              e.preventDefault()
              removeChip(i)
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={ref}
        type="text"
        className="min-w-[4ch] flex-1 bg-transparent text-sm outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={flushDraftAndCommit}
      />
    </div>
  )
}

function Icon(props: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <path d="M7.5 1.5h5l1 5-6 6-5-5 5-6z" strokeLinejoin="round" />
      <circle cx="10.5" cy="4.5" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const at = tagValues(a) ?? []
  const bt = tagValues(b) ?? []
  if (at.length !== bt.length) return at.length - bt.length
  const aj = [...at].sort().join('')
  const bj = [...bt].sort().join('')
  return aj.localeCompare(bj)
}

export const TagsProperty: PropertyModule = {
  kind: 'tags',
  Cell,
  Editor,
  Icon,
  sortFn,
}
