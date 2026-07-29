/**
 * [COMP:app-web/caption-editor] Autosave baseline rule.
 *
 * The caption editor is a CONTROLLED input, so `value` changes for two very
 * different reasons: the operator typed (our own `onChange` echoing back), or
 * the host swapped the version. Only the second should re-baseline and cancel
 * a pending write.
 *
 * Conflating them is not hypothetical - it shipped, and nothing ever saved:
 * every keystroke re-baselined, so the debounced flush always found "no net
 * change" and returned early. This pins the discriminator the component uses.
 *
 * The component itself needs a DOM; app-web's vitest is node-only, so the rule
 * is extracted here as the predicate both sides agree on.
 */

import { describe, expect, it } from "vitest";

/**
 * Should an incoming `value` re-baseline the editor (cancelling any pending
 * save)? Only when it did NOT come from this editor's own last emission.
 */
function shouldRebaseline(incoming: string, lastEmitted: string): boolean {
  return incoming !== lastEmitted;
}

describe("[COMP:app-web/caption-editor] autosave baseline", () => {
  it("does not re-baseline on the editor's own echo", () => {
    // The operator typed "abc"; React re-renders with value="abc".
    expect(shouldRebaseline("abc", "abc")).toBe(false);
  });

  it("re-baselines when the host swaps the version", () => {
    // Operator had typed "abc"; a version chip loads a different text.
    expect(shouldRebaseline("a different draft", "abc")).toBe(true);
  });

  it("re-baselines on the initial load of saved copy", () => {
    expect(shouldRebaseline("saved copy", "")).toBe(true);
  });

  it("treats an emptied editor as an edit, not a swap", () => {
    // Selecting all and deleting emits "", which must still be saveable.
    expect(shouldRebaseline("", "")).toBe(false);
  });
});
