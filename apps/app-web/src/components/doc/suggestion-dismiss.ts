// [COMP:app-web/suggestion-dismiss]
/**
 * Escape-to-close for `@tiptap/suggestion`-backed popups (slash menu + the
 * `@person` / `@page` mention popups).
 *
 * **The bug this fixes.** `@tiptap/suggestion` derives its `active` state purely
 * from the document: as long as the trigger token (`/` or `@`) sits in the doc
 * with the cursor inside its range, the plugin stays active and keeps calling
 * the renderer's `onUpdate`. There is no meta/command to force it inactive, and
 * Escape dispatches no transaction of its own — so returning `true` from the
 * renderer's `onKeyDown` only *swallowed* the keystroke. The popup (and its
 * "Close menu · esc" footer) never actually closed.
 *
 * **The fix.** We dismiss the popup ourselves. On Escape the render lifecycle
 * HIDES the popup element and then SKIPS every further `onUpdate` for the rest
 * of that token — so the menu stays closed while the user keeps typing the same
 * `/foo` / `@bar`, exactly like Notion. The dismissal resets on `onStart` (a
 * fresh trigger) and `onExit` (the plugin deactivates once the cursor leaves the
 * token), so a brand-new `/` reopens the menu normally.
 *
 * The controller is intentionally DOM-free: the side effects (toggling
 * `element.style.display`, delegating to the popup's `onKeyDown` ref) live in
 * each extension's `render()`; this just owns the state machine so it's shared
 * across all three popups and unit-testable under app-web's node-only Vitest.
 */

/**
 * What the render lifecycle must do in response to a suggestion keydown:
 *
 *   - `dismiss`     — Escape was pressed: hide the popup and swallow the key
 *                     (return `true` to the suggestion plugin).
 *   - `passthrough` — the popup is already dismissed: let the key fall through
 *                     to the editor (return `false`) so typing/arrows behave
 *                     normally while the menu is closed.
 *   - `delegate`    — normal case: forward the key to the popup's own
 *                     `onKeyDown` (↑/↓/Enter navigation + selection).
 */
type SuggestionKeyAction = "dismiss" | "passthrough" | "delegate";

export type SuggestionDismissController = {
  /** Call from `onStart` (fresh trigger) and `onExit` (token gone). */
  reset(): void;
  /** True once Escape was pressed for the current token. */
  isDismissed(): boolean;
  /** `onUpdate` guard — skip re-render/reposition while dismissed. */
  shouldSkipUpdate(): boolean;
  /** Map a suggestion keydown to the action the render lifecycle must take. */
  onKey(key: string): SuggestionKeyAction;
};

/** Build a fresh dismiss controller — one per Suggestion `render()` closure. */
export function createSuggestionDismiss(): SuggestionDismissController {
  let dismissed = false;
  return {
    reset() {
      dismissed = false;
    },
    isDismissed() {
      return dismissed;
    },
    shouldSkipUpdate() {
      return dismissed;
    },
    onKey(key) {
      if (key === "Escape") {
        dismissed = true;
        return "dismiss";
      }
      return dismissed ? "passthrough" : "delegate";
    },
  };
}
