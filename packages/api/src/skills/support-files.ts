/**
 * Support-file validation — the ONE gate every write to
 * `workspace_skill_files` passes through, whether the files arrived with an
 * import (`POST /api/skills`) or were authored by hand in the editor
 * (`PUT /api/skills/:id/files`).
 *
 * A support file's `(kind, name)` pair is half of the `{{kind:name}}` pointer
 * the loader resolves at `useSkill` time, so the name rules here are not
 * cosmetic: a name carrying `/`, `:` or `{{ }}` produces a pointer that can
 * never match its own row.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Support files".
 *
 * [COMP:api/skill-support-files]
 */

import {
  IMPORT_MAX_SUPPORT_FILES,
  IMPORT_MAX_SUPPORT_FILE_BYTES,
  IMPORT_MAX_SUPPORT_TOTAL_BYTES,
} from './import-service.js'

export const SUPPORT_FILE_KINDS = ['reference', 'template', 'script'] as const
export type SupportFileKind = (typeof SUPPORT_FILE_KINDS)[number]

export const SUPPORT_FILE_NAME_MAX = 200
export const SUPPORT_FILE_DESCRIPTION_MAX = 500

export type SupportFile = {
  kind: SupportFileKind
  name: string
  content: string
  description?: string
}

export type SupportFileValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

const KINDS = new Set<string>(SUPPORT_FILE_KINDS)

/**
 * Characters a name may not contain, derived from `POINTER_RE` in
 * `packages/core/src/skills/loader.ts` — the regex that actually resolves a
 * pointer at `useSkill` time:
 *
 *     /\{\{\s*(reference|template|script)\s*:\s*([^{}\r\n]+?)\s*\}\}/g
 *
 * Its name group excludes exactly `{`, `}`, CR and LF, so those are the only
 * characters that make a pointer unresolvable. Slashes and colons are legal
 * there ("file paths carry slashes and dots") and the curator's
 * `add_support_file` writes straight to the store without passing here — so
 * rejecting them would strand a curator-written `references/a/b.md` as a row
 * that resolves at runtime but 400s the moment a human tries to edit it.
 * That is the same invisible-to-the-owner failure these routes exist to fix,
 * so this validator matches the resolver rather than being stricter than it.
 */
const ILLEGAL_NAME_RE = /[{}\r\n]/

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** Human locator for a batch entry — its name when it has one, else its slot. */
function locate(entry: unknown, index: number): string {
  const name =
    typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string'
      ? (entry as { name: string }).name.trim()
      : ''
  return name ? `Support file ${name}` : `Support file #${index + 1}`
}

/** Validate one support file coming off the wire. */
export function validateSupportFile(raw: unknown): SupportFileValidation<SupportFile> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('Each support file must be an object.')
  }
  const input = raw as Record<string, unknown>

  const kind = input.kind
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    return fail(
      `Support file kind must be one of ${SUPPORT_FILE_KINDS.join(', ')} (got ${String(kind)}).`,
    )
  }

  if (typeof input.name !== 'string') return fail('Support file name is required.')
  const name = input.name.trim()
  if (!name) return fail('Support file name is required.')
  if (name.length > SUPPORT_FILE_NAME_MAX) {
    return fail(`Support file name must be ${SUPPORT_FILE_NAME_MAX} characters or less: ${name}`)
  }
  if (ILLEGAL_NAME_RE.test(name) || name === '.' || name === '..') {
    return fail(
      `Support file name cannot contain { } or a line break, or be a bare path segment: ${name}`,
    )
  }

  if (typeof input.content !== 'string' || !input.content) {
    return fail(`Support file ${name} has no content.`)
  }
  const bytes = Buffer.byteLength(input.content, 'utf8')
  if (bytes > IMPORT_MAX_SUPPORT_FILE_BYTES) {
    return fail(
      `Support file ${name} is ${bytes} bytes; the per-file limit is ${IMPORT_MAX_SUPPORT_FILE_BYTES}.`,
    )
  }

  const file: SupportFile = { kind: kind as SupportFileKind, name, content: input.content }

  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') {
      return fail(`Support file ${name} has a non-string description.`)
    }
    const description = input.description.trim()
    if (description.length > SUPPORT_FILE_DESCRIPTION_MAX) {
      return fail(
        `Support file ${name} description must be ${SUPPORT_FILE_DESCRIPTION_MAX} characters or less.`,
      )
    }
    if (description) file.description = description
  }

  return { ok: true, value: file }
}

/**
 * Validate a whole batch: each file, then the set-level caps (count, unique
 * `(kind, name)`, total bytes). Validating up front is what keeps a bad batch
 * from leaving a half-written skill — the rows are inserted after the parent.
 */
export function validateSupportFileSet(raw: unknown): SupportFileValidation<SupportFile[]> {
  if (!Array.isArray(raw)) return fail('supportFiles must be an array.')
  if (raw.length > IMPORT_MAX_SUPPORT_FILES) {
    return fail(
      `A skill can hold at most ${IMPORT_MAX_SUPPORT_FILES} support files (got ${raw.length}).`,
    )
  }

  const files: SupportFile[] = []
  const seen = new Set<string>()
  let totalBytes = 0

  for (const [index, entry] of raw.entries()) {
    const result = validateSupportFile(entry)
    // Locate the bad entry for the user: a batch of 20 makes an unanchored
    // "kind must be one of ..." useless.
    if (!result.ok) return fail(`${locate(entry, index)}: ${result.error}`)

    const key = `${result.value.kind}:${result.value.name}`
    if (seen.has(key)) return fail(`Duplicate support file: ${key}`)
    seen.add(key)

    totalBytes += Buffer.byteLength(result.value.content, 'utf8')
    if (totalBytes > IMPORT_MAX_SUPPORT_TOTAL_BYTES) {
      return fail(
        `The support files exceed ${IMPORT_MAX_SUPPORT_TOTAL_BYTES} bytes in total; trim them first.`,
      )
    }
    files.push(result.value)
  }

  return { ok: true, value: files }
}

/** The loader pointer that expands this file into the body at `useSkill` time. */
export function supportFilePointer(file: Pick<SupportFile, 'kind' | 'name'>): string {
  return `{{${file.kind}:${file.name}}}`
}
