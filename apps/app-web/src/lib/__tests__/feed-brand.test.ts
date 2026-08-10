/** [COMP:app-web/feed-brand] */

import { describe, expect, it } from "vitest";
import type { BrandRecord } from "@use-brian/shared/brand";
import {
  brandCopyFlags,
  brandLogoFileId,
  brandPillarLabels,
  brandPreviewIdentity,
  brandVoiceSummary,
} from "@/lib/feed-brand";

function brand(overrides: Partial<BrandRecord> = {}): BrandRecord {
  return {
    naming: {
      name: "Northwind Supply",
      publicName: "Northwind",
      domains: [],
      handles: ["@northwind"],
      capitalization: "Always one word.",
      restrictedTerms: ["guaranteed results"],
    },
    messaging: {
      oneLine: "Parts that arrive.",
      pillars: [{ title: "Reliability", statement: "We ship.", proof: [] }],
      voice: [{ trait: "Direct", means: "Lead with the number.", avoid: "Hedging." }],
      toneNotes: ["Never exclaim."],
      avoid: ["revolutionary platform"],
    },
    colors: [],
    typography: [],
    logoVariants: [
      { variant: "primary", fileId: "file-primary" },
      { variant: "compact", fileId: "file-compact" },
    ],
    claims: [
      { text: "the fastest delivery in europe", status: "prohibited" },
      { text: "trusted by many teams today", status: "approved" },
    ],
    ...overrides,
  } as BrandRecord;
}

describe("[COMP:app-web/feed-brand] Preview identity", () => {
  it("prefers the public name and uses the REAL handle", () => {
    const id = brandPreviewIdentity(brand());
    expect(id.displayName).toBe("Northwind");
    expect(id.handle).toBe("northwind");
    expect(id.logoFileId).toBe("file-compact");
  });

  it("returns a null handle rather than inventing one", () => {
    // The whole point of D36: before this, the preview lowercased the
    // assistant name into a handle that may not exist. No handle must render
    // as no handle, never as a confident guess.
    const id = brandPreviewIdentity(
      brand({ naming: { name: "Northwind Supply", domains: [], handles: [], restrictedTerms: [] } } as Partial<BrandRecord>),
    );
    expect(id.handle).toBeNull();
  });

  it("degrades to all-null with no brand", () => {
    expect(brandPreviewIdentity(null)).toEqual({
      displayName: null,
      handle: null,
      logoFileId: null,
    });
    expect(brandLogoFileId(null)).toBeNull();
  });
});

describe("[COMP:app-web/feed-brand] Brand check", () => {
  it("flags a restricted term, an avoid phrase, and a prohibited claim", () => {
    const flags = brandCopyFlags(
      brand(),
      "Our guaranteed results make this a revolutionary platform with the fastest delivery in europe.",
    );
    expect(flags.map((f) => f.kind).sort()).toEqual(["avoid", "claim", "restricted"]);
  });

  it("ignores an approved claim and clean copy", () => {
    expect(brandCopyFlags(brand(), "Parts that arrive on time.")).toEqual([]);
    expect(brandCopyFlags(brand(), "trusted by many teams today")).toEqual([]);
  });

  it("skips short phrases so the check does not cry wolf", () => {
    // "best" would match inside "bestseller"; a check the operator learns to
    // ignore costs more than no check.
    const short = brand({
      naming: { name: "N", domains: [], handles: [], restrictedTerms: ["best"] },
    } as Partial<BrandRecord>);
    expect(brandCopyFlags(short, "our bestseller")).toEqual([]);
  });

  it("matches across case and punctuation", () => {
    expect(
      brandCopyFlags(brand(), "GUARANTEED   RESULTS!!").map((f) => f.phrase),
    ).toEqual(["guaranteed results"]);
  });

  it("is empty with no brand and never throws on empty text", () => {
    expect(brandCopyFlags(null, "anything")).toEqual([]);
    expect(brandCopyFlags(brand(), "")).toEqual([]);
  });
});

describe("[COMP:app-web/feed-brand] Voice + pillars", () => {
  it("summarises the voice triples and tone", () => {
    const summary = brandVoiceSummary(brand());
    expect(summary?.traits[0].trait).toBe("Direct");
    expect(summary?.toneNotes).toEqual(["Never exclaim."]);
    expect(summary?.capitalization).toBe("Always one word.");
  });

  it("returns null when there is nothing to show", () => {
    expect(brandVoiceSummary(null)).toBeNull();
    expect(
      brandVoiceSummary(
        brand({
          messaging: { pillars: [], voice: [], toneNotes: [], avoid: [] },
          naming: { name: "N", domains: [], handles: [], restrictedTerms: [] },
        } as unknown as Partial<BrandRecord>),
      ),
    ).toBeNull();
  });

  it("offers pillar titles as month themes", () => {
    expect(brandPillarLabels(brand())).toEqual(["Reliability"]);
    expect(brandPillarLabels(null)).toEqual([]);
  });
});
