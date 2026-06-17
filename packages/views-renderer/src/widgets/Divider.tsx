import type { JSX } from 'react'

/**
 * A2UI Divider — horizontal rule. Used by the Notion-redesign
 * `DividerBlock` (renders as a thin neutral hr line).
 */
export function Divider(): JSX.Element {
  return <hr className="my-2 border-t border-border" />
}
