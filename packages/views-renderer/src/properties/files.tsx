/**
 * Files property — file attachments inside a DB cell.
 *
 * The cell value is a `FilesWidget` (`{ type: 'files', files: FileRef[] }`)
 * — server bindings emit one per row that owns a `PropertyKind = 'files'`
 * column. Mirrors the shape carried by `CellValue.kind = 'files'` in
 * `packages/core/src/entities/doc-types.ts`, so the JSONB cell value
 * round-trips through the wire envelope without coercion.
 *
 * Cell render:
 *   - Empty (no widget, or `files: []`) → em-dash.
 *   - First image-mime file becomes a 16:9 lazy-loaded cover thumbnail
 *     (Gallery view consumes the same widget through `getCoverImageRef`
 *     — exporting that helper here keeps the policy in one place).
 *   - Up to 3 file pills (icon + name + size) stack below the cover.
 *     Overflow renders a `+N more` chip so a 12-file cell still fits the
 *     row height.
 *
 * Phase-2 editor: a drop-zone + multi-file `<input type="file">` picker.
 * Each picked file uploads via `POST /api/files/upload` (the existing
 * route — see `packages/api/src/routes/files.ts`) and the resolved
 * `FileRef` is appended to the cell's array. On success, the editor
 * commits the merged `FilesWidget`. Errors land in an inline
 * `role="alert"` line.
 *
 * sortFn: by count, then alphabetical on the first file name. Mirrors
 * the count→alpha sort that `tags.tsx` uses, so multi-value cells share
 * one mental model.
 *
 * validate: each `FileRef` carries all five required fields and a
 * non-negative `sizeBytes`. Used by the host to reject malformed
 * commits before they reach the server.
 *
 * [COMP:views/property-files]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue, FileRef, FilesWidget } from '../types.js'
import type { PropertyCellProps, PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

// Default upload endpoint. Host bundles (apps/app-web, apps/web) inject
// the API origin via the `NEXT_PUBLIC_API_URL` env var; when this package
// is used inside a chat surface that already proxies `/api/...`, the
// relative path works without modification.
function uploadEndpoint(): string {
  const env =
    (typeof process !== 'undefined'
      ? (process as { env?: Record<string, string | undefined> }).env
      : undefined) ?? {}
  const base = env.NEXT_PUBLIC_API_URL
  if (typeof base === 'string' && base.length > 0) {
    return `${base.replace(/\/+$/, '')}/api/files/upload`
  }
  return '/api/files/upload'
}

// ── Shape helpers ────────────────────────────────────────────────────

/**
 * Coerce an A2UIRowValue into a `FilesWidget`-shaped list. Returns the
 * underlying ref array, or `null` when the cell carries no files. An
 * empty `files: []` widget round-trips as an empty array (the Cell
 * renders that as `<Empty />`; the Editor still shows the drop zone).
 */
function asFiles(v: A2UIRowValue): FileRef[] | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && v.type === 'files') {
    return Array.isArray(v.files) ? v.files : []
  }
  return null
}

function isImageMime(mime: string): boolean {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/')
}

/**
 * Pick the first image-mime ref from a cell value, or `null` when none
 * exists. Gallery view (P3F) consumes this to decide whether a row gets
 * a card cover image. Exported so the policy lives next to the Cell —
 * if we ever change "first image wins" to "tagged-cover wins", both
 * surfaces flip together.
 */
export function getCoverImageRef(value: A2UIRowValue): FileRef | null {
  const refs = asFiles(value)
  if (!refs || refs.length === 0) return null
  for (const ref of refs) {
    if (isImageMime(ref.mimeType)) return ref
  }
  return null
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Resolve a `FileRef` to a browser-loadable preview URL. Mirrors the
 * `signedReadUrlFor` helper inside `block-image.tsx` — the upload route
 * still writes to the legacy `file_cache` Postgres table, so the preview
 * route streams those bytes inline. True GCS refs return `null` until
 * the signed-URL endpoint lands (P2D).
 */
function previewUrlFor(ref: FileRef): string | null {
  const env =
    (typeof process !== 'undefined'
      ? (process as { env?: Record<string, string | undefined> }).env
      : undefined) ?? {}
  const base = env.NEXT_PUBLIC_API_URL ?? ''
  if (ref.bucket === 'file_cache') {
    const prefix = base.length > 0 ? base.replace(/\/+$/, '') : ''
    return `${prefix}/api/files/${encodeURIComponent(ref.path)}/preview`
  }
  return null
}

// ── Validation ────────────────────────────────────────────────────────

function isValidFileRef(r: unknown): r is FileRef {
  if (r === null || typeof r !== 'object') return false
  const ref = r as Record<string, unknown>
  return (
    typeof ref.bucket === 'string' && ref.bucket.length > 0 &&
    typeof ref.path === 'string' && ref.path.length > 0 &&
    typeof ref.mimeType === 'string' && ref.mimeType.length > 0 &&
    typeof ref.sizeBytes === 'number' && Number.isFinite(ref.sizeBytes) && ref.sizeBytes >= 0 &&
    typeof ref.name === 'string' && ref.name.length > 0
  )
}

function validate(value: A2UIRowValue): boolean {
  if (value === null || value === undefined) return true
  if (typeof value !== 'object') return false
  if (value.type !== 'files') return false
  const w = value as FilesWidget
  if (!Array.isArray(w.files)) return false
  return w.files.every(isValidFileRef)
}

// ── Cell render ──────────────────────────────────────────────────────

const PILL_THRESHOLD = 3

function FilePillGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className="h-3 w-3 shrink-0 text-muted-foreground"
         aria-hidden>
      <path d="M3 2.5h6L13 6.5v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" strokeLinejoin="round" />
      <path d="M9 2.5V6.5h4" strokeLinejoin="round" />
    </svg>
  )
}

function FilePill(props: { ref: FileRef }): JSX.Element {
  const r = props.ref
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-xs text-foreground/85"
      title={`${r.name} (${formatBytes(r.sizeBytes)})`}
    >
      <FilePillGlyph />
      <span className="max-w-[12ch] truncate">{r.name}</span>
      <span className="text-muted-foreground tabular-nums">{formatBytes(r.sizeBytes)}</span>
    </span>
  )
}

function Cover(props: { ref: FileRef }): JSX.Element {
  const url = previewUrlFor(props.ref)
  if (!url) {
    return (
      <span
        className="block aspect-[16/9] w-full rounded-md border border-dashed border-border bg-muted/30"
        aria-label={props.ref.name}
      />
    )
  }
  return (
    <img
      src={url}
      alt={props.ref.name}
      loading="lazy"
      className="block aspect-[16/9] w-full rounded-md border border-border bg-background object-cover"
    />
  )
}

function Cell(props: PropertyCellProps): JSX.Element {
  const refs = asFiles(props.value)
  if (!refs || refs.length === 0) return <Empty />
  const cover = getCoverImageRef(props.value)
  const visible = refs.slice(0, PILL_THRESHOLD)
  const overflow = refs.length - visible.length
  return (
    <span className="inline-flex w-full flex-col items-start gap-1">
      {cover && <Cover ref={cover} />}
      <span className="inline-flex flex-wrap items-center gap-1">
        {visible.map((r, i) => (
          <FilePill key={`${r.bucket}:${r.path}:${i}`} ref={r} />
        ))}
        {overflow > 0 && (
          <span className="inline-flex items-center rounded-md bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground">
            +{overflow} more
          </span>
        )}
      </span>
    </span>
  )
}

// ── Editor ────────────────────────────────────────────────────────────

type UploadResponse = {
  files: Array<{
    id?: string
    fileName?: string
    mimeType?: string
    sizeBytes?: number
    error?: string
  }>
}

/**
 * Upload one File via `POST /api/files/upload`, resolving to a `FileRef`
 * on success. Throws on any non-2xx or any per-file error from the
 * existing route. Sink encoded as `bucket: 'file_cache'` to match the
 * legacy upload sink (see `block-image.tsx` for the same encoding).
 */
async function uploadOne(file: File): Promise<FileRef> {
  const form = new FormData()
  form.append('files', file)
  const res = await fetch(uploadEndpoint(), {
    method: 'POST',
    body: form,
    credentials: 'include',
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  const data = (await res.json()) as UploadResponse
  const first = data.files?.[0]
  if (!first || first.error || !first.id) {
    throw new Error(first?.error ?? 'Upload failed')
  }
  return {
    bucket: 'file_cache',
    path: first.id,
    mimeType: first.mimeType ?? file.type,
    sizeBytes: first.sizeBytes ?? file.size,
    name: first.fileName ?? file.name,
  }
}

function toFilesWidget(files: FileRef[]): FilesWidget {
  return { type: 'files', files }
}

function Editor(props: PropertyEditorProps): JSX.Element {
  const initial = asFiles(props.value) ?? []
  const [files, setFiles] = useState<FileRef[]>(initial)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    // Focus the picker button so keyboard activation lands without
    // requiring a mouse — matches the rest of the property editors.
    inputRef.current?.focus?.()
  }, [])

  function commit(next: FileRef[]): void {
    const same =
      next.length === initial.length &&
      next.every((r, i) => r.path === initial[i]?.path && r.bucket === initial[i]?.bucket)
    if (same) {
      props.onCancel()
      return
    }
    if (next.length === 0) {
      props.onCommit(null)
      return
    }
    props.onCommit(toFilesWidget(next))
  }

  async function handleSelected(picked: FileList | null): Promise<void> {
    if (!picked || picked.length === 0) return
    setError(null)
    setUploading(true)
    try {
      const uploaded: FileRef[] = []
      for (const f of Array.from(picked)) {
        const ref = await uploadOne(f)
        uploaded.push(ref)
      }
      setFiles((prev) => [...prev, ...uploaded])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  function removeAt(idx: number): void {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setDragOver(false)
    void handleSelected(e.dataTransfer.files)
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <div
        className={
          'flex w-full items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-xs transition-colors ' +
          (dragOver
            ? 'border-primary bg-primary/10 text-foreground'
            : 'border-border bg-muted/20 text-muted-foreground')
        }
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <span>{uploading ? 'Uploading…' : 'Drop files or pick from disk'}</span>
        <button
          ref={inputRef as unknown as React.RefObject<HTMLButtonElement>}
          type="button"
          disabled={uploading}
          onClick={() => {
            const inp = document.createElement('input')
            inp.type = 'file'
            inp.multiple = true
            inp.onchange = () => {
              void handleSelected(inp.files)
            }
            inp.click()
          }}
          className="rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          Pick
        </button>
      </div>

      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((r, i) => (
            <li
              key={`${r.bucket}:${r.path}:${i}`}
              className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1 text-xs"
            >
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <FilePillGlyph />
                <span className="truncate">{r.name}</span>
                <span className="text-muted-foreground tabular-nums">{formatBytes(r.sizeBytes)}</span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${r.name}`}
                className="text-muted-foreground hover:text-foreground"
                onMouseDown={(e) => {
                  e.preventDefault()
                  removeAt(i)
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => props.onCancel()}
          className="rounded-sm border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => commit(files)}
          disabled={uploading}
          className="rounded-sm border border-primary bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Save
        </button>
      </div>
    </div>
  )
}

// ── Header icon ──────────────────────────────────────────────────────

/**
 * Paperclip glyph — hand-rolled to keep the renderer free of
 * `lucide-react` (which `block-image.tsx` consumes in `apps/app-web`
 * but is not a dep here). Same visual weight as the other property
 * icons (`h-3 w-3 text-muted-foreground`).
 */
function Icon(props: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <path d="M11 4l-5 5a2 2 0 0 0 2.83 2.83L13 7.5a3.5 3.5 0 0 0-4.95-4.95L3.6 7a5 5 0 0 0 7.07 7.07L13.5 11.25"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Sort ─────────────────────────────────────────────────────────────

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const af = asFiles(a) ?? []
  const bf = asFiles(b) ?? []
  if (af.length !== bf.length) return af.length - bf.length
  // Empty arrays sort equal; otherwise compare first names alphabetically.
  const an = af[0]?.name ?? ''
  const bn = bf[0]?.name ?? ''
  return an.localeCompare(bn)
}

export const FilesProperty: PropertyModule = {
  kind: 'files',
  Cell,
  Editor,
  Icon,
  sortFn,
  validate,
}
