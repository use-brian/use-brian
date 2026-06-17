/**
 * Studio navigation definition (app-web).
 * Component tag: [COMP:app-web/studio-nav].
 *
 * Pure unit tests over `studio-nav.ts`: the three-group IA shape (Ingest /
 * Consume / Develop — docs/architecture/features/studio.md → IA) and the
 * `studioSectionFromPathname` resolver the `StudioTopbar` breadcrumb uses.
 */

import { describe, expect, it } from "vitest";
import { STUDIO_GROUPS, studioSectionFromPathname } from "../studio-nav";

describe("[COMP:app-web/studio-nav] Studio navigation", () => {
  it("defines the three-group IA: Ingest / Consume / Develop", () => {
    expect(STUDIO_GROUPS.map((g) => g.key)).toEqual([
      "ingest",
      "consume",
      "develop",
    ]);
    expect(STUDIO_GROUPS.map((g) => g.sections.map((s) => s.segment))).toEqual([
      ["connectors", "ingest-rules", "knowledge"],
      ["assistants", "channels", "mini-apps"],
      ["programmatic-access"],
    ]);
  });

  it("resolves every section segment from its route", () => {
    for (const group of STUDIO_GROUPS) {
      for (const section of group.sections) {
        expect(
          studioSectionFromPathname(`/w/ws-1/studio/${section.segment}`),
        ).toBe(section.key);
      }
    }
  });

  it("resolves sub-routes and query/hash-bearing paths to their section", () => {
    expect(
      studioSectionFromPathname("/w/ws-1/studio/assistants?assistant=a1"),
    ).toBe("assistants");
    expect(studioSectionFromPathname("/w/ws-1/studio/connectors#tools")).toBe(
      "connectors",
    );
    expect(
      studioSectionFromPathname("/w/ws-1/studio/programmatic-access/extra"),
    ).toBe("programmaticAccess");
  });

  it("returns null for the studio root and unknown segments", () => {
    expect(studioSectionFromPathname("/w/ws-1/studio")).toBeNull();
    expect(studioSectionFromPathname("/w/ws-1/studio/")).toBeNull();
    expect(studioSectionFromPathname("/w/ws-1/studio/unknown")).toBeNull();
    expect(studioSectionFromPathname("/w/ws-1/brain")).toBeNull();
  });
});
