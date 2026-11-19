import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const shared = readFileSync(new URL("../../../../packages/chat-ui/src/theme.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../../../app-web/src/app/globals.css", import.meta.url), "utf8");
const declarations = (body: string) => Object.fromEntries(
  [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]),
);
const rule = (selector: string, source = css) => {
  const start = source.indexOf(`${selector} {`);
  expect(start, `Missing CSS rule: ${selector}`).toBeGreaterThanOrEqual(0);
  return source.slice(start + selector.length + 2, source.indexOf("}", start));
};

describe("[COMP:auth-web/theme] standalone entry styling contract", () => {
  it("imports the canonical theme without a package dependency or workspace app globals", () => {
    expect(css).toContain('@import "../../../../packages/chat-ui/src/theme.css";');
    expect(css).not.toMatch(/@import[^;]*(?:app-web|appearance\.css)/);
    expect(rule("body")).toContain("font-family: var(--font-rocknroll)");
    expect(rule("body")).toContain("font-weight: 450");
    expect(rule(".title")).toContain("font-family: var(--font-display)");
    expect(css).not.toMatch(/gradient\(|#081018|#55d6e8|#0008/i);
  });

  it("bridges OS dark mode using canonical dark values, while allowing explicit host modes", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    const dark = declarations(rule(":root:not(.light):not(.dark)"));
    const canonical = declarations(rule(".dark", shared));
    expect(Object.keys(dark).sort()).toEqual([
      "--background", "--foreground", "--card", "--card-foreground",
      "--muted-foreground", "--accent", "--border", "--input", "--ring",
    ].sort());
    for (const [token, value] of Object.entries(dark)) {
      if (token !== "--ring") expect(value, token).toBe(canonical[token]);
    }
    expect(rule(":root")).toContain("color-scheme: light");
    expect(rule(":root.dark")).toContain("color-scheme: dark");
    expect(rule(":root:root", app)).toContain(`--interaction-border: ${declarations(rule(":root"))["--ring"]};`);
    expect(rule(":root:root.dark", app)).toContain(`--interaction-border: ${dark["--ring"]};`);
    expect(declarations(rule(":root.dark"))["--ring"]).toBe(dark["--ring"]);
  });

  it("uses paired neutral actions and border-only field focus, including invalid states", () => {
    expect(rule(".button")).toContain("color: var(--action-foreground)");
    expect(rule(".button")).toContain("background: var(--action)");
    expect(css).not.toContain("var(--primary)");
    expect(rule(".input:focus")).toContain("border-color: var(--ring)");
    expect(rule(".input:focus")).toContain("box-shadow: none");
    expect(rule('.input[aria-invalid="true"], .input[aria-invalid="true"]:focus')).toContain("border-color: var(--destructive)");
    for (const selector of [".button", ".link", ".recovery-button", ".languages button"]) {
      expect(css).toContain(`${selector}:focus-visible`);
    }
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("outline: 2px solid Highlight");
  });

  it("keeps phone fields and every auth action usable and long translated content wrapping", () => {
    const phone = css.slice(css.indexOf("@media (width < 48rem)"));
    expect(rule(".input", phone)).toContain("font-size: 16px");
    expect(rule(".input, .button, .languages button, .recovery-button", phone)).toContain("min-height: 44px");
    expect(rule(".link", phone)).toContain("min-height: 44px");
    expect(rule(".card")).toContain("width: min(100%, 420px)");
    expect(rule(".card")).toContain("overflow-wrap: anywhere");
    expect(rule(".recipient")).toContain("overflow-wrap: anywhere");
    expect(rule(".languages")).toContain("flex-wrap: wrap");
    expect(rule(".recovery-actions")).toContain("flex-wrap: wrap");
    expect(rule(".recovery-button")).toContain("white-space: normal");
    expect(rule(".button")).toContain("white-space: normal");
    expect(rule(".shell")).toContain("min-height: 100dvh");
  });
});
