import { describe, expect, it } from "vitest";
import { decodeLiveDestination } from "../use-live-recording-page";

describe("[COMP:app-web/live-recording-page] destination encoding", () => {
  it("distinguishes a root page, a nested page, and an existing page", () => {
    expect(decodeLiveDestination("new:root")).toEqual({
      destination: "new",
      parentPageId: null,
    });
    expect(decodeLiveDestination("new:parent-1")).toEqual({
      destination: "new",
      parentPageId: "parent-1",
    });
    expect(decodeLiveDestination("existing:page-1")).toEqual({
      destination: "existing",
      pageId: "page-1",
    });
  });
});

