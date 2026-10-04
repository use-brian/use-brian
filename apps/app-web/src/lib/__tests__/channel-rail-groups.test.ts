/**
 * Channels rail grouping (app-web).
 * Component tag: [COMP:app-web/channel-rail-groups].
 *
 * Pure unit tests — `channel-rail-groups.ts` has no runtime imports. Covers
 * the status buckets (attention / active), the Available group (featured
 * shortlist, connected platforms dropped, the hidden remainder, the pinned
 * open panel), row key shapes, and empty-group dropping.
 *
 * Spec: docs/architecture/channels/adapter-pattern.md → "Workspace channels".
 */

import { describe, expect, it } from "vitest";
import { groupChannelRail } from "../channel-rail-groups";

type Platform =
  | "slack"
  | "telegram"
  | "discord"
  | "whatsapp"
  | "msteams"
  | "custom";

const ALL: Platform[] = [
  "slack",
  "telegram",
  "discord",
  "msteams",
  "whatsapp",
  "custom",
];

const chan = (
  id: string,
  status: "active" | "revoked" | "invalid",
  channelType: Platform = "slack",
) => ({ id, status, channelType, displayName: id });

describe("[COMP:app-web/channel-rail-groups] Channels rail grouping", () => {
  it("buckets channels by status with attention first", () => {
    const { groups } = groupChannelRail({
      channels: [
        chan("live", "active"),
        chan("broken", "revoked"),
        chan("bad", "invalid"),
      ],
    });
    expect(groups.map((g) => g.id)).toEqual(["attention", "active"]);
    expect(groups[0].rows.map((r) => r.key)).toEqual(["broken", "bad"]);
    expect(groups[1].rows).toEqual([
      { kind: "channel", key: "live", channel: chan("live", "active") },
    ]);
  });

  it("drops empty groups so the rail never renders a bare header", () => {
    const { groups } = groupChannelRail({
      channels: [chan("live", "active")],
    });
    expect(groups.map((g) => g.id)).toEqual(["active"]);
  });

  it("returns no groups for a workspace with no channels and no platforms", () => {
    expect(groupChannelRail({ channels: [] })).toEqual({
      groups: [],
      hiddenAvailable: [],
    });
  });

  it("lists the featured unconnected platforms in shortlist order and hides the rest", () => {
    const { groups, hiddenAvailable } = groupChannelRail({
      channels: [],
      platforms: ALL,
    });
    expect(groups).toEqual([
      {
        id: "available",
        rows: [
          { kind: "available", key: "available:slack", platform: "slack" },
          { kind: "available", key: "available:telegram", platform: "telegram" },
          { kind: "available", key: "available:whatsapp", platform: "whatsapp" },
          { kind: "available", key: "available:msteams", platform: "msteams" },
        ],
      },
    ]);
    expect(hiddenAvailable).toEqual(["discord", "custom"]);
  });

  it("drops a platform from Available once the workspace has a channel of it, broken or live", () => {
    const { groups, hiddenAvailable } = groupChannelRail({
      channels: [
        chan("s", "active", "slack"),
        chan("t", "revoked", "telegram"),
        chan("d", "active", "discord"),
      ],
      platforms: ALL,
    });
    const available = groups.find((g) => g.id === "available");
    expect(available?.rows.map((r) => r.key)).toEqual([
      "available:whatsapp",
      "available:msteams",
    ]);
    expect(hiddenAvailable).toEqual(["custom"]);
  });

  it("keeps the pinned platform's row while its panel is open, even after it connects", () => {
    const { groups } = groupChannelRail({
      channels: [chan("s", "active", "slack")],
      platforms: ALL,
      pinnedPlatform: "slack",
    });
    expect(groups.map((g) => g.id)).toEqual(["active", "available"]);
    expect(groups[1].rows[0]).toEqual({
      kind: "available",
      key: "available:slack",
      platform: "slack",
    });
  });

  it("keeps the Available header when only hidden platforms remain", () => {
    const { groups, hiddenAvailable } = groupChannelRail({
      channels: [
        chan("s", "active", "slack"),
        chan("t", "active", "telegram"),
        chan("w", "active", "whatsapp"),
        chan("m", "active", "msteams"),
      ],
      platforms: ALL,
    });
    expect(groups.map((g) => g.id)).toEqual(["active", "available"]);
    expect(groups[1].rows).toEqual([]);
    expect(hiddenAvailable).toEqual(["discord", "custom"]);
  });
});
