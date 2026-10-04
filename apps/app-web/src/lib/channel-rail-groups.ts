/**
 * Channels rail grouping — the pure bucketing behind the Studio → Channels
 * master-detail rail (the workspace-channels operator surface).
 *
 * Groups the rail, in order:
 *   - `attention` — channels whose platform credentials are broken
 *                   (`status` = 'revoked' | 'invalid'); the bot can't answer
 *                   until it is reconnected.
 *   - `active`    — live channels.
 *   - `available` — connectable platforms the workspace has no channel of
 *                   yet, limited to the featured shortlist
 *                   (`FEATURED_AVAILABLE_CHANNEL_PLATFORMS`). The rest are
 *                   counted in `hiddenAvailable` and reached through the
 *                   rail's "More channels" button (the full connect modal).
 *
 * A platform the caller pins (the open available panel) stays in the group
 * even after its first channel lands, so a connect form showing a one-time
 * success screen (Slack webhook URL, Telegram pairing code) is not unmounted
 * under the user.
 *
 * Mirrors `ingest-rail-groups.ts` (Studio → Events) and `connector-groups.ts`
 * (Studio → Connectors, whose Available group + marketplace button this
 * follows). Empty groups are dropped so the rail only renders headers with
 * rows under them.
 *
 * Spec: docs/architecture/channels/adapter-pattern.md → "Workspace channels".
 *
 * [COMP:app-web/channel-rail-groups]
 */

export type ChannelRailGroupId = "attention" | "active" | "available";

/** The status facts the bucketing reads off a workspace channel row. */
export type RailChannelState<P extends string = string> = {
  id: string;
  channelType: P;
  status: "active" | "revoked" | "invalid";
};

/**
 * The first-connect choices kept in the default Available group, in rail
 * order. A narrow merchandising list, not a registry: every platform stays
 * reachable through the full connect modal.
 */
const FEATURED_AVAILABLE_CHANNEL_PLATFORMS = [
  "slack",
  "telegram",
  "whatsapp",
  "msteams",
] as const;

const FEATURED_ORDER = new Map<string, number>(
  FEATURED_AVAILABLE_CHANNEL_PLATFORMS.map((p, i) => [p, i]),
);

type ChannelRailRow<C, P extends string> =
  | { kind: "channel"; key: string; channel: C }
  | { kind: "available"; key: `available:${P}`; platform: P };

export type ChannelRailGroup<C, P extends string> = {
  id: ChannelRailGroupId;
  rows: ChannelRailRow<C, P>[];
};

/** Rail key of an available-platform row. */
export function availableRowKey<P extends string>(platform: P): `available:${P}` {
  return `available:${platform}`;
}

/**
 * Bucket channels and not-yet-connected platforms into the rail's groups.
 * Generic over the caller's row payload so the page's richer channel type
 * flows through untouched.
 */
export function groupChannelRail<
  P extends string,
  C extends RailChannelState<P>,
>(input: {
  channels: C[];
  /** Every platform this deployment can connect, in the caller's order. */
  platforms?: readonly P[];
  /** An available platform kept visible while its panel is open. */
  pinnedPlatform?: P | null;
}): { groups: ChannelRailGroup<C, P>[]; hiddenAvailable: P[] } {
  const channelRows = (pred: (c: C) => boolean): ChannelRailRow<C, P>[] =>
    input.channels
      .filter(pred)
      .map((c) => ({ kind: "channel" as const, key: c.id, channel: c }));

  const connected = new Set<string>(input.channels.map((c) => c.channelType));
  const pinned = input.pinnedPlatform ?? null;
  const unconnected = (input.platforms ?? []).filter(
    (p) => !connected.has(p) || p === pinned,
  );
  const featured = unconnected
    .filter((p) => FEATURED_ORDER.has(p) || p === pinned)
    .sort(
      (a, b) =>
        (FEATURED_ORDER.get(a) ?? FEATURED_ORDER.size) -
        (FEATURED_ORDER.get(b) ?? FEATURED_ORDER.size),
    );
  const hiddenAvailable = unconnected.filter((p) => !featured.includes(p));

  const groups: ChannelRailGroup<C, P>[] = [
    { id: "attention", rows: channelRows((c) => c.status !== "active") },
    { id: "active", rows: channelRows((c) => c.status === "active") },
    {
      id: "available",
      rows: featured.map((platform) => ({
        kind: "available" as const,
        key: availableRowKey(platform),
        platform,
      })),
    },
  ];
  return {
    groups: groups.filter(
      (g) =>
        g.rows.length > 0 ||
        (g.id === "available" && hiddenAvailable.length > 0),
    ),
    hiddenAvailable,
  };
}
