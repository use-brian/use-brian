import type { JSX } from 'react'

/**
 * A2UI Text — body / muted / caption. Default `body`.
 */
export function Text(props: {
  text: string
  variant?: 'body' | 'muted' | 'caption'
}): JSX.Element {
  const variant = props.variant ?? 'body'
  const cls = variant === 'muted'
    ? 'text-sm text-muted-foreground'
    : variant === 'caption'
      ? 'text-xs text-muted-foreground'
      : 'text-sm'
  return <span className={cls}>{props.text}</span>
}
