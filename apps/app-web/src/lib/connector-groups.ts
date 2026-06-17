/**
 * Connector rail grouping — the pure bucketing behind the Studio →
 * Connectors master-detail rail.
 *
 * Groups every connector row by sharing state:
 *   - `shared`    — connected instances exposed (a connector_grant) to the
 *                   active *shared* workspace.
 *   - `personal`  — connected instances visible only to the member's own
 *                   assistants.
 *   - `available` — everything not connected: never-connected built-in
 *                   placeholders, disconnected instances, unprobed custom
 *                   servers.
 *   - `builtin`   — first-party workspace primitives (registry entries with
 *                   `auth_type: 'none'`, e.g. Workspace Files). Always-on:
 *                   their tools are capability-gated at runtime, so they
 *                   have no meaningful connected/disconnected state and
 *                   bucket here regardless of the row's `connected` flag.
 *
 * In a SOLO workspace the personal/workspace distinction collapses — the
 * caller renders `personal` under a "Connected" header and `shared` stays
 * empty (grants are never minted without an audience).
 *
 * Spec: docs/architecture/integrations/mcp.md → "Unified connectors — the
 * master-detail Studio surface".
 *
 * [COMP:app-web/connector-groups]
 */

export type ConnectorGroupId = "shared" | "personal" | "available" | "builtin";

export type GroupableConnector = {
  /** Provider slug — matches the registry id (e.g. "files"). */
  id?: string;
  /** The connector_instance UUID — absent for never-connected placeholders. */
  connectorInstanceId?: string;
  connected: boolean;
  /** Custom MCP servers never bucket as builtin even on a slug collision. */
  custom?: boolean;
};

export function groupConnectors<C extends GroupableConnector>(
  connectors: readonly C[],
  opts: {
    /** True when the active workspace has more than one member. */
    sharedWorkspace: boolean;
    /** connectorInstanceId → grantId for the active workspace. */
    exposedGrants: Record<string, string>;
    /** Provider slugs of built-in primitives (BUILTIN_PRIMITIVE_CONNECTOR_IDS). */
    builtinIds?: ReadonlySet<string>;
  },
): { shared: C[]; personal: C[]; available: C[]; builtin: C[] } {
  const shared: C[] = [];
  const personal: C[] = [];
  const available: C[] = [];
  const builtin: C[] = [];
  for (const c of connectors) {
    if (c.id && !c.custom && opts.builtinIds?.has(c.id)) {
      builtin.push(c);
    } else if (!c.connected) {
      available.push(c);
    } else if (
      opts.sharedWorkspace &&
      c.connectorInstanceId &&
      opts.exposedGrants[c.connectorInstanceId]
    ) {
      shared.push(c);
    } else {
      personal.push(c);
    }
  }
  return { shared, personal, available, builtin };
}
