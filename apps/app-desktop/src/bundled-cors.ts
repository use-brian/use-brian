/** Pure policy for the file:// renderer's configured-API CORS bridge. */

export function shouldBridgeBundledCors(input: {
  bundled: boolean;
  requestUrl: string;
  apiUrl: string;
}): boolean {
  if (!input.bundled) return false;
  try {
    return new URL(input.requestUrl).origin === new URL(input.apiUrl).origin;
  } catch {
    return false;
  }
}

export function bridgeBundledCorsHeaders(
  headers: Record<string, string[]> = {},
  options: { includeCredentials?: boolean } = {},
): Record<string, string[]> {
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    const name = key.toLowerCase();
    if (
      name === "access-control-allow-origin" ||
      (options.includeCredentials !== undefined && name === "access-control-allow-credentials")
    ) delete next[key];
  }
  next["Access-Control-Allow-Origin"] = ["null"];
  if (options.includeCredentials) next["Access-Control-Allow-Credentials"] = ["true"];
  return next;
}
