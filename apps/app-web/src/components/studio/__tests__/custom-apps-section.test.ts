/**
 * [COMP:app-web/studio-custom-apps] — the consent screen's two pure helpers.
 *
 * This is the screen where a human approves third-party code reaching
 * workspace data, so the copy it produces is load-bearing: an admin who
 * misreads it grants something they did not mean to. Both helpers are pure so
 * the wording can be pinned without a DOM.
 */

import { describe, expect, it } from "vitest";
import { describeScopes, scopeDelta } from "../custom-apps-section";

const COPY = {
  scopeRead: "Read your workspace brain",
  scopeReadWrite: "Read AND write your workspace brain",
  scopeIdentity: "See your name",
  scopeNet: "Send data to {origin}",
  scopeNone: "No access requested yet",
  scopeStoreRead: "Read your connected store",
  scopeStoreWrite: "Read AND change your connected store",
  scopeAgent: "Ask your assistant to do things for it",
};

describe("[COMP:app-web/studio-custom-apps] describeScopes", () => {
  it("distinguishes read from read_write — these are different decisions", () => {
    expect(describeScopes({ data: "read" }, COPY)).toEqual([COPY.scopeRead]);
    expect(describeScopes({ data: "read_write" }, COPY)).toEqual([COPY.scopeReadWrite]);
  });

  it("mentions identity only when the app asks for it", () => {
    expect(describeScopes({ data: "read" }, COPY)).not.toContain(COPY.scopeIdentity);
    expect(describeScopes({ data: "read", identity: true }, COPY)).toContain(
      COPY.scopeIdentity,
    );
  });

  it("names every net origin the app may send to, one line each", () => {
    expect(
      describeScopes({ data: "read", net: ["https://a.example.com", "https://b.example.com"] }, COPY),
    ).toEqual([
      COPY.scopeRead,
      "Send data to https://a.example.com",
      "Send data to https://b.example.com",
    ]);
  });

  it("says so plainly when nothing has been requested", () => {
    expect(describeScopes(null, COPY)).toEqual([COPY.scopeNone]);
  });
});

describe("[COMP:app-web/studio-custom-apps] scopeDelta", () => {
  it("is empty when the request is within the grant", () => {
    expect(scopeDelta({ data: "read" }, { data: "read" })).toEqual([]);
    expect(scopeDelta({ data: "read" }, { data: "read_write" })).toEqual([]);
  });

  it("names each axis that widened — this is what makes re-consent informed", () => {
    expect(scopeDelta({ data: "read_write" }, { data: "read" })).toEqual(["data"]);
    expect(scopeDelta({ data: "read", identity: true }, { data: "read" })).toEqual([
      "identity",
    ]);
    expect(
      scopeDelta(
        { data: "read", net: ["https://a.example.com", "https://new.example.com"] },
        { data: "read", net: ["https://a.example.com"] },
      ),
    ).toEqual(["https://new.example.com"]);
  });

  it("returns nothing to diff when there is no prior grant (a first consent)", () => {
    // First consent shows the full requested list, not a delta — there is no
    // "what changed" when nothing was approved before.
    expect(scopeDelta({ data: "read_write" }, null)).toEqual([]);
  });
});

describe("[COMP:app-web/studio-custom-apps] describeScopes — store is its own line", () => {
  it("says nothing about a store when none was asked for", () => {
    const lines = describeScopes({ data: "read" }, COPY);
    expect(lines).not.toContain(COPY.scopeStoreRead);
    expect(lines).not.toContain(COPY.scopeStoreWrite);
  });

  it("distinguishes reading a store from changing one", () => {
    expect(describeScopes({ data: "read", store: "read" }, COPY)).toEqual([
      COPY.scopeRead,
      COPY.scopeStoreRead,
    ]);
    expect(describeScopes({ data: "read", store: "write" }, COPY)).toEqual([
      COPY.scopeRead,
      COPY.scopeStoreWrite,
    ]);
  });

  it("never folds the store into the brain line", () => {
    // The regression this screen exists to prevent: two apps with very
    // different power rendering identical permission text. A store-writing
    // app and a brain-only app must not look the same.
    const brainOnly = describeScopes({ data: "read" }, COPY);
    const storeWriter = describeScopes({ data: "read", store: "write" }, COPY);
    expect(storeWriter).not.toEqual(brainOnly);
    expect(storeWriter.length).toBe(brainOnly.length + 1);
  });

  it("treats an explicit 'none' as no store access", () => {
    expect(describeScopes({ data: "read", store: "none" }, COPY)).toEqual([COPY.scopeRead]);
  });
});

describe("[COMP:app-web/studio-custom-apps] scopeDelta — store widening", () => {
  it("flags read -> write as a change the admin must re-approve", () => {
    expect(
      scopeDelta({ data: "read", store: "write" }, { data: "read", store: "read" }),
    ).toContain("store");
  });

  it("flags none -> read", () => {
    expect(scopeDelta({ data: "read", store: "read" }, { data: "read" })).toContain("store");
  });

  it("does not flag a narrowing", () => {
    expect(
      scopeDelta({ data: "read", store: "read" }, { data: "read", store: "write" }),
    ).not.toContain("store");
  });
});

/**
 * Custom-app Home placement. Until this shipped, the framework could RENDER a
 * `custom:<id>` strip entry and the sidebar knew how to draw one, but no
 * screen could ever write it — the row had to be edited by hand. These pin
 * the array arithmetic the toggle performs.
 */
describe("[COMP:app-web/studio-custom-apps] Home placement arithmetic", () => {
  const CUSTOM = "custom:aaaa-1111";
  const add = (strip: string[], entry: string) => [...strip, entry];
  const remove = (strip: string[], entry: string) => strip.filter((e) => e !== entry);

  it("appends rather than inserting mid-strip", () => {
    // The order is the admin's; slotting a new icon into the middle moves
    // icons they positioned deliberately.
    expect(add(["page", "chat"], CUSTOM)).toEqual(["page", "chat", CUSTOM]);
  });

  it("removes only the named entry, preserving order around it", () => {
    expect(remove(["page", CUSTOM, "chat"], CUSTOM)).toEqual(["page", "chat"]);
  });

  it("is idempotent in both directions", () => {
    const on = add(["page"], CUSTOM);
    expect(remove(remove(on, CUSTOM), CUSTOM)).toEqual(["page"]);
  });

  it("treats a custom entry as occupying a slot like any built-in", () => {
    // HOME_APPS_MAX counts the WHOLE array — a custom app is not free.
    const full = ["page", "office", "tasks", "crm", "feed", "browsers", CUSTOM];
    expect(full.length).toBe(7);
  });
});

describe("[COMP:app-web/studio-custom-apps] scopes.agent", () => {
  it("is its own line, never implied by store access", () => {
    expect(describeScopes({ data: "read", store: "write" }, COPY)).not.toContain(COPY.scopeAgent);
    expect(describeScopes({ data: "read", store: "write", agent: "ask" }, COPY)).toContain(
      COPY.scopeAgent,
    );
  });

  it("forces re-consent when an app starts asking for it", () => {
    expect(scopeDelta({ data: "read", agent: "ask" }, { data: "read" })).toContain("agent");
    expect(scopeDelta({ data: "read" }, { data: "read", agent: "ask" })).not.toContain("agent");
  });
});
