/**
 * Created-by property — auto-stamped row metadata pointing at the
 * workspace member who inserted the row. Server bindings pre-resolve
 * `entity_instances.created_by` → a `PersonWidget` (matching the
 * `person` property's wire shape) so the renderer never holds a
 * directory. Empty cells render an em-dash — rare for this kind but
 * defensible (e.g. system-seeded rows where `created_by IS NULL`).
 *
 * Cell: workspace-member pill — avatar + name. Same render shape as
 * the `person` property; this module is the auto-metadata mirror.
 *
 * Editor: **read-only.** Auto-metadata is never user-editable; the
 * Editor returns the same JSX as the Cell.
 *
 * sortFn: alphabetical by name (server-resolved label is the sort key
 * — there's no member-directory lookup happening at sort time).
 *
 * [COMP:views/property-created-by]
 */

import type { JSX } from 'react'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { PersonProperty } from './person.js'

/**
 * Read-only Editor — returns the same JSX as the Cell. Auto-metadata
 * is stamped by the server on insert; the user never picks a value.
 */
function Editor(props: PropertyEditorProps): JSX.Element {
  return <PersonProperty.Cell value={props.value} />
}

function Icon(props: { className?: string }): JSX.Element {
  // Lucide UserPlus — head + shoulders with a small `+` glyph to
  // distinguish "created by" from the plain `person` property.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M2 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" strokeLinecap="round" />
      <path d="M12.5 4v4M10.5 6h4" strokeLinecap="round" />
    </svg>
  )
}

export const CreatedByProperty: PropertyModule = {
  kind: 'created_by',
  Cell: PersonProperty.Cell,
  Editor,
  Icon,
  sortFn: PersonProperty.sortFn,
}
