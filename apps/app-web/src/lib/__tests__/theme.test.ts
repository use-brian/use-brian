/**
 * [COMP:app-web/theme] Doc palette set.
 *
 * Locks the palette surface to exactly the two that ship: the Notion-faithful
 * `notion` default and the AI-generated `custom` theme. The four brand palettes
 * (slate / indigo / emerald / sunset) were removed — these assertions guard the
 * three places a stray brand id could creep back in: the selectable `PALETTES`
 * list, the `THEME_PRESETS` footer dropdown, and the pre-paint validation map
 * inside `THEME_PREPAINT_SCRIPT` (a hand-inlined string the type system can't
 * see). `currentPresetId` is the (palette, mode) → dropdown-value mapping.
 *
 * app-web vitest is node-only, so we assert the pure exports of `theme.tsx`
 * — no provider mount, no localStorage.
 *
 * Spec: docs/architecture/features/doc.md → "Theme & palettes".
 */

import { describe, expect, it } from "vitest";
import {
  PALETTES,
  THEME_PRESETS,
  THEME_PREPAINT_SCRIPT,
  currentPresetId,
} from "../theme";

const REMOVED = ["slate", "indigo", "emerald", "sunset"] as const;

describe("[COMP:app-web/theme] Doc palette set", () => {
  it("offers only the notion built-in palette", () => {
    expect([...PALETTES]).toEqual(["notion"]);
    for (const id of REMOVED) expect(PALETTES).not.toContain(id);
  });

  it("lists only the two Default presets, both on the notion palette", () => {
    expect(THEME_PRESETS.map((p) => p.id)).toEqual(["default", "default-dark"]);
    expect(THEME_PRESETS.every((p) => p.palette === "notion")).toBe(true);
    expect(THEME_PRESETS.find((p) => p.id === "default")?.mode).toBe("light");
    expect(THEME_PRESETS.find((p) => p.id === "default-dark")?.mode).toBe("dark");
  });

  it("maps (palette, mode) to the dropdown value", () => {
    expect(currentPresetId("notion", "light")).toBe("default");
    expect(currentPresetId("notion", "dark")).toBe("default-dark");
    // A custom theme is shown separately, so the built-in presets don't claim it.
    expect(currentPresetId("custom", "light")).toBeNull();
  });

  it("pre-paint whitelist accepts only notion + custom", () => {
    expect(THEME_PREPAINT_SCRIPT).toContain("ok={notion:1,custom:1}");
    for (const id of REMOVED) expect(THEME_PREPAINT_SCRIPT).not.toContain(id);
  });
});
