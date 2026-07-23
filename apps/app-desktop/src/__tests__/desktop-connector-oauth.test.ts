import { describe, it, expect, vi } from "vitest";

import {
  parseConnectRequest,
  generateConnectorNonce,
  buildDesktopConnectorState,
  buildConnectorAuthorizeUrl,
  buildConnectorConnectedPageUrl,
  buildConnectorsReturnPath,
  exchangeAndStore,
  DESKTOP_CONNECTOR_STATE_PREFIX,
} from "../desktop-connector-oauth.js";

const IID = "11111111-1111-1111-1111-111111111111";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=y";
const REDIRECT = "https://app.usebrian.ai/api/auth/callback/google-connector";

const validReq = () => ({
  connector: "gdrive",
  authorizeUrl: GOOGLE_AUTH,
  redirectUri: REDIRECT,
  workspaceId: "ws-1",
});

describe("[COMP:app-desktop/connector-oauth] parseConnectRequest", () => {
  it("accepts a well-formed Google connect request", () => {
    expect(parseConnectRequest(validReq())).toEqual({
      connector: "gdrive",
      authorizeUrl: GOOGLE_AUTH,
      redirectUri: REDIRECT,
      workspaceId: "ws-1",
      createNew: false,
      instanceId: undefined,
    });
  });

  it("accepts a Notion authorize host", () => {
    const req = { ...validReq(), connector: "notion", authorizeUrl: "https://api.notion.com/v1/oauth/authorize?client_id=x" };
    expect(parseConnectRequest(req)?.connector).toBe("notion");
  });

  it("carries createNew and a valid instanceId", () => {
    expect(parseConnectRequest({ ...validReq(), createNew: true, instanceId: IID })).toMatchObject({
      createNew: true,
      instanceId: IID,
    });
  });

  it("rejects a non-provider authorize host (never openExternal an arbitrary URL)", () => {
    expect(parseConnectRequest({ ...validReq(), authorizeUrl: "https://evil.example/o/oauth2/v2/auth" })).toBeNull();
  });

  it("rejects a non-https redirect_uri and a missing field", () => {
    expect(parseConnectRequest({ ...validReq(), redirectUri: "http://app.usebrian.ai/cb" })).toBeNull();
    expect(parseConnectRequest({ ...validReq(), workspaceId: "" })).toBeNull();
    expect(parseConnectRequest(null)).toBeNull();
    expect(parseConnectRequest({ connector: "../etc" })).toBeNull();
  });

  it("drops a malformed instanceId rather than trusting it", () => {
    expect(parseConnectRequest({ ...validReq(), instanceId: "not-a-uuid" })?.instanceId).toBeUndefined();
  });
});

describe("[COMP:app-desktop/connector-oauth] state + url builders", () => {
  it("generateConnectorNonce is base64url and long enough for NONCE_RE", () => {
    expect(generateConnectorNonce()).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("buildDesktopConnectorState round-trips to the app-web JSON shape", () => {
    const state = buildDesktopConnectorState({
      connector: "gdrive",
      workspaceId: "ws-1",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      loopback: "http://127.0.0.1:5000/cb",
      createNew: true,
      instanceId: IID,
    });
    expect(state.startsWith(DESKTOP_CONNECTOR_STATE_PREFIX)).toBe(true);
    const obj = JSON.parse(Buffer.from(state.slice(DESKTOP_CONNECTOR_STATE_PREFIX.length), "base64url").toString());
    expect(obj).toEqual({ c: "gdrive", w: "ws-1", n: "AAAAAAAAAAAAAAAAAAAAAA", l: "http://127.0.0.1:5000/cb", a: 1, i: IID });
  });

  it("buildConnectorAuthorizeUrl appends state with the right separator", () => {
    expect(buildConnectorAuthorizeUrl("https://x/a?b=1", "d1.zzz")).toBe("https://x/a?b=1&state=d1.zzz");
    expect(buildConnectorAuthorizeUrl("https://x/a", "d1.zzz")).toBe("https://x/a?state=d1.zzz");
  });

  it("buildConnectorConnectedPageUrl swaps to the error variant", () => {
    expect(buildConnectorConnectedPageUrl("https://app.usebrian.ai")).toBe("https://app.usebrian.ai/desktop/connector-connected");
    expect(buildConnectorConnectedPageUrl("https://app.usebrian.ai", { error: true })).toBe("https://app.usebrian.ai/desktop/connector-connected?status=error");
  });

  it("buildConnectorsReturnPath encodes success and error", () => {
    expect(buildConnectorsReturnPath("ws-1", { connector: "gdrive", instanceId: IID })).toBe(`/w/ws-1/studio/connectors?connected=gdrive&instance=${IID}`);
    expect(buildConnectorsReturnPath("ws-1", { error: "store_failed" })).toBe("/w/ws-1/studio/connectors?error=store_failed");
  });
});

describe("[COMP:app-desktop/connector-oauth] exchangeAndStore", () => {
  it("posts the code to the API with the bearer and returns the instance id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ connectorInstanceId: IID }) });
    const id = await exchangeAndStore("https://api.usebrian.ai", "tok", { connector: "gdrive", code: "c", redirectUri: REDIRECT }, fetchImpl);
    expect(id).toBe(IID);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.usebrian.ai/api/connectors/gdrive/exchange-and-store");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ code: "c", redirectUri: REDIRECT });
  });

  it("passes createNew / instanceId through (mutually exclusive, instanceId wins)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ connectorInstanceId: IID }) });
    await exchangeAndStore("https://api", "t", { connector: "gcal", code: "c", redirectUri: REDIRECT, instanceId: IID, createNew: true }, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ code: "c", redirectUri: REDIRECT, instanceId: IID });
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    await expect(exchangeAndStore("https://api", "t", { connector: "gdrive", code: "c", redirectUri: REDIRECT }, fetchImpl)).rejects.toThrow(/502/);
  });
});
