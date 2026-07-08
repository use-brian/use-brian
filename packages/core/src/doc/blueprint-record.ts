/**
 * Blueprint RECORD helpers — the pure half of the blueprint-as-output-contract
 * primitive (docs/architecture/brain/structural-synthesis.md; spec home
 * docs/architecture/brain/structural-synthesis.md).
 *
 * A blueprint's `ExtractionSpec` is a typed contract; a RECORD is one filled
 * instance: `{ key → value }` under that contract. This file owns:
 *
 *   - `validateFieldValue`     — coerce/validate one value against its field
 *                                (the `writeField` / `saveBlueprintRecord`
 *                                boundary; invalid values are rejected at the
 *                                tool layer so the model retries).
 *   - `recordCompleteness`     — required-coverage → `complete | incomplete`
 *                                + the `missing` key list. A thin source never
 *                                drops a record; it stamps it incomplete.
 *   - `blueprintRecordToBlocks`— project a record onto page blocks (the page
 *                                is a VISUALIZATION of the record, derived on
 *                                demand — never the storage).
 *
 * Kept DB-free and browser-safe (like `custom-template-types.ts`) so the
 * engine, the record tools, and app-web all share one contract implementation.
 * Persistence lives in `packages/api/src/db/blueprint-records-store.ts`.
 *
 * [COMP:doc/blueprint-record]
 */

import type { Block } from '../views/blocks.js'
import { markdownToBlocks, normalizeMarkdownBlocks } from './markdown.js'
import {
  BLUEPRINT_CAPTURE_KINDS,
  type BlueprintCaptureKind,
  type ExtractionField,
} from './custom-template-types.js'

/** A filled record's values, keyed by the contract's field keys. */
export type BlueprintRecordFields = Record<string, unknown>

export type BlueprintRecordStatus = 'complete' | 'incomplete'

/** The resolved shape an `entityRef` value normalizes to. */
export type BlueprintEntityRefValue = {
  name: string
  /** Present when the reference resolved to a live brain entity. */
  entityId?: string
  kind?: BlueprintCaptureKind
}

export type FieldValidation =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function asTrimmedString(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() || null
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'boolean') return String(raw)
  return null
}

/**
 * Validate + canonicalize one value against its contract field. Lenient on
 * representation (numeric strings coerce, enum matching is case-insensitive,
 * an `entityRef` accepts a bare name string), strict on meaning (a date must
 * be a real `YYYY-MM-DD`, an enum value must be one of the options).
 */
export function validateFieldValue(field: ExtractionField, raw: unknown): FieldValidation {
  if (raw === null || raw === undefined) {
    return { ok: false, error: `"${field.key}" needs a value — omit the call instead of sending null` }
  }
  switch (field.type) {
    case 'markdown':
    case 'string': {
      const s = asTrimmedString(raw)
      if (!s) return { ok: false, error: `"${field.key}" expects non-empty text` }
      return { ok: true, value: s }
    }
    case 'number': {
      const n =
        typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
      if (!Number.isFinite(n)) return { ok: false, error: `"${field.key}" expects a number` }
      return { ok: true, value: n }
    }
    case 'date': {
      const s = typeof raw === 'string' ? raw.trim() : ''
      if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) {
        return { ok: false, error: `"${field.key}" expects an ISO date (YYYY-MM-DD)` }
      }
      return { ok: true, value: s }
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw }
      if (raw === 'true') return { ok: true, value: true }
      if (raw === 'false') return { ok: true, value: false }
      return { ok: false, error: `"${field.key}" expects true or false` }
    }
    case 'enum': {
      const s = typeof raw === 'string' ? raw.trim() : ''
      const options = field.options ?? []
      const match = options.find((o) => o.toLowerCase() === s.toLowerCase())
      if (!match) {
        return { ok: false, error: `"${field.key}" must be one of: ${options.join(', ')}` }
      }
      return { ok: true, value: match }
    }
    case 'entityRef': {
      let name: string | null = null
      let entityId: string | undefined
      let kind: string | undefined
      if (typeof raw === 'string') {
        name = raw.trim() || null
      } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const o = raw as Record<string, unknown>
        name = typeof o.name === 'string' ? o.name.trim() || null : null
        entityId = typeof o.entityId === 'string' && o.entityId.trim() ? o.entityId.trim() : undefined
        kind = typeof o.kind === 'string' ? o.kind : undefined
      }
      if (!name) {
        return {
          ok: false,
          error: `"${field.key}" expects an entity name (or { name, entityId? })`,
        }
      }
      if (kind && !(BLUEPRINT_CAPTURE_KINDS as readonly string[]).includes(kind)) {
        return { ok: false, error: `"${field.key}" kind must be one of: ${BLUEPRINT_CAPTURE_KINDS.join(', ')}` }
      }
      if (kind && field.entityKind && kind !== field.entityKind) {
        return { ok: false, error: `"${field.key}" expects a ${field.entityKind}` }
      }
      const value: BlueprintEntityRefValue = {
        name,
        ...(entityId ? { entityId } : {}),
        kind: (kind as BlueprintCaptureKind | undefined) ?? field.entityKind,
      }
      return { ok: true, value }
    }
  }
}

/** Required-coverage check: which required keys are absent → record status. */
export function recordCompleteness(
  specFields: ExtractionField[],
  values: BlueprintRecordFields,
): { status: BlueprintRecordStatus; missing: string[] } {
  const missing = specFields
    .filter((f) => f.required && values[f.key] === undefined)
    .map((f) => f.key)
  return { status: missing.length === 0 ? 'complete' : 'incomplete', missing }
}

/** One-line human rendering for non-markdown values (page projection + UI). */
export function formatFieldValueText(field: ExtractionField, value: unknown): string {
  if (field.type === 'boolean') return value === true ? 'Yes' : 'No'
  if (field.type === 'entityRef') {
    const ref = value as BlueprintEntityRefValue
    return ref?.name ?? ''
  }
  return String(value ?? '')
}

/**
 * Project a record onto page blocks: one heading per filled field, content
 * under it (markdown fields expand through the same md→blocks path every
 * other authored page uses; typed fields render as a value line). Unfilled
 * fields are skipped — the record, not the page, is the source of truth for
 * coverage (`missing` / `status`).
 */
export function blueprintRecordToBlocks(
  specFields: ExtractionField[],
  values: BlueprintRecordFields,
  genId: () => string,
): Block[] {
  const blocks: Block[] = []
  for (const field of specFields) {
    const value = values[field.key]
    if (value === undefined) continue
    blocks.push({ kind: 'heading', id: genId(), level: 2, text: field.heading })
    if (field.type === 'markdown') {
      const body = normalizeMarkdownBlocks(markdownToBlocks(String(value), { genId }), genId)
      if (body.length > 0) {
        blocks.push(...body)
      } else {
        blocks.push({ kind: 'text', id: genId(), text: String(value) })
      }
    } else {
      blocks.push({ kind: 'text', id: genId(), text: formatFieldValueText(field, value) })
    }
  }
  return blocks
}
