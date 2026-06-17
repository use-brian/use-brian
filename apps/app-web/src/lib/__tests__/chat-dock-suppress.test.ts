/**
 * Unit tests for the surface-chat-dock suppression store.
 * Component tag: [COMP:app-web/chat-dock-suppress].
 */

import { describe, it, expect } from "vitest";
import { chatDockSuppression } from "../chat-dock-suppress";

describe("[COMP:app-web/chat-dock-suppress] chatDockSuppression", () => {
  it("suppresses while any holder is live and releases when the LAST one lets go", () => {
    expect(chatDockSuppression.getSnapshot()).toBe(false);

    const releaseA = chatDockSuppression.suppress();
    expect(chatDockSuppression.getSnapshot()).toBe(true);

    const releaseB = chatDockSuppression.suppress();
    releaseA();
    // B still holds — the dock must not flicker back.
    expect(chatDockSuppression.getSnapshot()).toBe(true);

    releaseB();
    expect(chatDockSuppression.getSnapshot()).toBe(false);
  });

  it("double-releasing one hold is a no-op (cannot free another holder's lock)", () => {
    const releaseA = chatDockSuppression.suppress();
    const releaseB = chatDockSuppression.suppress();
    releaseA();
    releaseA(); // second call on the same hold — must NOT decrement again
    expect(chatDockSuppression.getSnapshot()).toBe(true);
    releaseB();
    expect(chatDockSuppression.getSnapshot()).toBe(false);
  });

  it("notifies subscribers only on the off↔on edges", () => {
    const events: boolean[] = [];
    const unsubscribe = chatDockSuppression.subscribe(() => {
      events.push(chatDockSuppression.getSnapshot());
    });

    const r1 = chatDockSuppression.suppress(); // off → on (notify)
    const r2 = chatDockSuppression.suppress(); // still on (no notify)
    r2(); // still on (no notify)
    r1(); // on → off (notify)

    expect(events).toEqual([true, false]);
    unsubscribe();
  });

  it("server snapshot is never suppressed", () => {
    expect(chatDockSuppression.getServerSnapshot()).toBe(false);
  });
});
