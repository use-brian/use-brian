import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const signinHtml = readFileSync(new URL("../signin.html", import.meta.url), "utf8");

describe("[COMP:app-desktop/signin-landing] focus treatment", () => {
  it("uses the custom URL field border as its only active frame", () => {
    expect(signinHtml).toMatch(
      /input\[type="text"\]:focus \{[\s\S]*?border-color: #34d3ff;[\s\S]*?box-shadow: none;/,
    );
  });
});
