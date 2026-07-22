import { describe, it, expect } from "vitest";

import { quickCaptureUrl, recordTargetUrl } from "../quick-capture.js";

describe("[COMP:app-desktop/quick-capture] quickCaptureUrl", () => {
  it("appends the ?capture=1 hint to the app base URL", () => {
    expect(quickCaptureUrl("https://app.usebrian.ai")).toBe("https://app.usebrian.ai/?capture=1");
    expect(quickCaptureUrl("http://localhost:3003")).toBe("http://localhost:3003/?capture=1");
  });

  it("appends the ?record=1 hint (the dock recorder's auto-start param)", () => {
    expect(recordTargetUrl("https://app.usebrian.ai")).toBe("https://app.usebrian.ai/?record=1");
    expect(recordTargetUrl("http://localhost:3003")).toBe("http://localhost:3003/?record=1");
  });
});
