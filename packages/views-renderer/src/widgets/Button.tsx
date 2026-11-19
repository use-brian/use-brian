import type { JSX } from 'react'
import type { ActionRef, OnActionHandler } from '../types.js'

/**
 * A2UI Button — fires `onAction(action.id, action.params)` on click.
 * The renderer is action-agnostic; the host decides what each action id
 * means.
 */
export function Button(props: {
  text: string
  action: ActionRef
  onAction?: OnActionHandler
}): JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex items-center justify-center rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground hover:bg-action/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/50"
      onClick={() => {
        props.onAction?.(props.action.id, props.action.params)
      }}
    >
      {props.text}
    </button>
  )
}
