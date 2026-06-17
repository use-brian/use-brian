import type { JSX, ReactNode } from 'react'

/**
 * A2UI Container — flex column or row. Children rendered by the caller
 * via the dispatch function in `render.tsx`.
 */
export function Container(props: {
  direction: 'column' | 'row'
  children: ReactNode
}): JSX.Element {
  const cls = props.direction === 'row'
    ? 'flex flex-row gap-2 items-center'
    : 'flex flex-col gap-2'
  return <div className={cls}>{props.children}</div>
}
