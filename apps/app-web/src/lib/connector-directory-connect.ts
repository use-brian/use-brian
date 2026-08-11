/**
 * Pure resolver for the row the Directory hands to the page's connect flow.
 *
 * The Directory modal knows a connector only by its slug, but the page keys
 * every inline connect form on `rowId` = `connectorInstanceId ?? id`. Passing a
 * synthetic `{ id }` therefore produces the SLUG while the rail row produces
 * the instance UUID, and each `showXForm === rid` comparison downstream misses
 * - the form cannot render at all, so the Connect button reads as dead. A
 * disconnected connector keeps its instance row, which is exactly when the two
 * ids diverge and exactly when a user reaches for the Directory.
 *
 * [COMP:app-web/connector-directory-connect]
 */

export type DirectoryConnectRow = { id: string; connectorInstanceId?: string };

/**
 * The live row for `entryId`, or a slug-only stand-in when the workspace has
 * never had that connector (no instance exists, so the slug IS its row id).
 * Prefers a row that still carries an instance id, since that is the one whose
 * `rowId` the rail renders.
 */
export function resolveDirectoryConnectRow<T extends DirectoryConnectRow>(
  connectors: readonly T[],
  entryId: string,
): T | DirectoryConnectRow {
  const matches = connectors.filter((connector) => connector.id === entryId);
  return matches.find((connector) => !!connector.connectorInstanceId) ?? matches[0] ?? { id: entryId };
}
