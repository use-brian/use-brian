import type { JSX } from 'react'

/**
 * Soft-fail for widget types outside the v1 catalog. Renders a small
 * inline marker (visible in dev, near-invisible in prod). The
 * `console.warn` for spec drift is emitted by the dispatch function in
 * `render.tsx` so it fires at element-creation time, not at React mount.
 *
 * Never throws — a v0.9 payload mistakenly served to a v0.8 renderer
 * must not crash the chat surface.
 */
export function Fallback(props: { type: string }): JSX.Element {
  return (
    <div
      data-a2ui-fallback={props.type}
      className="text-xs text-muted-foreground italic"
    >
      [unsupported widget: {props.type}]
    </div>
  )
}
