/**
 * [COMP:app-web/suggestion-dismiss] Escape-to-close state machine for the
 * `@tiptap/suggestion`-backed popups (slash menu + `@person` / `@page`).
 *
 * app-web Vitest is node-only, so the DOM side effects (hiding the popup
 * element, delegating to the popup ref) are exercised by web-QA / e2e. Here we
 * lock the pure state machine that drives them: Escape dismisses, dismissal
 * suppresses updates + falls keys through to the editor, and `reset()`
 * (onStart / onExit) reopens the menu for a fresh trigger.
 */

import { describe, expect, it } from "vitest";
import { createSuggestionDismiss } from "../suggestion-dismiss";

describe("[COMP:app-web/suggestion-dismiss] createSuggestionDismiss", () => {
  it("starts undismissed: updates apply and keys delegate to the popup", () => {
    const dismiss = createSuggestionDismiss();
    expect(dismiss.isDismissed()).toBe(false);
    expect(dismiss.shouldSkipUpdate()).toBe(false);
    expect(dismiss.onKey("ArrowDown")).toBe("delegate");
    expect(dismiss.onKey("Enter")).toBe("delegate");
  });

  it("Escape dismisses — the render lifecycle hides the popup + swallows the key", () => {
    const dismiss = createSuggestionDismiss();
    expect(dismiss.onKey("Escape")).toBe("dismiss");
    expect(dismiss.isDismissed()).toBe(true);
  });

  it("stays closed for the rest of the token: updates skip, keys pass through", () => {
    const dismiss = createSuggestionDismiss();
    dismiss.onKey("Escape");
    // Typing more of the same `/foo` / `@bar` keeps firing onUpdate — skip it.
    expect(dismiss.shouldSkipUpdate()).toBe(true);
    // Subsequent keys fall through to the editor instead of the (hidden) popup.
    expect(dismiss.onKey("a")).toBe("passthrough");
    expect(dismiss.onKey("ArrowDown")).toBe("passthrough");
    // A second Escape is idempotent.
    expect(dismiss.onKey("Escape")).toBe("dismiss");
  });

  it("reset() reopens the menu — onStart (fresh trigger) / onExit (token gone)", () => {
    const dismiss = createSuggestionDismiss();
    dismiss.onKey("Escape");
    expect(dismiss.isDismissed()).toBe(true);

    dismiss.reset();
    expect(dismiss.isDismissed()).toBe(false);
    expect(dismiss.shouldSkipUpdate()).toBe(false);
    expect(dismiss.onKey("ArrowDown")).toBe("delegate");
  });
});
