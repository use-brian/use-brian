import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chromiumPopup = readFileSync(
  new URL("../../static/popup.html", import.meta.url),
  "utf8",
);
const firefoxPopup = readFileSync(
  new URL("../../static-firefox/popup.html", import.meta.url),
  "utf8",
);

describe("[COMP:ext/agent] popup focus treatment", () => {
  it("uses the text field border as the only focus frame in both popup builds", () => {
    for (const popup of [chromiumPopup, firefoxPopup]) {
      expect(popup).toMatch(
        /input:not\(\[type="checkbox"\]\):focus-visible \{[^}]*outline: none;[^}]*border-color: #2563eb;[^}]*box-shadow: none;/,
      );
    }
  });
});
