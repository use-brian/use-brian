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
