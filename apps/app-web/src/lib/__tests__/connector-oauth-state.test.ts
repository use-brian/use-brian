import { describe, it, expect } from "vitest";
import {
  buildConnectorState,
  parseConnectorState,
  verifyConnectorState,
  CONNECTOR_OAUTH_STATE_COOKIE,
} from "@/lib/connector-oauth-state";
import {
  connectorOauthStateCookieString,
  mintOauthStateNonce,
} from "@/lib/oauth-state-cookie";

/**
 * WS3 #5 — connector-connect OAuth `state` CSRF gate. The state carries a nonce
 * that must match a companion cookie set before the provider redirect; a forged
 * callback (attacker-planted `code`, no/mismatched nonce) must be rejected, and
 * the legitimate round-trip (same nonce in state + cookie) must pass.
 */
describe("[COMP:app-web/connector-oauth-state] Connector OAuth state CSRF", () => {
  const NONCE = mintOauthStateNonce();
  const WS = "11111111-2222-3333-4444-555555555555";

  describe("build ↔ parse round-trip", () => {
    it("round-trips connector + workspace + nonce", () => {
      const state = buildConnectorState({ connector: "gcal", workspaceId: WS, nonce: NONCE });
      const parsed = parseConnectorState(state);
      expect(parsed).toEqual({
        connector: "gcal",
        workspaceId: WS,
        createNew: false,
        nonce: NONCE,
      });
    });

    it("round-trips the `:add` (create-new) intent", () => {
      const state = buildConnectorState({
        connector: "notion",
        workspaceId: WS,
        createNew: true,
        nonce: NONCE,
      });
      expect(state).toBe(`notion:add:${WS}:${NONCE}`);
      const parsed = parseConnectorState(state);
      expect(parsed.connector).toBe("notion");
      expect(parsed.createNew).toBe(true);
      expect(parsed.workspaceId).toBe(WS);
      expect(parsed.nonce).toBe(NONCE);
    });

    it("parses fathom + add + nonce (last colon-segment is the nonce, not the workspace)", () => {
      const state = buildConnectorState({
        connector: "fathom",
        workspaceId: WS,
        createNew: true,
        nonce: NONCE,
      });
      const parsed = parseConnectorState(state);
      expect(parsed.workspaceId).toBe(WS);
      expect(parsed.nonce).toBe(NONCE);
    });

    it("round-trips the reconnect (`:re:<instanceId>`) intent for a workspace-owned OAuth connector", () => {
      const INST = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const state = buildConnectorState({ connector: "gmail", workspaceId: WS, instanceId: INST, nonce: NONCE });
      expect(state).toBe(`gmail:re:${INST}:${WS}:${NONCE}`);
      const parsed = parseConnectorState(state);
      expect(parsed.connector).toBe("gmail");
      expect(parsed.instanceId).toBe(INST);
      expect(parsed.createNew).toBe(false);
      expect(parsed.workspaceId).toBe(WS);
      expect(parsed.nonce).toBe(NONCE);
    });

    it("reconnect wins over add-another (mutually exclusive intents)", () => {
      const INST = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const state = buildConnectorState({ connector: "notion", workspaceId: WS, createNew: true, instanceId: INST, nonce: NONCE });
      expect(state).toBe(`notion:re:${INST}:${WS}:${NONCE}`);
      const parsed = parseConnectorState(state);
      expect(parsed.instanceId).toBe(INST);
      expect(parsed.createNew).toBe(false);
    });

    it("drops a malformed (non-UUID) reconnect id but keeps the tail aligned", () => {
      const parsed = parseConnectorState(`gmail:re:not-a-uuid:${WS}:${NONCE}`);
      expect(parsed.instanceId).toBeUndefined();
      expect(parsed.workspaceId).toBe(WS);
      expect(parsed.nonce).toBe(NONCE);
    });
  });

  describe("legacy / malformed state (no nonce) parses but carries no nonce", () => {
    it("legacy 3-part `<connector>:<workspace>` → nonce undefined", () => {
      const parsed = parseConnectorState(`gcal:${WS}`);
      expect(parsed.connector).toBe("gcal");
      expect(parsed.workspaceId).toBe(WS);
      expect(parsed.nonce).toBeUndefined();
    });

    it("legacy `<connector>:add` (no workspace, no nonce)", () => {
      const parsed = parseConnectorState("notion:add");
      expect(parsed.connector).toBe("notion");
      expect(parsed.createNew).toBe(true);
      expect(parsed.workspaceId).toBeUndefined();
      expect(parsed.nonce).toBeUndefined();
    });

    it("bare slug", () => {
      const parsed = parseConnectorState("gmail");
      expect(parsed.connector).toBe("gmail");
      expect(parsed.workspaceId).toBeUndefined();
      expect(parsed.nonce).toBeUndefined();
    });

    it("empty state", () => {
      const parsed = parseConnectorState("");
      expect(parsed.connector).toBe("");
      expect(parsed.nonce).toBeUndefined();
    });

    it("rejects an out-of-alphabet / wrong-length nonce segment (→ undefined)", () => {
      // Contains a `.` (not base64url) → not accepted as a nonce.
      const parsed = parseConnectorState(`gcal:${WS}:not.a.valid.nonce`);
      expect(parsed.nonce).toBeUndefined();
    });
  });

  describe("verifyConnectorState — the CSRF gate", () => {
    it("PASSES when state nonce equals the cookie nonce (legitimate flow)", () => {
      expect(verifyConnectorState({ stateNonce: NONCE, cookieNonce: NONCE })).toBe(true);
    });

    it("REJECTS a forged callback whose state nonce differs from the cookie", () => {
      const attacker = mintOauthStateNonce();
      expect(attacker).not.toBe(NONCE);
      expect(verifyConnectorState({ stateNonce: attacker, cookieNonce: NONCE })).toBe(false);
    });

    it("REJECTS when the cookie is absent (attacker cannot set it in the victim's browser)", () => {
      expect(verifyConnectorState({ stateNonce: NONCE, cookieNonce: undefined })).toBe(false);
      expect(verifyConnectorState({ stateNonce: NONCE, cookieNonce: null })).toBe(false);
    });

    it("REJECTS a legacy unsigned state (no nonce) even if a stale cookie is present", () => {
      const { nonce } = parseConnectorState(`gcal:${WS}`);
      expect(verifyConnectorState({ stateNonce: nonce, cookieNonce: NONCE })).toBe(false);
    });

    it("REJECTS when both are absent", () => {
      expect(verifyConnectorState({ stateNonce: undefined, cookieNonce: undefined })).toBe(false);
    });

    it("REJECTS a malformed (out-of-alphabet) nonce even if it string-equals the cookie", () => {
      expect(verifyConnectorState({ stateNonce: "short", cookieNonce: "short" })).toBe(false);
    });

    it("end-to-end: forged callback with a valid attacker code but wrong state is rejected", () => {
      // Victim's browser holds the cookie from their own last connect attempt…
      const victimCookie = mintOauthStateNonce();
      // …the attacker lures them to a callback carrying the attacker's own state.
      const forged = parseConnectorState(
        buildConnectorState({ connector: "gcal", workspaceId: WS, nonce: mintOauthStateNonce() }),
      );
      expect(
        verifyConnectorState({ stateNonce: forged.nonce, cookieNonce: victimCookie }),
      ).toBe(false);
    });
  });

  describe("nonce + cookie minting", () => {
    it("mints URL-safe nonces that survive the parse alphabet gate", () => {
      for (let i = 0; i < 50; i += 1) {
        const n = mintOauthStateNonce();
        expect(n).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
        const parsed = parseConnectorState(buildConnectorState({ connector: "gcal", workspaceId: WS, nonce: n }));
        expect(parsed.nonce).toBe(n);
      }
    });

    it("mints distinct nonces (no fixed value)", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 100; i += 1) seen.add(mintOauthStateNonce());
      expect(seen.size).toBe(100);
    });

    it("builds a SameSite=Lax, short-lived cookie string carrying the nonce", () => {
      const s = connectorOauthStateCookieString(NONCE);
      expect(s).toContain(`${CONNECTOR_OAUTH_STATE_COOKIE}=${NONCE}`);
      expect(s).toContain("SameSite=Lax");
      expect(s).toContain("Path=/");
      expect(s).toMatch(/Max-Age=\d+/);
    });
  });
});
