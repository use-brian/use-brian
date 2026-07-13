/**
 * Channels rail grouping — the pure bucketing behind the Studio → Channels
 * master-detail rail (the workspace-channels operator surface).
 *
 * Groups every workspace channel row by status, in rail order:
 *   - `attention` — channels whose platform credentials are broken
 *                   (`status` = 'revoked' | 'invalid'); the bot can't answer
 *                   until it is reconnected.
 *   - `active`    — live channels.
 *   - `official`  — the hosted-only shared WhatsApp bot pseudo-row. It is not
 *                   a `channels` row (the number is paired centrally; a
 *                   workspace only binds groups to it), so it enters as a
 *                   page-level pseudo-row when the caller says the surface
 *                   applies (hosted edition + an active workspace).
 *
 * Mirrors `ingest-rail-groups.ts` (Studio → Events) and `connector-groups.ts`
 * (Studio → Connectors). Empty groups are dropped so the rail only renders
 * headers with rows under them.
 *
 * Spec: docs/architecture/channels/adapter-pattern.md → "Workspace channels".
 *
 * [COMP:app-web/channel-rail-groups]
 */

export type ChannelRailGroupId = "attention" | "active" | "official";

/** The status facts the bucketing reads off a workspace channel row. */
export type RailChannelState = {
  id: string;
  status: "active" | "revoked" | "invalid";
};

type ChannelRailRow<C> =
  | { kind: "channel"; key: string; channel: C }
  | { kind: "official"; key: "official" };

export type ChannelRailGroup<C> = {
  id: ChannelRailGroupId;
  rows: ChannelRailRow<C>[];
};

/**
 * Bucket channels + the official shared-bot pseudo-row into the rail's status
 * groups. Generic over the caller's row payload so the page's richer channel
 * type flows through untouched.
 */
export function groupChannelRail<C extends RailChannelState>(input: {
  channels: C[];
  /** True when the official shared WhatsApp bot surface applies (hosted). */
  official: boolean;
}): ChannelRailGroup<C>[] {
  const channelRows = (pred: (c: C) => boolean): ChannelRailRow<C>[] =>
    input.channels
      .filter(pred)
      .map((c) => ({ kind: "channel" as const, key: c.id, channel: c }));

  const groups: ChannelRailGroup<C>[] = [
    { id: "attention", rows: channelRows((c) => c.status !== "active") },
    { id: "active", rows: channelRows((c) => c.status === "active") },
    {
      id: "official",
      rows: input.official ? [{ kind: "official", key: "official" }] : [],
    },
  ];
  return groups.filter((g) => g.rows.length > 0);
}
