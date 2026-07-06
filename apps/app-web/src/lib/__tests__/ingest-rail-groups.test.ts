/**
 * Events rail grouping (app-web).
 * Component tag: [COMP:app-web/ingest-rail-groups].
 *
 * Pure unit tests — `ingest-rail-groups.ts` has no runtime imports. Covers the
 * four status buckets (attention / ingesting / off / available), the WhatsApp
 * pseudo-row's bucketing (disconnected → attention, enabled groups →
 * ingesting, connected-idle → off, null → absent) and its prepend position,
 * row key shapes, and empty-group dropping.
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md → "Ingestion control
 * plane".
 */

import { describe, expect, it } from "vitest";
import { groupIngestRail } from "../ingest-rail-groups";

const src = (
  instanceId: string,
  connected: boolean,
  ingestionEnabled: boolean,
) => ({ instanceId, connected, ingestionEnabled, label: instanceId });

describe("[COMP:app-web/ingest-rail-groups] Events rail grouping", () => {
  it("buckets sources by status and available providers last", () => {
    const groups = groupIngestRail({
      sources: [
        src("broken", false, true),
        src("live", true, true),
        src("idle", true, false),
      ],
      available: [{ provider: "fathom", name: "Fathom" }],
      whatsapp: null,
    });
    expect(groups.map((g) => g.id)).toEqual([
      "attention",
      "ingesting",
      "off",
      "available",
    ]);
    expect(groups[0].rows).toEqual([
      { kind: "source", key: "broken", source: src("broken", false, true) },
    ]);
    expect(groups[1].rows[0].key).toBe("live");
    expect(groups[2].rows[0].key).toBe("idle");
    expect(groups[3].rows).toEqual([
      {
        kind: "available",
        key: "available:fathom",
        provider: { provider: "fathom", name: "Fathom" },
      },
    ]);
  });

  it("drops empty groups so the rail never renders a bare header", () => {
    const groups = groupIngestRail({
      sources: [src("live", true, true)],
      available: [],
      whatsapp: null,
    });
    expect(groups.map((g) => g.id)).toEqual(["ingesting"]);
  });

  it("returns no groups when there is nothing to show", () => {
    expect(
      groupIngestRail({ sources: [], available: [], whatsapp: null }),
    ).toEqual([]);
  });

  it("buckets a disconnected WhatsApp device under attention", () => {
    const groups = groupIngestRail({
      sources: [],
      available: [],
      whatsapp: { connected: false, enabledGroups: 3 },
    });
    expect(groups).toEqual([
      { id: "attention", rows: [{ kind: "whatsapp", key: "whatsapp" }] },
    ]);
  });

  it("buckets WhatsApp by enabled groups: ≥1 → ingesting, 0 → off", () => {
    const ingesting = groupIngestRail({
      sources: [],
      available: [],
      whatsapp: { connected: true, enabledGroups: 2 },
    });
    expect(ingesting[0].id).toBe("ingesting");

    const off = groupIngestRail({
      sources: [],
      available: [],
      whatsapp: { connected: true, enabledGroups: 0 },
    });
    expect(off[0].id).toBe("off");
  });

  it("prepends the WhatsApp row to its bucket, ahead of generic sources", () => {
    const groups = groupIngestRail({
      sources: [src("live", true, true)],
      available: [],
      whatsapp: { connected: true, enabledGroups: 1 },
    });
    expect(groups[0].rows.map((r) => r.key)).toEqual(["whatsapp", "live"]);
  });
});
