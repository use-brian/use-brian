// Synthetic, read-only transport boundary for production route-body captures.
// Never included by the product build. No real token or network request is used.
import { authFetch as workflowFetch, fixture } from "../../../apps/app-web/scripts/fixtures/workflow-page-browser-transport";
// The older browser fixture's event payload predates the current event-source
// schema. Use a valid manual trigger for this visual audit, not an invalid event.
fixture.workflow.trigger = { kind: "manual" };
export { getAccessToken, getValidAccessToken, isAuthRedirectInFlight, refreshUserCookie, AuthRefreshUnavailableError } from "../../../apps/app-web/scripts/fixtures/workflow-page-browser-transport";
export const requests: string[] = [];
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const path = new URL(url, location.origin).pathname;
  const method = init.method ?? "GET";
  requests.push(`${method} ${path}`);
  if (method !== "GET") throw new Error(`Audit blocks mutations: ${method} ${path}`);
  if (path === "/api/apps/shopify/tools") return Response.json({ connected: true, tools: [] });
  return workflowFetch(url, init);
}
// OperatorTopbar only consumes collapsed state. The workspace sidebar is not
// mounted: these are complete route-body captures, NOT full workspace sessions.
export const useSidebarData = () => ({ sidebarCollapsed: true });
