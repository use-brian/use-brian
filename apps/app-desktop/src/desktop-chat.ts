/** Pure route helpers for the companion's dedicated chat window. */

const WORKSPACE_ROUTE = /^\/w\/([^/?#]+)(?:\/|$)/;

/** Extract a workspace id only from a canonical in-app workspace route. */
export function workspaceIdFromDesktopRoute(route: string): string | null {
  const match = WORKSPACE_ROUTE.exec(route);
  if (!match?.[1]) return null;
  try {
    const workspaceId = decodeURIComponent(match[1]);
    return workspaceId && !workspaceId.includes("/") ? workspaceId : null;
  } catch {
    return null;
  }
}

/** Route shared by the live Next app and bundled HashRouter build. */
export function desktopChatRoute(workspaceId: string): string {
  return `/desktop/chat/${encodeURIComponent(workspaceId)}`;
}
