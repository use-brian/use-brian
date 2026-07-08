/**
 * Events rail grouping — the pure bucketing behind the Studio → Events
 * master-detail rail (the ingest control plane).
 *
 * Groups every ingest source row by status, in rail order:
 *   - `attention` — instances whose connection is broken (creds missing or
 *                   revoked); ingestion can't run until a reconnect.
 *   - `ingesting` — connected instances with `ingestion_enabled` on.
 *   - `off`       — connected instances not ingesting (the opt-in default).
 *   - `available` — ingest-capable providers the workspace hasn't connected.
 *
 * WhatsApp (BYO number) is a bespoke page-level source — it has no row in the
 * generic `GET /api/ingest/sources` list, so it enters as a pseudo-row bucketed
 * by its own pairing + enabled-group state: disconnected device → `attention`,
 * ≥1 enabled group → `ingesting`, else `off`. It is prepended to its bucket
 * (it led the stacked-card layout this rail replaces). `null` whatsapp state
 * (never paired, or still loading) contributes no row.
 *
 * Mirrors `connector-groups.ts` for Studio → Connectors. Empty groups are
 * dropped so the rail only renders headers with rows under them.
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md → "Ingestion control
 * plane".
 *
 * [COMP:app-web/ingest-rail-groups]
 */

export type IngestRailGroupId = "attention" | "ingesting" | "off" | "available";

/** The connection/enablement facts the bucketing reads off a generic source. */
export type RailSourceState = {
  instanceId: string;
  connected: boolean;
  ingestionEnabled: boolean;
};

/** WhatsApp's page-level status; pass null when never paired / still loading. */
export type RailWhatsappState = {
  connected: boolean;
  enabledGroups: number;
};

type IngestRailRow<S, A> =
  | { kind: "source"; key: string; source: S }
  | { kind: "whatsapp"; key: "whatsapp" }
  | { kind: "available"; key: string; provider: A };

export type IngestRailGroup<S, A> = {
  id: IngestRailGroupId;
  rows: IngestRailRow<S, A>[];
};

/**
 * Bucket sources + the WhatsApp pseudo-row + available providers into the
 * rail's status groups. Generic over the caller's row payloads so the page's
 * richer types flow through untouched.
 */
export function groupIngestRail<
  S extends RailSourceState,
  A extends { provider: string },
>(input: {
  sources: S[];
  available: A[];
  whatsapp: RailWhatsappState | null;
}): IngestRailGroup<S, A>[] {
  const waRow: IngestRailRow<S, A> = { kind: "whatsapp", key: "whatsapp" };
  const wa = input.whatsapp;
  const waGroup: IngestRailGroupId | null =
    wa === null
      ? null
      : !wa.connected
        ? "attention"
        : wa.enabledGroups > 0
          ? "ingesting"
          : "off";

  const sourceRows = (pred: (s: S) => boolean): IngestRailRow<S, A>[] =>
    input.sources
      .filter(pred)
      .map((s) => ({ kind: "source" as const, key: s.instanceId, source: s }));

  const withWa = (
    id: IngestRailGroupId,
    rows: IngestRailRow<S, A>[],
  ): IngestRailGroup<S, A> => ({
    id,
    rows: waGroup === id ? [waRow, ...rows] : rows,
  });

  const groups: IngestRailGroup<S, A>[] = [
    withWa("attention", sourceRows((s) => !s.connected)),
    withWa("ingesting", sourceRows((s) => s.connected && s.ingestionEnabled)),
    withWa("off", sourceRows((s) => s.connected && !s.ingestionEnabled)),
    {
      id: "available",
      rows: input.available.map((a) => ({
        kind: "available" as const,
        key: `available:${a.provider}`,
        provider: a,
      })),
    },
  ];
  return groups.filter((g) => g.rows.length > 0);
}
