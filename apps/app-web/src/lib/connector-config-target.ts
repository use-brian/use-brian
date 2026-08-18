/**
 * Where a connector row's `connector_instance.config` is read and written.
 *
 * A workspace-owned row (`readonly && source === 'team_native'` — what Transfer
 * produces) has `user_id = NULL`, so the provider-keyed
 * `/api/connectors/:provider/config` pair resolves through the legacy
 * `mcp_connectors` shim keyed by `(userId, provider)` and finds NOTHING for it.
 * An editor pointed at that route renders, appears to save, and changes
 * nothing — a worse failure than the missing editor it replaced. Those rows go
 * to the instance-scoped pair instead, which runs under RLS where the
 * `ci_workspace_member` policy already admits any member of the owning
 * workspace.
 *
 * The cache key follows the same split, so a personal and a workspace-owned
 * instance of one provider never share an entry.
 *
 * A `granted` row is deliberately NOT included: that is a teammate's personal
 * connector exposed for use, and reconfiguring it stays the owner's job from
 * their own panel.
 *
 * Spec: docs/architecture/integrations/connector-configuration.md → "The rules".
 */

export type ConfigTarget = {
  /** Cache key for the page's `configMap`. */
  key: string;
  /** Path segment under `/api/connectors/` that carries the config pair. */
  path: string;
};

export type ConfigTargetRow = {
  /** Provider slug, or the generated UUID a custom MCP uses as its provider. */
  id: string;
  connectorInstanceId?: string;
  readonly?: boolean;
  source?: "granted" | "team_native";
};

export function configTarget(row: ConfigTargetRow): ConfigTarget {
  return row.readonly && row.source === "team_native" && row.connectorInstanceId
    ? { key: row.connectorInstanceId, path: `instances/${row.connectorInstanceId}` }
    : { key: row.id, path: row.id };
}
