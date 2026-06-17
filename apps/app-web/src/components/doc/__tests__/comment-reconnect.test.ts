/**
 * [COMP:app-web/comment-reconnect] Live-turn reconnect decision.
 *
 * Guards `shouldReconnectToTurn` — the rule a reloaded comment thread uses to
 * decide whether to re-attach to a still-running background turn.
 */

import { describe, it, expect } from "vitest";
import { shouldReconnectToTurn } from "../comment-reconnect";

describe("[COMP:app-web/comment-reconnect] shouldReconnectToTurn", () => {
  it("reconnects when the backing turn is still running", () => {
    expect(
      shouldReconnectToTurn({ sessionStatus: "running", seeded: false, busy: false }),
    ).toBe(true);
  });

  it("does not reconnect when the turn is idle / finished / unknown", () => {
    for (const sessionStatus of ["idle", "timeout", null, undefined]) {
      expect(shouldReconnectToTurn({ sessionStatus, seeded: false, busy: false })).toBe(false);
    }
  });

  it("does not reconnect a fresh seed hand-off (it sends its own turn)", () => {
    expect(
      shouldReconnectToTurn({ sessionStatus: "running", seeded: true, busy: false }),
    ).toBe(false);
  });

  it("does not reconnect while a local send already owns the bubble", () => {
    expect(
      shouldReconnectToTurn({ sessionStatus: "running", seeded: false, busy: true }),
    ).toBe(false);
  });
});
