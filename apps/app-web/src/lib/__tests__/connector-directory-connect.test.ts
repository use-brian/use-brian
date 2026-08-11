/** [COMP:app-web/connector-directory-connect] Directory connect row resolution. */

import { describe, expect, it } from "vitest";
import { resolveDirectoryConnectRow } from "../connector-directory-connect";

describe("[COMP:app-web/connector-directory-connect] directory connect row", () => {
  it("returns the live row so the form keys on the instance id, not the slug", () => {
    const rows = [
      { id: "gcal", connectorInstanceId: "aaaa" },
      { id: "shopify", connectorInstanceId: "2b765aff", connected: false },
    ];
    expect(resolveDirectoryConnectRow(rows, "shopify")).toBe(rows[1]);
  });

  it("falls back to the slug when the workspace has no instance for it", () => {
    expect(resolveDirectoryConnectRow([{ id: "gcal", connectorInstanceId: "aaaa" }], "shopify"))
      .toEqual({ id: "shopify" });
  });

  it("prefers a row carrying an instance id over a bare placeholder row", () => {
    const rows = [
      { id: "shopify" },
      { id: "shopify", connectorInstanceId: "2b765aff" },
    ];
    expect(resolveDirectoryConnectRow(rows, "shopify")).toBe(rows[1]);
  });

  it("keeps a placeholder-only row rather than inventing a new object", () => {
    const rows = [{ id: "shopify" }];
    expect(resolveDirectoryConnectRow(rows, "shopify")).toBe(rows[0]);
  });
});
