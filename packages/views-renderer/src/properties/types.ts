/**
 * Property-module contract — one self-contained bundle per `PropertyKind`.
 *
 * Each property module owns:
 *   * `Cell`  — table-cell renderer; handles primitives, null, and the
 *               typed widget that matches this kind
 *   * `Editor`— Phase-2 inline edit affordance
 *   * `Icon`  — small SVG glyph for the column header
 *   * `sortFn`— comparator for header-click sorting in `Table.tsx`
 *
 * The renderer dispatches through `PROPERTIES[column.kind]` (see
 * `properties/index.ts`). Columns without `kind` fall through to legacy
 * `renderRowValue` — Phase-1 backward compatibility.
 *
 * [COMP:views/properties]
 */

import type { JSX } from 'react'
import type { A2UIRowValue, OnActionHandler, PersonWidget, PropertyKind, RelationWidget } from '../types.js'

export type PropertyCellProps = {
  value: A2UIRowValue
  onAction?: OnActionHandler
}

/**
 * One option in a `status` group. Mirrors `SelectOption` in
 * `packages/core/src/entities/doc-types.ts` — duplicated here so the
 * renderer package doesn't depend on the brain-layer types.
 */
export type StatusOptionHint = {
  id: string
  name: string
  color?: string
}

/**
 * One group on a `status` column. Mirrors the wire-level `StatusGroup`
 * in doc-types — three fixed group ids (`pending` / `in_progress` /
 * `done`), each carrying user-defined options.
 */
export type StatusGroupHint = {
  id: 'pending' | 'in_progress' | 'done'
  label: string
  options: readonly StatusOptionHint[]
}

/**
 * Optional hints supplied by the host for editor surfaces that need
 * external choice lists (select / person / relation / status). All are
 * optional — absent hints fall back to free-text or a no-op editor.
 *
 *   * `options`         — string enum for `select` cells.
 *   * `members`         — pre-fetched workspace members for `person` cells
 *                         (Phase-2 fallback: typeahead via server search
 *                         is a follow-up; for v1 we pass the directory in).
 *   * `relationOptions` — pre-fetched candidate relations for `relation`
 *                         cells (matched by `entityType`).
 *   * `numberFormat`    — display-format pin for `number` cells; the
 *                         editor still submits a raw number.
 *   * `dateFormat`      — `'absolute'` (date input) vs `'datetime'`
 *                         (datetime-local input).
 *   * `statusGroups`    — grouped-enum schema for `status` cells. Three
 *                         groups (`pending` / `in_progress` / `done`),
 *                         each with user-defined options. The editor
 *                         renders each group as a labelled section.
 */
export type PropertyEditorHints = {
  options?: readonly string[]
  members?: readonly PersonWidget[]
  relationOptions?: readonly RelationWidget[]
  numberFormat?: 'plain' | 'currency' | 'percent' | 'integer'
  currency?: string
  dateFormat?: 'absolute' | 'datetime'
  statusGroups?: readonly StatusGroupHint[]
}

export type PropertyEditorProps = {
  value: A2UIRowValue
  onCommit: (next: A2UIRowValue) => void
  onCancel: () => void
  /**
   * Per-cell hints — populated by the host (table cell wiring). Phase-2
   * Editors degrade gracefully when hints are absent.
   */
  hints?: PropertyEditorHints
}

export type PropertyIconProps = {
  className?: string
}

export type PropertyModule = {
  kind: PropertyKind
  Cell: (props: PropertyCellProps) => JSX.Element
  /**
   * Phase-2 inline editor. Returns a JSX element for editable cells; the
   * host wraps the result in a popover or inline container. Editors that
   * cannot operate without host hints (`null` when no `options`/`members`
   * supplied) may still return a fallback input — see each module.
   */
  Editor: (props: PropertyEditorProps) => JSX.Element | null
  Icon: (props: PropertyIconProps) => JSX.Element
  sortFn: (a: A2UIRowValue, b: A2UIRowValue) => number
  /**
   * Structural validator — returns true when the value is in the shape
   * this module expects (including the `null` / empty cases). Optional;
   * absent on modules that accept any A2UIRowValue. Used by the host
   * before committing a cell-update to reject malformed payloads early.
   */
  validate?: (value: A2UIRowValue) => boolean
}
