/**
 * Unit tests for the custom-connector auth form logic.
 * Component tag: [COMP:app-web/connector-auth-form].
 *
 * Spec: docs/architecture/integrations/mcp.md → "Custom connector auth"
 * (the client half of the keep-secret PATCH contract).
 */

import { describe, it, expect } from "vitest";
import {
  buildCustomConnectorPayload,
  isValidHeaderName,
  type CustomConnectorForm,
} from "../connector-auth-form";

function form(over: Partial<CustomConnectorForm> = {}): CustomConnectorForm {
  return {
    name: "Trading MCP",
    url: "https://mcp.example/sse",
    authType: "none",
    oauthClientId: "",
    oauthClientSecret: "",
    bearerToken: "",
    headerName: "",
    headerValue: "",
    ...over,
  };
}

describe("[COMP:app-web/connector-auth-form] buildCustomConnectorPayload", () => {
  it("none never requires a secret", () => {
    const out = buildCustomConnectorPayload(form(), null);
    expect(out).toEqual({
      ok: true,
      payload: { name: "Trading MCP", url: "https://mcp.example/sse", authType: "none" },
    });
  });

  it("add mode requires the matching secret per type", () => {
    expect(buildCustomConnectorPayload(form({ authType: "bearer" }), null)).toEqual({
      ok: false,
      error: "secretRequired",
    });
    expect(buildCustomConnectorPayload(form({ authType: "oauth", oauthClientId: "id" }), null)).toEqual({
      ok: false,
      error: "secretRequired",
    });
    expect(
      buildCustomConnectorPayload(form({ authType: "custom_header", headerName: "X-Api-Key" }), null),
    ).toEqual({ ok: false, error: "secretRequired" });
  });

  it("add mode includes the secret fields when provided", () => {
    const bearer = buildCustomConnectorPayload(form({ authType: "bearer", bearerToken: " tok1 " }), null);
    expect(bearer).toEqual({
      ok: true,
      payload: expect.objectContaining({ authType: "bearer", bearerToken: "tok1" }),
    });
    const header = buildCustomConnectorPayload(
      form({ authType: "custom_header", headerName: "X-Api-Key", headerValue: "v1" }),
      null,
    );
    expect(header).toEqual({
      ok: true,
      payload: expect.objectContaining({ headerName: "X-Api-Key", headerValue: "v1" }),
    });
  });

  it("edit mode keeps the stored secret when type is unchanged and fields are blank", () => {
    const out = buildCustomConnectorPayload(form({ authType: "bearer" }), { authType: "bearer" });
    expect(out).toEqual({
      ok: true,
      payload: { name: "Trading MCP", url: "https://mcp.example/sse", authType: "bearer" },
    });
  });

  it("edit mode requires the secret when the auth type changes", () => {
    expect(buildCustomConnectorPayload(form({ authType: "bearer" }), { authType: "oauth" })).toEqual({
      ok: false,
      error: "secretRequired",
    });
  });

  it("edit mode keeps the header secret only while the header name is unchanged", () => {
    const current = { authType: "custom_header" as const, authHeaderName: "X-Api-Key" };
    expect(
      buildCustomConnectorPayload(form({ authType: "custom_header", headerName: "X-Api-Key" }), current),
    ).toEqual({
      ok: true,
      payload: expect.objectContaining({ authType: "custom_header", headerName: "X-Api-Key" }),
    });
    // Renaming the header without re-entering its value must fail.
    expect(
      buildCustomConnectorPayload(form({ authType: "custom_header", headerName: "X-Other" }), current),
    ).toEqual({ ok: false, error: "secretRequired" });
  });

  it("rejects an invalid header name before anything else", () => {
    expect(
      buildCustomConnectorPayload(
        form({ authType: "custom_header", headerName: "X Bad Name", headerValue: "v" }),
        null,
      ),
    ).toEqual({ ok: false, error: "invalidHeaderName" });
  });

  it("oauth pair is all-or-nothing", () => {
    const out = buildCustomConnectorPayload(
      form({ authType: "oauth", oauthClientId: "id1", oauthClientSecret: "sec1" }),
      null,
    );
    expect(out).toEqual({
      ok: true,
      payload: expect.objectContaining({ oauthClientId: "id1", oauthClientSecret: "sec1" }),
    });
    // One half entered in edit mode is an error, not a silent keep.
    expect(
      buildCustomConnectorPayload(form({ authType: "oauth", oauthClientId: "id1" }), { authType: "oauth" }),
    ).toEqual({ ok: false, error: "secretRequired" });
  });
});

describe("[COMP:app-web/connector-auth-form] isValidHeaderName", () => {
  it("matches the API's RFC 7230 token rule", () => {
    expect(isValidHeaderName("X-Api-Key")).toBe(true);
    expect(isValidHeaderName("x_custom.key~1")).toBe(true);
    expect(isValidHeaderName("")).toBe(false);
    expect(isValidHeaderName("X Api Key")).toBe(false);
    expect(isValidHeaderName("X-Key:")).toBe(false);
    expect(isValidHeaderName("a".repeat(129))).toBe(false);
  });
});
