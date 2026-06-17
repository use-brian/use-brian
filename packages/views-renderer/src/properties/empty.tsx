/**
 * Shared em-dash placeholder for empty cells across every property kind.
 * Keeps the visual empty state consistent and centralises the className.
 */

import type { JSX } from 'react'

export function Empty(): JSX.Element {
  return <span className="text-muted-foreground/60">—</span>
}
