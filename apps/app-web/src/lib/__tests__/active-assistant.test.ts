/**
 * [COMP:app-web/empty-page-landing] Draft-assistant default resolution —
 * the pure core behind the landing's picker (`lib/active-assistant.ts`).
 * The storage read/write halves need a browser and are covered by the
 * source-level assertions in `empty-page-landing.test.tsx`.
 */

import { describe, expect, it } from "vitest";
import {
  activeAssistantStorageKey,
  resolveDraftAssistantId,
} from "@/lib/active-assistant";

describe("[COMP:app-web/empty-page-landing] resolveDraftAssistantId", () => {
  const roster = [{ id: "a_primary" }, { id: "a_sales" }, { id: "a_ops" }];

  it("keeps the persisted keyspace shared with the dock switcher", () => {
    // The landing's default and the dock's selection must read the SAME key,
    // or the two surfaces drift apart on "who drafts".
    expect(activeAssistantStorageKey("ws_1")).toBe(
      "doc-active-assistant-id:ws_1",
    );
  });

  it("trusts persisted (or primary) while the roster hasn't loaded", () => {
    expect(
      resolveDraftAssistantId({ persisted: "a_sales", primary: "a_primary", roster: [] }),
    ).toBe("a_sales");
    expect(
      resolveDraftAssistantId({ persisted: null, primary: "a_primary", roster: [] }),
    ).toBe("a_primary");
    expect(
      resolveDraftAssistantId({ persisted: null, primary: null, roster: [] }),
    ).toBeNull();
  });

  it("keeps a persisted pick that is still in the roster", () => {
    expect(
      resolveDraftAssistantId({ persisted: "a_ops", primary: "a_primary", roster }),
    ).toBe("a_ops");
  });

  it("repairs a persisted pick that left the roster back to the primary", () => {
    // Repair-only, mirroring WorkspaceChrome's roster rule: never point a
    // build at a deleted assistant.
    expect(
      resolveDraftAssistantId({ persisted: "a_gone", primary: "a_primary", roster }),
    ).toBe("a_primary");
  });

  it("final fallback trusts the primary, then the first roster entry", () => {
    // No primary at all → the first roster entry (here roster[0], "a_primary").
    expect(
      resolveDraftAssistantId({ persisted: "a_gone", primary: null, roster }),
    ).toBe("a_primary");
    expect(
      resolveDraftAssistantId({
        persisted: null,
        primary: "a_elsewhere",
        roster: [{ id: "a_only" }],
      }),
    ).toBe("a_elsewhere");
  });
});
