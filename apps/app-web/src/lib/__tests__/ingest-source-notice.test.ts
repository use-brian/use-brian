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

  it("flags Personal-workspace routing only on a non-personal active workspace", () => {
    expect(ingestSourceNotice("user", false).routesToPersonal).toBe(true);
  });

  it("hides the routing notice on the Personal workspace itself (no mismatch)", () => {
    expect(ingestSourceNotice("user", true).routesToPersonal).toBe(false);
  });

  it("fail-safe: hides the routing notice while the active workspace is unknown", () => {
    expect(ingestSourceNotice("user", undefined).routesToPersonal).toBe(false);
  });
});
