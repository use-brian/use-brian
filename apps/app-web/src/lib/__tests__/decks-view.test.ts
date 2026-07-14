import { describe, expect, it } from "vitest";
import { DECK_REFRESH_EVENT } from "../deck-events";
import { deckIdFromPathname } from "../decks-view";
import { allDomainDispatches, routeWorkspaceChange } from "../workspace-events";

describe("[COMP:app-web/decks] deck preview wiring", () => {
  it("derives the viewed deck id from the preview route only", () => {
    expect(deckIdFromPathname("/w/ws-1/decks/deck-42")).toBe("deck-42");
    expect(deckIdFromPathname("/w/ws-1/decks/deck-42?x=1")).toBe("deck-42");
    expect(deckIdFromPathname("/w/ws-1/workflow/deck-42")).toBeNull();
    expect(deckIdFromPathname("/w/ws-1/decks")).toBeNull();
    expect(deckIdFromPathname(null)).toBeNull();
  });

  it("routes the server's deck primitive to the deck refresh event with the rowId", () => {
    const dispatches = routeWorkspaceChange({
      workspaceId: "ws-1",
      primitive: "deck",
      rowId: "deck-42",
      action: "update",
    });
    expect(dispatches).toEqual([
      {
        event: DECK_REFRESH_EVENT,
        detail: { workspaceId: "ws-1", rowId: "deck-42" },
      },
    ]);
  });

  it("includes decks in the reconnect catch-up fan-out", () => {
    const events = allDomainDispatches("ws-1").map((d) => d.event);
    expect(events).toContain(DECK_REFRESH_EVENT);
  });
});
