import { describe, it, expect } from "vitest";

import {
  parseDesktopConnectorState,
  buildLoopbackForwardUrl,
  DESKTOP_CONNECTOR_STATE_PREFIX,
  type DesktopConnectorState,
} from "../connector-oauth-desktop";

/** Build a `d1.`-prefixed desktop state the shell would emit (base64url JSON). */
function desktopState(over: Partial<Record<"c" | "w" | "n" | "l" | "a" | "i", unknown>> = {}): string {
  const obj = {
    c: "gdrive",
    w: "ws-1",
    n: "AAAAAAAAAAAAAAAAAAAAAA", // 22 base64url chars — matches NONCE_RE
    l: "http://127.0.0.1:52345/cb",
    ...over,
  };
  return DESKTOP_CONNECTOR_STATE_PREFIX + Buffer.from(JSON.stringify(obj)).toString("base64url");
}

describe("[COMP:app-web/connector-oauth-desktop] parseDesktopConnectorState", () => {
  it("parses a well-formed desktop state", () => {
    const s = parseDesktopConnectorState(desktopState());
    expect(s).toEqual<DesktopConnectorState>({
      connector: "gdrive",
      workspaceId: "ws-1",
      createNew: false,
      instanceId: undefined,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      loopback: "http://127.0.0.1:52345/cb",
    });
  });

  it("returns null for the web colon-format state (falls back to parseConnectorState)", () => {
    expect(parseDesktopConnectorState("gdrive:ws-1:AAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
    expect(parseDesktopConnectorState("notion:add:ws-1:AAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
  });

  it("returns null for a missing prefix, malformed base64, or bad JSON", () => {
    expect(parseDesktopConnectorState("")).toBeNull();
    expect(parseDesktopConnectorState("d1.not-valid-base64-json!!")).toBeNull();
    expect(parseDesktopConnectorState("d1." + Buffer.from("{not json").toString("base64url"))).toBeNull();
  });

  it("rejects a state with no connector, a bad nonce, or no loopback", () => {
    expect(parseDesktopConnectorState(desktopState({ c: "" }))).toBeNull();
    expect(parseDesktopConnectorState(desktopState({ n: "short" }))).toBeNull();
    expect(parseDesktopConnectorState(desktopState({ l: "" }))).toBeNull();
  });

  it("carries createNew and a valid instanceId, dropping a malformed one", () => {
    const iid = "11111111-1111-1111-1111-111111111111";
    const withNew = parseDesktopConnectorState(desktopState({ a: 1, i: iid }));
    expect(withNew).toMatchObject({ createNew: true, instanceId: iid });
    const badIid = parseDesktopConnectorState(desktopState({ i: "not-a-uuid" }));
    expect(badIid?.instanceId).toBeUndefined();
  });
});

describe("[COMP:app-web/connector-oauth-desktop] buildLoopbackForwardUrl", () => {
  const state = parseDesktopConnectorState(desktopState())!;

  it("forwards the code + nonce to the validated loopback", () => {
    const url = buildLoopbackForwardUrl(state, { code: "code-abc" });
    expect(url).toBe("http://127.0.0.1:52345/cb?state=AAAAAAAAAAAAAAAAAAAAAA&code=code-abc");
  });

  it("forwards a provider error instead of the code", () => {
    const url = buildLoopbackForwardUrl(state, { error: "access_denied" });
    expect(url).toBe("http://127.0.0.1:52345/cb?state=AAAAAAAAAAAAAAAAAAAAAA&error=access_denied");
  });

  it("emits no_code when neither code nor error is present", () => {
    expect(buildLoopbackForwardUrl(state, {})).toContain("error=no_code");
  });

  it("returns null (never an open redirect) for a non-loopback loopback host", () => {
    const evil = parseDesktopConnectorState(desktopState({ l: "https://evil.example/cb" }));
    // Non-loopback host fails loopbackRedirectBase inside buildLoopbackForwardUrl.
    expect(buildLoopbackForwardUrl({ ...state, loopback: "https://evil.example/cb" }, { code: "x" })).toBeNull();
    // (parse still returns the state; the host guard lives in the forward builder.)
    expect(evil).not.toBeNull();
  });
});
