import { describe, it, expect } from "vitest";
import { pickPrimaryAssistant } from "../primary-assistant";

// The pick that decides which assistant the one hoisted chat dock
// (`WorkspaceChrome` → `<FloatingChat origin="doc">`) talks to by default.
// The dock needs a concrete id for session resume, so it renders nothing
// until this resolves.
describe("[COMP:app-web/primary-assistant] pickPrimaryAssistant", () => {
  it("picks the workspace primary when present, regardless of order", () => {
    const list = [
      { id: "a", kind: "standard" },
      { id: "b", kind: "app" },
      { id: "c", kind: "primary" },
    ];
    expect(pickPrimaryAssistant(list)?.id).toBe("c");
  });

  it("falls back to the first assistant when no primary exists", () => {
    const list = [
      { id: "a", kind: "standard" },
      { id: "b", kind: "app" },
    ];
    expect(pickPrimaryAssistant(list)?.id).toBe("a");
  });

  it("returns null for an empty list (wrapper renders no dock)", () => {
    expect(pickPrimaryAssistant([])).toBeNull();
  });

  it("prefers the first primary when several exist", () => {
    const list = [
      { id: "p1", kind: "primary" },
      { id: "p2", kind: "primary" },
    ];
    expect(pickPrimaryAssistant(list)?.id).toBe("p1");
  });
});
