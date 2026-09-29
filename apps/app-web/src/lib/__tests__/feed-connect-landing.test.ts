import { describe, it, expect } from "vitest";
import {
  parseConnectLanding,
  stripConnectLandingParams,
} from "@/lib/feed-connect-landing";

describe("[COMP:app-web/feed-connect-landing] OAuth return landing", () => {
  it("confirms a connect that returned without an error", () => {
    expect(parseConnectLanding("?connected=twitter&twitter_connected=1", "twitter")).toEqual({ kind: "confirming" });
    expect(parseConnectLanding("?connected=twitter", "twitter")).toEqual({ kind: "confirming" });
  });

  it("reports the callback's error before the connected marker", () => {
    expect(parseConnectLanding("?connected=twitter&error=twitter_consent_denied", "twitter")).toEqual({ kind: "denied" });
    expect(parseConnectLanding("?connected=twitter&error=twitter_exchange_failed", "twitter")).toEqual({ kind: "failed" });
    expect(parseConnectLanding("?connected=twitter&error=twitter_scope_missing", "twitter")).toEqual({ kind: "failed" });
  });

  it("ignores another platform's landing and a bare page", () => {
    expect(parseConnectLanding("?connected=threads", "twitter")).toEqual({ kind: "none" });
    expect(parseConnectLanding("?error=threads_auth_failed", "twitter")).toEqual({ kind: "none" });
    expect(parseConnectLanding("", "twitter")).toEqual({ kind: "none" });
  });

  it("strips only the landing params from the router query", () => {
    expect(stripConnectLandingParams("connected=twitter&twitter_connected=1&tab=a")).toBe("?tab=a");
    expect(stripConnectLandingParams("connected=twitter&error=twitter_auth_failed")).toBe("");
  });
});
