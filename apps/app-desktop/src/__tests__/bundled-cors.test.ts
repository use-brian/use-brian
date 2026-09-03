import { describe, expect, it } from "vitest";

import {
  bridgeBundledCorsHeaders,
  shouldBridgeBundledCors,
} from "../bundled-cors.js";

describe("[COMP:app-desktop/bundled-cors] file renderer API bridge", () => {
  it("admits only bundled trusted windows calling the configured API origin", () => {
    const base = {
      bundled: true,
      requestUrl: "https://api.usebrian.ai/api/assistants",
      apiUrl: "https://api.usebrian.ai",
      webContentsId: 7,
      trustedWebContentsIds: [7, 8],
    };
    expect(shouldBridgeBundledCors(base)).toBe(true);
    expect(shouldBridgeBundledCors({ ...base, bundled: false })).toBe(false);
    expect(shouldBridgeBundledCors({ ...base, webContentsId: 9 })).toBe(false);
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
});
