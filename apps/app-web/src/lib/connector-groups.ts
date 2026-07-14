/**
 * Connector rail grouping — the pure bucketing behind the Studio →
 * Connectors master-detail rail.
 *
 * Groups every connector row by sharing state:
 *   - `shared`    — connected instances exposed (a connector_grant) to the
 *                   active workspace.
 *   - `personal`  — connected instances visible only to the member's own
 *                   assistants.
 *   - `available` — everything not connected: never-connected built-in
 *                   placeholders, disconnected instances, unprobed custom
 *                   servers.
 *   - `workspace`  — read-only connectors available to the member in this
 *                   workspace but NOT owned by them (a teammate exposed them,
 *                   or a legacy team-native instance), already clearance-
 *                   filtered server-side. Bucketed FIRST on the `readonly`
 *                   flag, so they never mix into the manageable groups.
 *   - `builtin`   — first-party workspace primitives (registry entries with
 *                   `auth_type: 'none'`, e.g. Workspace Files). Always-on:
 *                   their tools are capability-gated at runtime, so they
 *                   have no meaningful connected/disconnected state and
 *                   bucket here regardless of the row's `connected` flag.
 *
 * The buckets are the same in EVERY workspace, solo included: exposure gates
 * runtime injection and the config pickers alike (the solo auto-load default
 * was removed 2026-07-14), so a connected-but-unexposed connector is
 * `personal` even when the member is the workspace's only member.
 *
 * Spec: docs/architecture/integrations/mcp.md → "Unified connectors — the
 * master-detail Studio surface".
 *
 * [COMP:app-web/connector-groups]
 */

export type GroupableConnector = {
  /** Provider slug — matches the registry id (e.g. "files"). */
  id?: string;
  /** The connector_instance UUID — absent for never-connected placeholders. */
  connectorInstanceId?: string;
  connected: boolean;
  /** Custom MCP servers never bucket as builtin even on a slug collision. */
  custom?: boolean;
  /**
   * Read-only workspace-shared row (a teammate's or a legacy team-native
   * connector available to the member). Buckets to `workspace` first — these
   * are never owned by the member, so the manageable groups must not claim them.
   */
  readonly?: boolean;
};

export function groupConnectors<C extends GroupableConnector>(
  connectors: readonly C[],
  opts: {
    /** connectorInstanceId → grantId for the active workspace. */
    exposedGrants: Record<string, string>;
    /** Provider slugs of built-in primitives (BUILTIN_PRIMITIVE_CONNECTOR_IDS). */
    builtinIds?: ReadonlySet<string>;
  },
): { shared: C[]; personal: C[]; available: C[]; workspace: C[]; builtin: C[] } {
  const shared: C[] = [];
  const personal: C[] = [];
  const available: C[] = [];
  const workspace: C[] = [];
  const builtin: C[] = [];
  for (const c of connectors) {
    if (c.readonly) {
      // Read-only workspace-shared rows are never the member's to manage —
      // bucket them out before any owned-connector classification.
      workspace.push(c);
    } else if (c.id && !c.custom && opts.builtinIds?.has(c.id)) {
      builtin.push(c);
    } else if (!c.connected) {
      available.push(c);
    } else if (
      c.connectorInstanceId &&
      opts.exposedGrants[c.connectorInstanceId]
    ) {
      shared.push(c);
    } else {
      personal.push(c);
    }
  }
  return { shared, personal, available, workspace, builtin };
}
