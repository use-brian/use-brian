import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

/** Keeps the mirror's last line from collapsing where the textarea keeps one. */
const ZERO_WIDTH_SPACE = '\u200b'

/**
 * A half-open `[start, end)` range over the composer value.
 *
 * `className` is optional and purely additive (docs/plans/room-human-mentions.md
 * T-H9): every range still paints the base `composer-mention-chip` look, and
 * a caller that never sets it gets exactly today's single-style chip. It
 * exists so a host distinguishing several kinds of resolved mention (e.g. an
 * assistant mention that will run a paid turn vs. a plain notification) can
 * paint them differently WITHOUT a second mirror/backdrop mechanism — the
 * host defines the concrete class in its own stylesheet, this package only
 * carries the hook through to the rendered chip.
 */
export type HighlightRange = { start: number; end: number; className?: string }

/**
 * Split `value` into alternating plain / highlighted runs.
 *
 * Ranges are clamped to the value and merged where they overlap, so a stale
 * range from a previous keystroke can never drop or duplicate a character —
 * the concatenated segments always reproduce `value` exactly, which is what
 * keeps the mirror layer aligned with the textarea glyph for glyph. Each
 * highlighted segment carries the class of the range it came from (falling
 * back to the base chip look when unset); a range that gets swallowed by an
 * earlier, later-ending overlap loses its class along with its bounds — the
 * caller decides overlap ordering the same way it already does today.
 */
export function splitHighlightSegments(
  value: string,
  ranges: HighlightRange[],
): Array<{ text: string; highlighted: boolean; className?: string }> {
  const sorted = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, value.length)),
      end: Math.max(0, Math.min(range.end, value.length)),
      className: range.className,
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start)

  const segments: Array<{ text: string; highlighted: boolean; className?: string }> = []
  let cursor = 0
  for (const range of sorted) {
    if (range.start < cursor) {
      // Overlapping ranges merge rather than double-paint.
      if (range.end <= cursor) continue
      segments.push({
        text: value.slice(cursor, range.end),
        highlighted: true,
        ...(range.className ? { className: range.className } : {}),
      })
      cursor = range.end
      continue
    }
    if (range.start > cursor) {
      segments.push({ text: value.slice(cursor, range.start), highlighted: false })
    }
    segments.push({
      text: value.slice(range.start, range.end),
      highlighted: true,
      ...(range.className ? { className: range.className } : {}),
    })
    cursor = range.end
  }
  if (cursor < value.length) {
    segments.push({ text: value.slice(cursor), highlighted: false })
  }
  return segments
}

export type ChatComposerProps = {
  value: string
  onChange: (next: string) => void
  /** Called with the current `value` when the user submits. */
  onSend: () => void
  /**
   * Cmd/Ctrl+Enter — submit as a **steer**: the running turn should take this
   * message at the earliest safe point instead of the next boundary. Hosts
   * wire it only where a turn can be in flight; without it Cmd/Ctrl+Enter
   * falls through to an ordinary send, which is the right no-op.
   *
   * See docs/architecture/engine/mid-turn-input.md.
   */
  onSteer?: () => void
  /**
   * Cmd/Ctrl+Enter — submit as an **ask**: this message addresses the
   * assistant, where a plain Enter would only post it. Hosts wire it where a
   * send is NOT automatically addressed (a workspace room, whose Enter is a
   * durable post everyone sees and nobody answers); without it Cmd/Ctrl+Enter
   * falls through to an ordinary send, which is the right no-op.
   *
   * See docs/architecture/features/chat-app.md → "Ask from the keyboard".
   */
  onAsk?: () => void
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
   * Host keyboard handling that runs before the composer's default Enter-to-send
   * behavior. Calling `preventDefault()` lets an autocomplete consume Enter or
   * Tab without accidentally submitting the draft.
   */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
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
  /**
   * Ranges of `value` to paint as a chip BEHIND the text — the composer's way
   * of showing that a run of characters is a resolved token (an `@assistant`
   * mention) rather than prose the user happens to have typed.
   *
   * Implemented as a mirror layer under a transparent-background textarea, so
   * the field keeps native selection, undo, IME and accessibility. Passing the
   * prop at all (even empty) opts into the wrapper element, so pass it
   * consistently rather than conditionally — flipping it remounts the field.
   *
   * The host owns the three classes this layer needs
   * (`composer-highlight-wrap` / `-backdrop` / `-input`, defined in the app's
   * global stylesheet) the same way it owns `composer-row`.
   */
  highlightRanges?: HighlightRange[]
  /** Layout classes for the wrapper that positions the highlight backdrop over
   *  the textarea. Only used when `highlightRanges` is passed: move the
   *  textarea's own layout classes (grid/flex placement) here. */
  inputWrapClassName?: string
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
  /**
   * Clipboard paste on the textarea. Hosts wire this to intercept pasted image
   * files (a screenshot / copied image → attach) before they land in the text
   * field: the raw event is forwarded so the host can `preventDefault()` on an
   * image paste and let a plain text paste fall through untouched.
   */
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  /**
   * Focus the textarea whenever this token changes. Hosts use this when an
   * already-mounted composer is revealed by an external launcher.
   */
  focusRequest?: string | number
}

/**
 * What an Enter keypress means, given the composer's state. Pure so the
 * modifier matrix is testable without a DOM (chat-ui's vitest is node-only).
 *
 * - `newline` — Shift+Enter, or mid-IME composition. Never submits: an IME
 *   Enter is committing a candidate, not sending a message.
 * - `steer` — Cmd/Ctrl+Enter where the host wired `onSteer`.
 * - `ask` — Cmd/Ctrl+Enter where the host wired `onAsk`.
 * - `send` — everything else that is submittable.
 * - `blocked` — Enter that would submit, but the composer says no.
 *
 * Steer and ask share the Accel+Enter chord because no host offers both: a
 * steer only exists mid-turn outside a room, an ask only inside one. Steer
 * takes precedence so wiring both can never silently drop a mid-turn steer.
 */
export type ComposerEnterIntent = 'send' | 'steer' | 'ask' | 'newline' | 'blocked'

export function resolveEnterIntent(params: {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  isComposing: boolean
  disabled: boolean
  sendDisabled: boolean
  hasText: boolean
  allowEmptySend: boolean
  canSteer: boolean
  canAsk: boolean
}): ComposerEnterIntent {
  if (params.shiftKey || params.isComposing) return 'newline'
  if (params.disabled || params.sendDisabled) return 'blocked'
  if (!params.hasText && !params.allowEmptySend) return 'blocked'
  if (params.metaKey || params.ctrlKey) {
    if (params.canSteer) return 'steer'
    if (params.canAsk) return 'ask'
  }
  return 'send'
}

/**
 * Snap a textarea's height to its content. Reset to 0 first so `scrollHeight`
 * reports the true content height free of the previous measurement. Under
 * `box-sizing: border-box` (Tailwind preflight) `height` includes the borders
 * but `scrollHeight` never does, so a bordered textarea sized to bare
 * `scrollHeight` lands short by its border widths, overflows by that much, and
 * `overflow-y-auto` paints a scrollbar on an empty single-line box. Add the
 * vertical border back (`offsetHeight - clientHeight`, which is border +
 * horizontal-scrollbar height and independent of the current height) so the
 * content area is exactly its content.
 */
export function fitTextareaHeight(el: HTMLTextAreaElement): void {
  el.style.height = '0px'
  const chrome = Math.max(0, el.offsetHeight - el.clientHeight)
  el.style.height = `${el.scrollHeight + chrome}px`
}

/**
 * Headless composer. Owns no business logic — the host wires it to a state
 * value and an `onSend` callback that triggers `useMessageStream.start(...)`.
 */
export function ChatComposer(props: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)

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
    fitTextareaHeight(el)
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
      fitTextareaHeight(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (props.focusRequest === undefined) return
    textareaRef.current?.focus()
  }, [props.focusRequest])

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
      props.onKeyDown?.(event)
      if (event.defaultPrevented) return

      // Enter alone sends; Shift+Enter inserts a newline. Matches every other
      // chat UI; consumers can wrap and override if needed. Cmd/Ctrl+Enter
      // sends as a steer, or as an ask, where the host supports one.
      if (event.key !== 'Enter') return
      const intent = resolveEnterIntent({
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isComposing: event.nativeEvent.isComposing,
        disabled: props.disabled === true,
        sendDisabled: props.sendDisabled === true,
        hasText: props.value.trim().length > 0,
        allowEmptySend: props.allowEmptySend === true,
        canSteer: typeof props.onSteer === 'function',
        canAsk: typeof props.onAsk === 'function',
      })
      if (intent === 'newline') return
      event.preventDefault()
      if (intent === 'steer') props.onSteer?.()
      else if (intent === 'ask') props.onAsk?.()
      else if (intent === 'send') props.onSend()
    },
    [props],
  )

  // The mirror is a separate scroll box: past the textarea's max-height the
  // two must move together or the chips drift off their words.
  const syncBackdropScroll = useCallback(() => {
    const el = textareaRef.current
    const backdrop = backdropRef.current
    if (!el || !backdrop) return
    backdrop.scrollTop = el.scrollTop
    backdrop.scrollLeft = el.scrollLeft
  }, [])

  useLayoutEffect(syncBackdropScroll, [props.value, syncBackdropScroll])

  const handleSendClick = useCallback(() => {
    if (
      props.disabled ||
      props.sendDisabled ||
      (props.value.trim().length === 0 && !props.allowEmptySend)
    )
      return
    props.onSend()
  }, [props])

  const highlightRanges = props.highlightRanges
  const input = (
    <textarea
      ref={textareaRef}
      value={props.value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onPaste={props.onPaste}
      onScroll={highlightRanges ? syncBackdropScroll : undefined}
      placeholder={props.placeholder ?? 'Send a message…'}
      disabled={props.disabled}
      className={
        highlightRanges
          ? [props.textareaClassName, 'composer-highlight-input']
              .filter(Boolean)
              .join(' ')
          : props.textareaClassName
      }
      rows={1}
      data-testid="chat-composer-input"
    />
  )

  return (
    <div className={props.className} data-composer>
      {props.slotAttachments}
      <div className={props.rowClassName ?? 'composer-row'} data-composer-row>
        {props.slotPreInput}
        {highlightRanges ? (
          <div
            className={['composer-highlight-wrap', props.inputWrapClassName]
              .filter(Boolean)
              .join(' ')}
            data-composer-input-wrap
          >
            <div
              ref={backdropRef}
              aria-hidden
              data-testid="chat-composer-highlight"
              className={[props.textareaClassName, 'composer-highlight-backdrop']
                .filter(Boolean)
                .join(' ')}
            >
              {splitHighlightSegments(props.value, highlightRanges).map(
                (segment, index) =>
                  segment.highlighted ? (
                    <span
                      key={index}
                      className={['composer-mention-chip', segment.className]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {segment.text}
                    </span>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  ),
              )}
              {/* A textarea renders a trailing newline as an empty last line;
                  a block box collapses it. Keep the mirror the same height. */}
              {props.value.endsWith('\n') ? ZERO_WIDTH_SPACE : null}
            </div>
            {input}
          </div>
        ) : (
          input
        )}
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
