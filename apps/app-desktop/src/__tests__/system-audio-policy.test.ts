import { describe, expect, it } from "vitest";
import {
  captureSourceSnapshot,
  isTrustedCaptureOrigin,
  selectPrimaryDisplaySource,
} from "../system-audio-policy.js";

describe("[COMP:app-desktop/system-audio] Media capture policy", () => {
  it("grants only the configured app origin", () => {
    expect(
      isTrustedCaptureOrigin(
        "https://app.usebrian.ai",
        "https://app.usebrian.ai",
        false,
      ),
    ).toBe(true);
    expect(
      isTrustedCaptureOrigin(
        "https://app.usebrian.ai.evil.example",
        "https://app.usebrian.ai",
        false,
      ),
    ).toBe(false);
    expect(
      isTrustedCaptureOrigin(
        "https://other.example",
        "https://app.usebrian.ai",
        false,
      ),
    ).toBe(false);
  });

  it("allows file capture origins only while the bundled renderer is active", () => {
    expect(isTrustedCaptureOrigin("file://", "https://app.usebrian.ai", true)).toBe(true);
    expect(
      isTrustedCaptureOrigin(
        "file:///Applications/Use%20Brian.app/Contents/Resources/app.asar/renderer/index.html?api=https%3A%2F%2Fapi.usebrian.ai",
        "https://app.usebrian.ai",
        true,
      ),
    ).toBe(true);
    expect(isTrustedCaptureOrigin("file://", "https://app.usebrian.ai", false)).toBe(false);
    expect(
      isTrustedCaptureOrigin(
        "file:///Applications/Use%20Brian.app/Contents/Resources/app.asar/renderer/index.html",
        "https://app.usebrian.ai",
        false,
      ),
    ).toBe(false);
  });

  it("selects the primary display and falls back deterministically", () => {
    const sources = [
      { display_id: "20", name: "secondary" },
      { display_id: "10", name: "primary" },
    ];
    expect(selectPrimaryDisplaySource(sources, 10)?.name).toBe("primary");
    expect(selectPrimaryDisplaySource(sources, 999)?.name).toBe("secondary");
    expect(selectPrimaryDisplaySource([], 10)).toBeUndefined();
  });

  it("serializes a static source preview and preserves an honest empty fallback", () => {
    const toDataURL = () => "data:image/png;base64,preview";
    expect(captureSourceSnapshot({
      id: "screen:1",
      name: "Built-in Display",
      thumbnail: { isEmpty: () => false, toDataURL },
    })).toEqual({
      id: "screen:1",
      name: "Built-in Display",
      thumbnailDataUrl: "data:image/png;base64,preview",
    });
    expect(captureSourceSnapshot({
      id: "window:1",
      name: "Protected Window",
      thumbnail: { isEmpty: () => true, toDataURL },
    })).toEqual({
      id: "window:1",
      name: "Protected Window",
      thumbnailDataUrl: null,
    });
  });
});
