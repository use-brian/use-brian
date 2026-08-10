/**
 * [COMP:app-web/feed-brand-check] [COMP:app-web/brand-sdk]
 *
 * The two brand seams whose contract is "stay out of the way": the composer
 * check must warn without ever blocking, and the SDK must hand the Feed the
 * APPROVED record only.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { BrandRecord } from "@use-brian/shared/brand";

const authFetch = vi.fn();
vi.mock("@/lib/auth-fetch", () => ({ authFetch: (...a: unknown[]) => authFetch(...a) }));

import { BrandCheck } from "../brand-check";
import { fetchWorkspaceBrand } from "@/lib/api/brand";

const dict = en as unknown as Dictionary;

const brand = {
  naming: {
    name: "Northwind",
    domains: [],
    handles: ["@northwind"],
    restrictedTerms: ["guaranteed results"],
  },
  messaging: { pillars: [], voice: [], toneNotes: [], avoid: [] },
  colors: [],
  typography: [],
  logoVariants: [],
  claims: [],
} as unknown as BrandRecord;

function render(node: React.ReactElement): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>{node}</I18nProvider>,
  );
}

describe("[COMP:app-web/feed-brand-check] Composer brand check", () => {
  it("renders nothing without a brand, so the composer is unchanged", () => {
    expect(render(<BrandCheck brand={null} text="guaranteed results" />)).toBe("");
  });

  it("renders nothing when the copy is clean", () => {
    expect(render(<BrandCheck brand={brand} text="Parts that arrive." />)).toBe("");
  });

  it("warns, and offers no way to block the save", () => {
    // D38: the operator is the author, not the suspect. A check that can stop
    // a save will eventually stop a correct one.
    const html = render(<BrandCheck brand={brand} text="Our guaranteed results." />);
    expect(html).toContain("guaranteed results");
    expect(html).toContain(en.feedPage.brand.checkHint);
    expect(html).not.toContain("<button");
  });
});

describe("[COMP:app-web/brand-sdk] Workspace brand read", () => {
  beforeEach(() => authFetch.mockReset());

  it("returns the APPROVED record and never the draft", async () => {
    // D35: a draft is a proposal, and an assistant can write one. Rendering it
    // would let an unreviewed suggestion decide how the brand appears publicly.
    authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        brand: { activeRecord: brand, draft: { naming: { name: "LEAKED" } } },
      }),
    });
    const got = await fetchWorkspaceBrand("ws-1");
    expect(got?.naming.name).toBe("Northwind");
    expect(JSON.stringify(got)).not.toContain("LEAKED");
  });

  it("degrades to null on a non-ok response, an absent brand, and a throw", async () => {
    authFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await fetchWorkspaceBrand("ws-1")).toBeNull();

    authFetch.mockResolvedValue({ ok: true, json: async () => ({ brand: null }) });
    expect(await fetchWorkspaceBrand("ws-1")).toBeNull();

  });

  it("degrades to null when the fetch itself fails", async () => {
    // Scoped with `Once` so the throwing implementation cannot leak into a
    // later call and surface as an unhandled error attributed elsewhere.
    authFetch.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    expect(await fetchWorkspaceBrand("ws-1")).toBeNull();
  });
});
