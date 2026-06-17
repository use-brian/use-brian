import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

export type ChatComposerProps = {
  value: string
  onChange: (next: string) => void
  /** Called with the current `value` when the user submits. */
  onSend: () => void
  /**
   * Hard-disable the whole composer — textarea included (e.g. offline, or the
   * turn is suspended on a clarifying question). NOT for streaming: while a
   * reply streams the user should keep typing their next message, so pass
   * `sendDisabled` instead.
   */
  disabled?: boolean
  /**
   * Block submission (Enter + the Send button) while keeping the textarea
   * typeable. Hosts set this while a stream is in flight so the user can
   * draft their next message during the assistant's turn.
   */
  sendDisabled?: boolean
  /** Placeholder text. */
  placeholder?: string
  /** Optional cap on character count, enforced by `onChange`. Falsy = unlimited. */
  maxLength?: number
  /**
   * Slot rendered to the left of the textarea — hosts use this for attachment
   * pickers (e.g. drive picker trigger). Distribution-web ignores this.
   */
  slotPreInput?: ReactNode
  /**
   * Slot rendered to the right of the send button — hosts use this for voice
   * recording or extra actions.
   */
  slotPostInput?: ReactNode
  /**
   * Slot rendered above the textarea — hosts use this for attachment previews
   * or reply-to banners.
   */
  slotAttachments?: ReactNode
  /** Optional CSS classes for layout customization. */
  className?: string
  textareaClassName?: string
  /** Class for the inner row containing the textarea, send button, and slots. */
  rowClassName?: string
  /** Class for the built-in Send button. */
  sendButtonClassName?: string
  /** Override the Send button label. */
  sendLabel?: ReactNode
  /**
   * Allow submitting with empty text (Enter + send button stay enabled).
   * Hosts set this when something other than the text — e.g. a staged file
   * attachment — makes the turn sendable. The host's `onSend` is responsible
   * for there actually being content to send.
   */
  allowEmptySend?: boolean
}

/**
 * Headless composer. Owns no business logic — the host wires it to a state
 * value and an `onSend` callback that triggers `useMessageStream.start(...)`.
 */
export function ChatComposer(props: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow the textarea to fit its content (the Notion composer feel): the
  // box expands line-by-line as the user types — Shift+Enter for a newline —
  // instead of scrolling earlier lines out of a fixed one-line box. On every
  // value change reset height to 0 so `scrollHeight` reports the true content
  // height free of the previous measurement, then snap to it. Growth is capped
  // by the textarea's own `max-height` (the host sets one via
  // `textareaClassName`, e.g. `max-h-[160px]`); past the cap the overflow
  // scrolls. `useLayoutEffect` runs before paint so there's no flicker.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [props.value])

  // Re-fit on WIDTH changes — a re-wrap (panel opens, sidebar toggles, viewport
  // resizes) changes the line count without a value change. React only to width
  // deltas so we don't loop on our own height writes.
  useEffect(() => {
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastWidth = el.clientWidth
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (Math.abs(w - lastWidth) < 0.5) return
      lastWidth = w
      el.style.height = '0px'
      el.style.height = `${el.scrollHeight}px`
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value
      if (props.maxLength && next.length > props.maxLength) {
        props.onChange(next.slice(0, props.maxLength))
        return
      }
      props.onChange(next)
    },
    [props],
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter alone sends; Shift+Enter inserts a newline. Matches every other
      // chat UI; consumers can wrap and override if needed.
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        if (
          !props.disabled &&
          !props.sendDisabled &&
          (props.value.trim().length > 0 || props.allowEmptySend)
        ) {
          props.onSend()
        }
      }
    },
    [props],
  )

  const handleSendClick = useCallback(() => {
    if (
      props.disabled ||
      props.sendDisabled ||
      (props.value.trim().length === 0 && !props.allowEmptySend)
    )
      return
    props.onSend()
  }, [props])

  return (
    <div className={props.className} data-composer>
      {props.slotAttachments}
      <div className={props.rowClassName ?? 'composer-row'} data-composer-row>
        {props.slotPreInput}
        <textarea
          ref={textareaRef}
          value={props.value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={props.placeholder ?? 'Send a message…'}
          disabled={props.disabled}
          className={props.textareaClassName}
          rows={1}
          data-testid="chat-composer-input"
        />
        <button
          type="button"
          onClick={handleSendClick}
          disabled={
            props.disabled ||
            props.sendDisabled ||
            (props.value.trim().length === 0 && !props.allowEmptySend)
          }
          className={props.sendButtonClassName}
          data-testid="chat-composer-send"
        >
          {props.sendLabel ?? 'Send'}
        </button>
        {props.slotPostInput}
      </div>
    </div>
  )
}
