/** Account-scoped source notices. Default routing is an account preference,
 * never a workspace type. Explicit targets take precedence in the API.
 * [COMP:app-web/studio-ingest]
 */
export type IngestSourceNotice = {
  /** Show "on / off applies across all your workspaces". */
  globalToggle: boolean;
  /** Show "review this source’s routing before enabling it here" + add-source CTA. */
  routesElsewhere: boolean;
};

export function ingestSourceNotice(
  scope: "user" | "workspace",
  activeIsOwnedDefault: boolean | undefined,
): IngestSourceNotice {
  if (scope !== "user") {
    return { globalToggle: false, routesElsewhere: false };
  }
  return { globalToggle: true, routesElsewhere: activeIsOwnedDefault === false };
}
