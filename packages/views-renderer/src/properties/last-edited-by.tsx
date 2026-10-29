/**
 * Last-edited-by metadata keeps its own kind and user-edit icon while
 * sharing created-by's resolved member display, read-only Editor and sorting.
 * Server bindings own member resolution; neither metadata Editor can mutate it.
 *
 * [COMP:views/property-last-edited-by]
 */

import type { JSX } from 'react'
import type { PropertyModule } from './types.js'
import { CreatedByProperty } from './created-by.js'

function Icon(props: { className?: string }): JSX.Element {
  // Lucide UserPen — head + shoulders with a small pencil glyph to
  // distinguish "last edited by" from "created by" (which carries `+`).
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M2 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" strokeLinecap="round" />
      <path d="M11 3l2 2-3 3-2 .5.5-2 3-3z" strokeLinejoin="round" />
    </svg>
  )
}

export const LastEditedByProperty: PropertyModule = {
  kind: 'last_edited_by',
  Cell: CreatedByProperty.Cell,
  Editor: CreatedByProperty.Editor,
  Icon,
  sortFn: CreatedByProperty.sortFn,
}
