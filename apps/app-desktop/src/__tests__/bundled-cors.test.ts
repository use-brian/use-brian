import { describe, expect, it } from "vitest";

import {
  bridgeBundledCorsHeaders,
  shouldBridgeBundledCors,
} from "../bundled-cors.js";

describe("[COMP:app-desktop/bundled-cors] file renderer API bridge", () => {
  it("admits only bundled requests to the configured API origin", () => {
    const base = {
      bundled: true,
      requestUrl: "https://api.usebrian.ai/api/assistants",
      apiUrl: "https://api.usebrian.ai",
    };
    expect(shouldBridgeBundledCors(base)).toBe(true);
    expect(shouldBridgeBundledCors({ ...base, bundled: false })).toBe(false);
    expect(
      shouldBridgeBundledCors({
        ...base,
        requestUrl: "https://attacker.example/api/assistants",
      }),
    ).toBe(false);
  });

  it("replaces only the CORS origin response header", () => {
    expect(
      bridgeBundledCorsHeaders({
        "content-type": ["application/json"],
        "access-control-allow-origin": ["https://app.usebrian.ai"],
      }),
    ).toEqual({
      "content-type": ["application/json"],
      "Access-Control-Allow-Origin": ["null"],
    });
  });

  it("allows the credentialed local renderer to read a bearer-only API response", () => {
    // Public API opaque-origin responses deliberately omit credential admission.
    // The trusted native bridge must complete the local renderer's include mode.
    const apiHeaders = {
      "access-control-allow-origin": ["null"],
      "access-control-allow-headers": ["Content-Type, Authorization, X-Client-Timezone"],
      vary: ["Origin"],
    };
    const headers = bridgeBundledCorsHeaders(apiHeaders, { includeCredentials: true });
    expect(headers["Access-Control-Allow-Origin"]).toEqual(["null"]);
    expect(headers["Access-Control-Allow-Credentials"]).toEqual(["true"]);
    expect(headers.vary).toEqual(["Origin"]);
    expect(apiHeaders).not.toHaveProperty("Access-Control-Allow-Credentials");
  });

  it("normalizes conflicting upstream credential headers only for local include mode", () => {
    const upstream = {
      "access-control-allow-credentials": ["false"],
      "ACCESS-CONTROL-ALLOW-CREDENTIALS": ["true"],
      "content-type": ["application/json"],
    };
    expect(bridgeBundledCorsHeaders(upstream, { includeCredentials: true })).toEqual({
      "content-type": ["application/json"],
      "Access-Control-Allow-Origin": ["null"],
      "Access-Control-Allow-Credentials": ["true"],
    });
    expect(bridgeBundledCorsHeaders(upstream)).toEqual({
      ...upstream,
      "Access-Control-Allow-Origin": ["null"],
    });
  });

  it("removes upstream credential admission when a local requester is untrusted", () => {
    expect(bridgeBundledCorsHeaders({
      "access-control-allow-credentials": ["true"],
      "ACCESS-CONTROL-ALLOW-CREDENTIALS": ["true"],
    }, { includeCredentials: false })).toEqual({
      "Access-Control-Allow-Origin": ["null"],
    });
  });
});
