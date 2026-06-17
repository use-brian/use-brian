/**
 * URL property — clickable link cell. Server bindings emit a bare
 * `string` (the URL itself) or `null`. Empty cells render an em-dash.
 *
 * Cell: an `<a target="_blank" rel="noopener noreferrer">` with a small
 * favicon (16px) sourced from Google's s2 service + truncated label.
 * Falls back to the link icon glyph when the favicon fails to load.
 *
 * Phase-2 editor: `<input type="url">` with onBlur / Enter commit.
 *
 * Validation: a committed value must start with `http://` or `https://`.
 * Other values cancel — sustaining the invariant that the Cell renders a
 * safe href. Empty input commits `null` to clear the cell.
 *
 * [COMP:views/property-url]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

/**
 * Accept-list for a committable URL. We deliberately stay narrow: only
 * `http(s)` schemes pass. `mailto:`, `tel:`, `javascript:` etc. live in
 * their own property kinds (email/phone) or are blocked entirely.
 */
function isValidUrl(s: string): boolean {
  return /^https?:\/\/[^\s]+/i.test(s)
}

function asUrl(v: A2UIRowValue): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    if (v.length === 0) return null
    return v
  }
  if (typeof v === 'number') return String(v)
  return null
}

/**
 * Drop the scheme + leading `www.` for compact in-cell display. Falls
 * back to the original string when URL parsing fails.
 */
function shortLabel(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const path = u.pathname === '/' ? '' : u.pathname
    return host + path
  } catch {
    return url
  }
}

function faviconFor(url: string): string | null {
  try {
    const u = new URL(url)
    // Google's s2 service is the same source the Chrome new-tab grid
    // uses — no auth needed, ~16px PNG.
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=32`
  } catch {
    return null
  }
}

function LinkGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className="h-3 w-3 shrink-0 text-muted-foreground">
      <path d="M6.5 9.5l3-3M5 7H3.5a2.5 2.5 0 0 0 0 5H5M11 9h1.5a2.5 2.5 0 0 0 0-5H11" strokeLinecap="round" />
    </svg>
  )
}

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const url = asUrl(props.value)
  if (!url || !isValidUrl(url)) return <Empty />
  const fav = faviconFor(url)
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline"
    >
      {fav ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fav}
          alt=""
          width={16}
          height={16}
          className="h-4 w-4 shrink-0 rounded-sm"
          loading="lazy"
        />
      ) : (
        <LinkGlyph />
      )}
      <span className="truncate">{shortLabel(url)}</span>
    </a>
  )
}

function Editor(props: PropertyEditorProps): JSX.Element {
  const initial = asUrl(props.value) ?? ''
  const [draft, setDraft] = useState<string>(initial)
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  function commit(): void {
    const next = draft.trim()
    if (next === initial.trim()) {
      props.onCancel()
      return
    }
    if (next.length === 0) {
      props.onCommit(null)
      return
    }
    if (!isValidUrl(next)) {
      // Invalid scheme — refuse to commit. Cancel rather than throw so
      // the user can re-edit without losing context.
      props.onCancel()
      return
    }
    props.onCommit(next)
  }

  return (
    <input
      ref={ref}
      type="url"
      inputMode="url"
      className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/40"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          props.onCancel()
        }
      }}
      onBlur={commit}
    />
  )
}

function Icon(props: { className?: string }): JSX.Element {
  // Lucide Link-style chain link, hand-rolled inline SVG.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <path d="M6.5 9.5l3-3" strokeLinecap="round" />
      <path d="M5 7H3.5a2.5 2.5 0 0 0 0 5H5" strokeLinecap="round" />
      <path d="M11 9h1.5a2.5 2.5 0 0 0 0-5H11" strokeLinecap="round" />
    </svg>
  )
}

function sortKey(v: A2UIRowValue): string | null {
  const u = asUrl(v)
  if (!u) return null
  return u.toLowerCase()
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const ak = sortKey(a)
  const bk = sortKey(b)
  if (ak === bk) return 0
  if (ak === null) return 1
  if (bk === null) return -1
  return ak.localeCompare(bk)
}

export const UrlProperty: PropertyModule = {
  kind: 'url',
  Cell,
  Editor,
  Icon,
  sortFn,
}

// Re-export pure helpers for unit tests.
export const __test = { isValidUrl, shortLabel }
