/**
 * Last-edited-time metadata keeps its own kind and clock-edit icon while
 * sharing created-time's date rendering, read-only Editor and ordering.
 * Both kinds accept the same ISO/DateWidget values and display formats.
 *
 * [COMP:views/property-last-edited-time]
 */

import type { JSX } from 'react'
import type { PropertyModule } from './types.js'
import { CreatedTimeProperty } from './created-time.js'

function Icon(props: { className?: string }): JSX.Element {
  // Lucide ClockEdit-style — clock face with a small pencil notch to
  // distinguish "last edited" from the plain "created" clock.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <path d="M13.5 8a5.5 5.5 0 1 1-3-4.9" />
      <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 3.5l1.5 1.5-3 3-1.5-1.5 3-3z" strokeLinejoin="round" />
    </svg>
  )
}

export const LastEditedTimeProperty: PropertyModule = {
  kind: 'last_edited_time',
  Cell: CreatedTimeProperty.Cell,
  Editor: CreatedTimeProperty.Editor,
  Icon,
  sortFn: CreatedTimeProperty.sortFn,
}
