import { describe, it, expect } from "vitest";

import { quickCaptureUrl } from "../quick-capture.js";

describe("[COMP:app-desktop/quick-capture] quickCaptureUrl", () => {
  it("appends the ?capture=1 hint to the app base URL", () => {
    expect(quickCaptureUrl("https://app.sidan.ai")).toBe("https://app.sidan.ai/?capture=1");
    expect(quickCaptureUrl("http://localhost:3003")).toBe("http://localhost:3003/?capture=1");
  });
});
