/** Pure policy for the file:// renderer's configured-API CORS bridge. */

export function shouldBridgeBundledCors(input: {
  bundled: boolean;
  requestUrl: string;
  apiUrl: string;
  webContentsId?: number;
  trustedWebContentsIds: readonly number[];
}): boolean {
  if (!input.bundled || input.webContentsId === undefined) return false;
  if (!input.trustedWebContentsIds.includes(input.webContentsId)) return false;
  try {
    return new URL(input.requestUrl).origin === new URL(input.apiUrl).origin;
  } catch {
    return false;
  }
}

export function bridgeBundledCorsHeaders(
  headers: Record<string, string[]> = {},
): Record<string, string[]> {
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === "access-control-allow-origin") delete next[key];
  }
  next["Access-Control-Allow-Origin"] = ["null"];
  return next;
}
