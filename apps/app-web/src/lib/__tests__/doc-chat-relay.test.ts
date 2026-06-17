/**
 * Unit tests for the doc-shell → chrome-dock page-collab relay.
 * Component tag: [COMP:app-web/doc-chat-relay].
 */

import { describe, it, expect, afterEach } from "vitest";
import type { AssistantRunState } from "@sidanclaw/doc-model";
import { docChatRelay } from "../doc-chat-relay";

// Minimal stand-in — the relay treats the value as an opaque payload; only
// the identity / null transitions matter to subscribers.
function run(name: string): AssistantRunState {
  return { actor: { id: name, name } } as unknown as AssistantRunState;
}

afterEach(() => {
  // Leave the module store clean for the next test (it's a singleton).
  docChatRelay.setOthersRun(null);
});

describe("[COMP:app-web/doc-chat-relay] docChatRelay", () => {
  it("starts empty and reflects the last published value", () => {
    expect(docChatRelay.getSnapshot()).toBeNull();

    const a = run("alice");
    docChatRelay.setOthersRun(a);
    expect(docChatRelay.getSnapshot()).toBe(a);

    docChatRelay.setOthersRun(null);
    expect(docChatRelay.getSnapshot()).toBeNull();
  });

  it("notifies subscribers only when the value actually changes", () => {
    const seen: (AssistantRunState | null)[] = [];
    const unsubscribe = docChatRelay.subscribe(() => {
      seen.push(docChatRelay.getSnapshot());
    });

    const a = run("alice");
    docChatRelay.setOthersRun(a); // null → a (notify)
    docChatRelay.setOthersRun(a); // a → a, unchanged (no notify)
    docChatRelay.setOthersRun(null); // a → null (notify)

    expect(seen).toEqual([a, null]);
    unsubscribe();
  });

  it("stops notifying after unsubscribe (the DocShell unmount path)", () => {
    let calls = 0;
    const unsubscribe = docChatRelay.subscribe(() => {
      calls += 1;
    });
    docChatRelay.setOthersRun(run("bob"));
    expect(calls).toBe(1);

    unsubscribe();
    docChatRelay.setOthersRun(null);
    expect(calls).toBe(1); // no further callbacks after unsubscribe
  });

  it("server snapshot never warns before the doc shell reports", () => {
    expect(docChatRelay.getServerSnapshot()).toBeNull();
  });
});
