/**
 * Unit tests for the custom-connector preflight-headers form logic.
 * Component tag: [COMP:app-web/connector-preflight-headers].
 *
 * Spec: docs/architecture/engine/tool-hooks.md. Mirrors the server-side RFC 7230
 * / no-CRLF guards so a bad header is caught inline, not silently dropped at
 * inject time.
 */

import { describe, it, expect } from "vitest";
import { buildPreflightHeadersPayload, readPreflightHeaders } from "../connector-preflight-headers";

describe("[COMP:app-web/connector-preflight-headers] buildPreflightHeadersPayload", () => {
  it("accepts valid rows and trims the name", () => {
    expect(buildPreflightHeadersPayload([{ name: " X-Tenant ", value: "acme" }])).toEqual({
      ok: true,
      payload: [{ name: "X-Tenant", value: "acme" }],
    });
  });

  it("drops fully-blank rows but keeps real ones", () => {
    expect(
      buildPreflightHeadersPayload([
        { name: "", value: "" },
        { name: " ", value: "  " },
        { name: "X-A", value: "b" },
      ]),
    ).toEqual({ ok: true, payload: [{ name: "X-A", value: "b" }] });
  });

  it("rejects an invalid header name with its row index", () => {
    expect(
      buildPreflightHeadersPayload([
        { name: "X-Ok", value: "1" },
        { name: "Bad Name", value: "v" },
      ]),
    ).toEqual({ ok: false, error: "invalidName", index: 1 });
  });

  it("rejects a named row with an empty or multiline value", () => {
    expect(buildPreflightHeadersPayload([{ name: "X-K", value: "" }])).toEqual({
      ok: false,
      error: "emptyValue",
      index: 0,
    });
    expect(buildPreflightHeadersPayload([{ name: "X-K", value: "a\r\nb" }])).toEqual({
      ok: false,
      error: "emptyValue",
      index: 0,
    });
  });

  it("rejects a duplicate name case-insensitively", () => {
    expect(
      buildPreflightHeadersPayload([
        { name: "X-Tenant", value: "a" },
        { name: "x-tenant", value: "b" },
      ]),
    ).toEqual({ ok: false, error: "duplicateName", index: 1 });
  });

  it("preserves significant whitespace in the value", () => {
    expect(buildPreflightHeadersPayload([{ name: "X-K", value: " spaced " }])).toEqual({
      ok: true,
      payload: [{ name: "X-K", value: " spaced " }],
    });
  });

  it("returns an empty payload for no rows (clears the stored headers)", () => {
    expect(buildPreflightHeadersPayload([])).toEqual({ ok: true, payload: [] });
  });
});

describe("[COMP:app-web/connector-preflight-headers] readPreflightHeaders", () => {
  it("returns [] for missing / non-array config", () => {
    expect(readPreflightHeaders(undefined)).toEqual([]);
    expect(readPreflightHeaders(null)).toEqual([]);
    expect(readPreflightHeaders({})).toEqual([]);
    expect(readPreflightHeaders({ preflightHeaders: "nope" as unknown })).toEqual([]);
  });

  it("reads valid rows and skips malformed ones", () => {
    expect(
      readPreflightHeaders({
        preflightHeaders: [
          { name: "X-A", value: "1" },
          { name: "X-B" },
          { value: "orphan" },
          null,
          { name: "X-C", value: "3" },
        ],
      }),
    ).toEqual([
      { name: "X-A", value: "1" },
      { name: "X-C", value: "3" },
    ]);
  });
});
