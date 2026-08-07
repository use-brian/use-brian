/**
 * [COMP:app-web/studio-brand] — the brand draft editor's pure conversions.
 *
 * The failure this suite exists to catch is a LOSSY ROUND TRIP. The form
 * renders five groups as friendly fields and the rest as JSON; if converting
 * back dropped a group, saving the form would silently delete brand data
 * entered from Studio, a chat tool, or an agency's brain key.
 *
 * Fixture data is invented.
 */

import { describe, it, expect } from "vitest";
import {
  FORM_GROUPS,
  JSON_GROUPS,
  formToPatch,
  isDirty,
  recordToForm,
  toLines,
  type BrandRecordLike,
} from "../brand-form";

const RECORD: BrandRecordLike = {
  naming: {
    name: "Northwind Ferry",
    publicName: "Northwind",
    tagline: "Every crossing, on the hour",
    capitalization: "Northwind Ferry - two words",
    restrictedTerms: ["unsinkable", "cheapest"],
    domains: ["northwind-ferry.example"],
  },
  strategy: {
    positioning: "The scheduled alternative to chartered crossings.",
    audience: ["Island wholesalers", "Regional hauliers"],
    differentiators: ["Fixed hourly departures"],
  },
  messaging: {
    oneLine: "Scheduled coastal freight you can plan around.",
    voice: [
      { trait: "Punctual", means: "Lead with the time", avoid: "Scene-setting" },
      { trait: "Plain", means: "Use the dock word", avoid: "Jargon" },
    ],
    preferred: ["crossing"],
    avoid: ["voyage"],
  },
  colors: [{ name: "Deep channel", token: "--brand-ink", value: "#0F2233", role: "primary surface" }],
  typography: [{ role: "body", family: "Inter", treatment: "400 weight", fallback: "Arial" }],
  claims: [{ text: "98% on time.", status: "approved" }],
  rights: [{ asset: "Photos", creator: "Invented Studio", licence: "Perpetual" }],
  logoVariants: [],
};

describe("[COMP:app-web/studio-brand] recordToForm", () => {
  it("renders the friendly groups as editable text", () => {
    const form = recordToForm(RECORD);
    expect(form.name).toBe("Northwind Ferry");
    expect(form.restrictedTerms).toBe("unsinkable\ncheapest");
    expect(form.voice).toBe("Punctual | Lead with the time | Scene-setting\nPlain | Use the dock word | Jargon");
    expect(form.colors).toBe("Deep channel | --brand-ink | #0F2233 | primary surface");
    expect(form.typography).toBe("body | Inter | 400 weight | Arial");
  });

  it("puts the long-tail groups in the JSON editor and omits empty ones", () => {
    const advanced = JSON.parse(recordToForm(RECORD).advancedJson);
    expect(Object.keys(advanced).sort()).toEqual(["claims", "rights"]);
    // `logoVariants: []` is nothing to read; showing it every time is noise.
    expect(advanced.logoVariants).toBeUndefined();
  });

  it("handles a null record without throwing", () => {
    const form = recordToForm(null);
    expect(form.name).toBe("");
    expect(form.advancedJson).toBe("");
  });

  it("covers every record group across the two editors, with no overlap", () => {
    const all = [...FORM_GROUPS, ...JSON_GROUPS];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([
      "applications", "claims", "colors", "governance", "logoVariants",
      "messaging", "naming", "rights", "sources", "strategy", "typography", "visual",
    ]);
  });
});

describe("[COMP:app-web/studio-brand] formToPatch", () => {
  it("round-trips the friendly groups without loss", () => {
    const result = formToPatch(recordToForm(RECORD));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.patch as Record<string, Record<string, unknown>>;
    expect(p.naming.name).toBe("Northwind Ferry");
    expect(p.naming.restrictedTerms).toEqual(["unsinkable", "cheapest"]);
    expect(p.messaging.voice).toEqual([
      { trait: "Punctual", means: "Lead with the time", avoid: "Scene-setting" },
      { trait: "Plain", means: "Use the dock word", avoid: "Jargon" },
    ]);
    expect(p.colors).toEqual([
      { name: "Deep channel", token: "--brand-ink", value: "#0F2233", role: "primary surface" },
    ]);
  });

  it("round-trips the JSON groups too", () => {
    const result = formToPatch(recordToForm(RECORD));
    if (!result.ok) throw new Error("expected ok");
    expect(result.patch.claims).toEqual([{ text: "98% on time.", status: "approved" }]);
    expect(result.patch.rights).toEqual([
      { asset: "Photos", creator: "Invented Studio", licence: "Perpetual" },
    ]);
  });

  it("never emits a group neither editor rendered", () => {
    // `naming.domains` exists on the record but has no form field. It must not
    // appear in the patch at all — the server then leaves it untouched. If it
    // appeared as `undefined` or `[]`, saving the form would wipe it.
    const result = formToPatch(recordToForm(RECORD));
    if (!result.ok) throw new Error("expected ok");
    const naming = result.patch.naming as Record<string, unknown>;
    expect("domains" in naming).toBe(false);
  });

  it("omits a blank optional field rather than sending an empty string", () => {
    const form = { ...recordToForm(RECORD), tagline: "   " };
    const result = formToPatch(form);
    if (!result.ok) throw new Error("expected ok");
    // The record schema requires non-empty strings; a blank box means "not
    // set", not "set to empty".
    expect("tagline" in (result.patch.naming as object)).toBe(false);
  });

  it("pads a short pipe-separated line instead of shifting cells", () => {
    const form = { ...recordToForm(null), name: "N", voice: "Punctual | Lead with the time" };
    const result = formToPatch(form);
    if (!result.ok) throw new Error("expected ok");
    // The missing cell becomes empty and fails server validation with a field
    // path; shifting would silently store the wrong field.
    expect((result.patch.messaging as { voice: unknown[] }).voice).toEqual([
      { trait: "Punctual", means: "Lead with the time", avoid: "" },
    ]);
  });

  it("rejects malformed JSON rather than dropping it", () => {
    const form = { ...recordToForm(null), name: "N", advancedJson: "{ not json" };
    expect(formToPatch(form)).toEqual({ ok: false, error: "advanced_json" });
  });

  it("rejects a JSON array or scalar at the top level", () => {
    const base = { ...recordToForm(null), name: "N" };
    expect(formToPatch({ ...base, advancedJson: "[]" }).ok).toBe(false);
    expect(formToPatch({ ...base, advancedJson: '"x"' }).ok).toBe(false);
  });

  it("passes an unrecognised JSON key through to the server", () => {
    const form = { ...recordToForm(null), name: "N", advancedJson: '{"designSystem":{}}' };
    const result = formToPatch(form);
    if (!result.ok) throw new Error("expected ok");
    // Dropping it here would hide the typo; the server's strict schema is the
    // authority and refuses it with a message the user can act on.
    expect(result.patch.designSystem).toEqual({});
  });
});

describe("[COMP:app-web/studio-brand] helpers", () => {
  it("toLines trims and drops blanks", () => {
    expect(toLines("  a \n\n b  \n   ")).toEqual(["a", "b"]);
  });

  it("isDirty compares every field", () => {
    const seed = recordToForm(RECORD);
    expect(isDirty(seed, seed)).toBe(false);
    expect(isDirty({ ...seed, tagline: "changed" }, seed)).toBe(true);
    expect(isDirty({ ...seed, advancedJson: "{}" }, seed)).toBe(true);
  });
});
