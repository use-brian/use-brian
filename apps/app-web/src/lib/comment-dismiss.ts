/**
 * Shared "is this click inside a composer-portaled popup?" test for every doc
 * comment surface's outside-click / Escape dismiss handler — the page-comments
 * band (`page-comments.tsx`), the anchored-thread overlay popover
 * (`comment-thread-popover.tsx`), the margin rail (`comment-rail.tsx`), and the
 * new-comment draft popover (`new-comment-popover.tsx`).
 *
 * The comment composer portals two popups to `<body>`, so both render OUTSIDE
 * the thread card / panel in the DOM:
 *   - the `@`-mention list (`[data-mention-popup]`), and
 *   - the base-ui model-tier Select (`standard | pro | max`), whose popup is
 *     `[data-slot="select-content"]` and whose rows are `role="option"` inside
 *     a `role="listbox"`.
 * A click on either reads as an "outside" click to a naive handler, which then
 * dismisses the thread out from under the pick — tearing the popup down before
 * the choice commits. So each handler routes its portaled-popup exclusion
 * through here.
 *
 * Why this is one function and not four inline `closest(...)` calls: it WAS four
 * inline copies, and they drifted — the band + new-comment popover were taught
 * to exclude the model Select but the overlay popover + rail were missed, so
 * switching tiers from a block-anchored comment collapsed the card and silently
 * dropped the pick. A single seam can't drift. (`[role=listbox]`/`[option]` is a
 * belt-and-suspenders fallback for the case where the real mousedown target is a
 * child node the `data-slot` lookup can't reach.)
 *
 * [COMP:app-web/comment-dismiss]
 */

/** Selectors for the popups the comment composer portals to `<body>`. */
const COMPOSER_POPUP_SELECTOR =
  "[data-mention-popup],[data-slot='select-content'],[role='listbox'],[role='option']";

/**
 * True when `target` (a `mousedown`/click event target) lies inside one of the
 * composer's portaled popups — the `@`-mention list or the model-tier Select —
 * so an outside-click dismiss handler must NOT fire for it.
 */
export function isInsideComposerPopup(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.(COMPOSER_POPUP_SELECTOR);
}
