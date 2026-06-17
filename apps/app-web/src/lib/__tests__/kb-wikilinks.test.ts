/**
 * Wikilink rewrite + client-side resolution for the knowledge entry
 * reader. Verifies the `[[target|alias]]` → `kbwiki:` rewrite (fence
 * aware), and the resolution order against the entry's related refs:
 * exact path → relative → basename → title; external links pass through.
 */

import { describe, it, expect } from "vitest";
import {
  KB_WIKILINK_SCHEME,
  resolveWikilinkTarget,
  rewriteWikilinks,
} from "../kb-wikilinks";

const RELATED = [
  { id: "1", title: "Vault", path: "products/vault" },
  { id: "2", title: "Fee schedule", path: "products/vault/fees" },
  { id: "3", title: "Perps", path: "products/perpetual-futures/index-doc" },
];

describe("[COMP:app-web/kb-wikilinks] rewriteWikilinks", () => {
  it("rewrites aliased and bare wikilinks into kbwiki links", () => {
    expect(rewriteWikilinks("See [[products/vault|the Vault]] and [[fees]].")).toBe(
      `See [the Vault](${KB_WIKILINK_SCHEME}products%2Fvault) and [fees](${KB_WIKILINK_SCHEME}fees).`,
    );
  });

  it("leaves fenced code blocks untouched", () => {
    const md = "before [[a]]\n```\ninside [[b]]\n```\nafter [[c]]";
    const out = rewriteWikilinks(md);
    expect(out).toContain("inside [[b]]");
    expect(out).toContain(`[a](${KB_WIKILINK_SCHEME}a)`);
    expect(out).toContain(`[c](${KB_WIKILINK_SCHEME}c)`);
  });
});

describe("[COMP:app-web/kb-wikilinks] resolveWikilinkTarget", () => {
  it("resolves an exact path target", () => {
    const hit = resolveWikilinkTarget(
      `${KB_WIKILINK_SCHEME}${encodeURIComponent("products/vault")}`,
      "products/other",
      RELATED,
    );
    expect(hit?.id).toBe("1");
  });

  it("resolves a relative .md link against the current entry's directory", () => {
    const hit = resolveWikilinkTarget("../vault/fees.md", "products/vault/intro", RELATED);
    expect(hit?.id).toBe("2");
  });

  it("resolves a bare basename", () => {
    const hit = resolveWikilinkTarget(`${KB_WIKILINK_SCHEME}fees`, "products/vault", RELATED);
    expect(hit?.id).toBe("2");
  });

  it("falls back to a title match", () => {
    const hit = resolveWikilinkTarget(`${KB_WIKILINK_SCHEME}Fee%20schedule`, "x", RELATED);
    expect(hit?.id).toBe("2");
  });

  it("ignores external and unresolvable targets", () => {
    expect(resolveWikilinkTarget("https://example.com/doc.md", "x", RELATED)).toBeNull();
    expect(resolveWikilinkTarget(`${KB_WIKILINK_SCHEME}ghost`, "x", RELATED)).toBeNull();
  });
});
