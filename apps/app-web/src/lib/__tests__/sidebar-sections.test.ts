/**
 * [COMP:app-web/teamspace-sections] Section-header drop-id encoding.
 * Spec: docs/architecture/features/teamspaces.md.
 */

import { describe, it, expect } from "vitest";
import {
  PRIVATE_SECTION_KEY,
  parseSectionDropId,
  sectionDropId,
} from "../sidebar-sections";

describe("[COMP:app-web/teamspace-sections] sectionDropId / parseSectionDropId", () => {
  it("round-trips a teamspace id", () => {
    const id = "2e9f1b34-0000-4000-8000-000000000002";
    expect(parseSectionDropId(sectionDropId(id))).toEqual({ teamspaceId: id });
  });

  it("round-trips the Private section as a null teamspace", () => {
    const encoded = sectionDropId(null);
    expect(encoded).toBe(`section::${PRIVATE_SECTION_KEY}`);
    expect(parseSectionDropId(encoded)).toEqual({ teamspaceId: null });
  });

  it("returns null for a row drop id (disjoint from the `<uuid>::onto|after` scheme)", () => {
    // A row droppable id is `<uuid>::onto` / `<uuid>::after` — never prefixed
    // `section::`, so a header parser must reject it (and vice-versa) or a
    // gap-drop between rows would be misrouted to a section-root file.
    expect(parseSectionDropId("abc-123::onto")).toBeNull();
    expect(parseSectionDropId("abc-123::after")).toBeNull();
  });

  it("returns null for an unrelated string", () => {
    expect(parseSectionDropId("")).toBeNull();
    expect(parseSectionDropId("home")).toBeNull();
  });

  it("does not mistake a teamspace named like the private sentinel", () => {
    // The sentinel is only special AFTER the prefix; a real page/teamspace id
    // never equals `__private__`, but guard the boundary anyway.
    expect(parseSectionDropId(sectionDropId("__private__x"))).toEqual({
      teamspaceId: "__private__x",
    });
  });
});
