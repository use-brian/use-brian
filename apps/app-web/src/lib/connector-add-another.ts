/**
 * Pure routing authority for the connected-card "Add another" action.
 *
 * Inline-auth and OAuth connectors must be intercepted before the directory
 * fallback: `/directory/:id/add` is only valid for remote directory entries.
 *
 * [COMP:app-web/connector-add-another]
 */

export type ConnectorAddAnotherFlow =
  | "cli-form"
  | "pat-form"
  | "imap-form"
  | "wordpress-form"
  | "oauth"
  | "directory";

const PAT_CONNECTORS = new Set(["github"]);

export function isPatConnector(id: string): boolean {
  return PAT_CONNECTORS.has(id);
}

export function resolveConnectorAddAnotherFlow(connector: {
  id: string;
  oauthRequired?: boolean;
}): ConnectorAddAnotherFlow {
  if (connector.id === "cli") return "cli-form";
  if (isPatConnector(connector.id)) return "pat-form";
  if (connector.id === "imap") return "imap-form";
  if (connector.id === "wordpress") return "wordpress-form";
  if (connector.oauthRequired) return "oauth";
  return "directory";
}
