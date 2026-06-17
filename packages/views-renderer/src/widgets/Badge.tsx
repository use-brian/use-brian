import type { JSX } from 'react'

/**
 * A2UI Badge — status chip / tag pill. Tone maps to a Tailwind palette.
 *
 * The renderer is shipped Tailwind-class-only — hosts must include the
 * relevant color classes in their build (`bg-emerald-100`, `bg-amber-100`,
 * `bg-rose-100`, `bg-muted`). For apps/web with Tailwind v4 + `@theme`
 * vars these all resolve via the existing palette.
 */
export function Badge(props: {
  text: string
  tone?: 'default' | 'success' | 'warning' | 'danger'
}): JSX.Element {
  const tone = props.tone ?? 'default'
  const cls = TONE_CLASS[tone]
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {props.text}
    </span>
  )
}

const TONE_CLASS: Record<'default' | 'success' | 'warning' | 'danger', string> = {
  default: 'bg-muted text-foreground/80',
  success: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
}
