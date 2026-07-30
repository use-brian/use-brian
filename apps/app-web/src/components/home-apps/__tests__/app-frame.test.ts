/**
 * [COMP:app-web/home-app-frame] — the `ub:navigate` path validator.
 *
 * A custom app is third-party code we render inside our own chrome. If it can
 * hand the host an arbitrary URL to navigate to, it is an open redirector
 * wearing our branding — and, worse, one that could walk a user into a
 * workspace the app was never installed in. Same validation posture as
 * `normalizeNavigateUrl` on the computer-use side: in-app paths only, and
 * confined to this workspace.
 */

import { describe, expect, it } from "vitest";
import { normalizeAppNavigatePath } from "../app-frame";

const WS = "ws-1";

describe("[COMP:app-web/home-app-frame] normalizeAppNavigatePath", () => {
  it("accepts in-app paths inside this workspace", () => {
    expect(normalizeAppNavigatePath("/w/ws-1", WS)).toBe("/w/ws-1");
    expect(normalizeAppNavigatePath("/w/ws-1/tasks", WS)).toBe("/w/ws-1/tasks");
    expect(normalizeAppNavigatePath("/w/ws-1/p/abc?x=1#y", WS)).toBe("/w/ws-1/p/abc?x=1#y");
  });

  it("refuses anything that could leave the site", () => {
    for (const path of [
      "https://evil.example.com",
      "//evil.example.com",
      "javascript:alert(1)",
      "/w/ws-1\\..\\evil",
      "http://x/w/ws-1",
      "w/ws-1/tasks",
      "",
    ]) {
      expect(normalizeAppNavigatePath(path, WS)).toBeNull();
    }
  });

  it("refuses another workspace — an app may not walk the user out of its own", () => {
    expect(normalizeAppNavigatePath("/w/ws-2/brain", WS)).toBeNull();
    // Prefix-collision: `/w/ws-10` must not pass as `/w/ws-1`.
    expect(normalizeAppNavigatePath("/w/ws-10/brain", WS)).toBeNull();
  });

  it("refuses non-strings and absurd lengths without throwing", () => {
    expect(normalizeAppNavigatePath(null, WS)).toBeNull();
    expect(normalizeAppNavigatePath(42, WS)).toBeNull();
    expect(normalizeAppNavigatePath({}, WS)).toBeNull();
    expect(normalizeAppNavigatePath(`/w/${WS}/${"a".repeat(600)}`, WS)).toBeNull();
  });
});
