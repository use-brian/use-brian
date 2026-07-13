/**
 * Channels rail grouping (app-web).
 * Component tag: [COMP:app-web/channel-rail-groups].
 *
 * Pure unit tests — `channel-rail-groups.ts` has no runtime imports. Covers
 * the status buckets (attention / active), the hosted-only official shared-bot
 * pseudo-row, row key shapes, and empty-group dropping.
 *
 * Spec: docs/architecture/channels/adapter-pattern.md → "Workspace channels".
 */

import { describe, expect, it } from "vitest";
import { groupChannelRail } from "../channel-rail-groups";

const chan = (id: string, status: "active" | "revoked" | "invalid") => ({
  id,
  status,
  displayName: id,
});

describe("[COMP:app-web/channel-rail-groups] Channels rail grouping", () => {
  it("buckets channels by status with attention first and official last", () => {
    const groups = groupChannelRail({
      channels: [
        chan("live", "active"),
        chan("broken", "revoked"),
        chan("bad", "invalid"),
      ],
      official: true,
    });
    expect(groups.map((g) => g.id)).toEqual(["attention", "active", "official"]);
    expect(groups[0].rows.map((r) => r.key)).toEqual(["broken", "bad"]);
    expect(groups[1].rows).toEqual([
      { kind: "channel", key: "live", channel: chan("live", "active") },
    ]);
    expect(groups[2].rows).toEqual([{ kind: "official", key: "official" }]);
  });

  it("drops empty groups so the rail never renders a bare header", () => {
    const groups = groupChannelRail({
      channels: [chan("live", "active")],
      official: false,
    });
    expect(groups.map((g) => g.id)).toEqual(["active"]);
  });

  it("omits the official pseudo-row when the surface does not apply", () => {
    expect(groupChannelRail({ channels: [], official: false })).toEqual([]);
  });

  it("shows only the official pseudo-row for a hosted workspace with no channels", () => {
    expect(groupChannelRail({ channels: [], official: true })).toEqual([
      { id: "official", rows: [{ kind: "official", key: "official" }] },
    ]);
  });
});
