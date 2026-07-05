import { describe, it, expect } from "vitest";
import { ingestSourceNotice } from "../ingest-source-notice";

describe("[COMP:app-web/studio-ingest] ingestSourceNotice", () => {
  it("shows no notices for a workspace-scoped source", () => {
    // A workspace source already carries the owning workspace's name badge.
    expect(ingestSourceNotice("workspace", false)).toEqual({
      globalToggle: false,
      routesToPersonal: false,
    });
    expect(ingestSourceNotice("workspace", true)).toEqual({
      globalToggle: false,
      routesToPersonal: false,
    });
    expect(ingestSourceNotice("workspace", undefined)).toEqual({
      globalToggle: false,
      routesToPersonal: false,
    });
  });

  it("always flags the account-global toggle for a personal source", () => {
    expect(ingestSourceNotice("user", false).globalToggle).toBe(true);
    expect(ingestSourceNotice("user", true).globalToggle).toBe(true);
    expect(ingestSourceNotice("user", undefined).globalToggle).toBe(true);
  });

  it("warns about Personal-workspace routing when the active workspace is NOT the caller's owned personal workspace", () => {
    // Defensive branch: a current API never returns a personal row on such a
    // page, but a stale client against an older API must still warn. The
    // input is the API's `ownedPersonal` — false covers both a team workspace
    // and a legacy personal-FLAGGED workspace owned by someone else (the
    // 2026-07 incident shape, where keying off the raw isPersonal label
    // wrongly suppressed this warning).
    expect(ingestSourceNotice("user", false).routesToPersonal).toBe(true);
  });

  it("hides the routing warning on the caller's owned personal workspace (no mismatch)", () => {
    expect(ingestSourceNotice("user", true).routesToPersonal).toBe(false);
  });

  it("fail-safe: hides the routing warning while ownedPersonal is unknown", () => {
    expect(ingestSourceNotice("user", undefined).routesToPersonal).toBe(false);
  });
});
