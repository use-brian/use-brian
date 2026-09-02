/**
 * Deep-link resolution — map a `usebrian://` URL to a canvas URL to load.
 *
 * Pure: `resolveDeepLink` takes the raw URL + config and returns an absolute
 * URL string, or `null` when the link does not parse, is not our scheme, or
 * fails the same-origin path guard. Unit-tests with no Electron.
 *
 * Supported links:
 *   usebrian://open?path=/w/<ws>/p/<page>  -> ${appUrl}/w/<ws>/p/<page>
 *   usebrian://capture                      -> quickCaptureUrl(appUrl)
 *   usebrian://record                       -> recordTargetUrl(appUrl)
 *   usebrian://ask?prompt=<text>            -> handled by the Siri bridge
 *
 * Spec: docs/architecture/features/app-desktop.md → "deep-link.ts"
 * [COMP:app-desktop/deep-link]
 */

import { quickCaptureUrl, recordTargetUrl } from "./quick-capture.js";

interface DeepLinkConfig {
  readonly appUrl: string;
  readonly protocolScheme: string;
}

export const MAX_SIRI_PROMPT_LENGTH = 8_000;

/** Return a bounded Siri prompt only from the dedicated `ask` deep link. */
export function parseAskBrianDeepLink(
  rawUrl: string,
  protocolScheme: string,
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${protocolScheme}:` || url.hostname !== "ask")
    return null;
  const prompt = url.searchParams.get("prompt")?.trim();
  if (!prompt || prompt.length > MAX_SIRI_PROMPT_LENGTH) return null;
  return prompt;
}

/**
 * Resolve a `usebrian://` deep link to an absolute canvas URL.
 *
 * Returns `null` for anything that does not parse, is not our scheme, or whose
 * `path` would leave the canvas origin. The `path` query param **must start
 * with `/`** — this refuses protocol-relative (`//evil.com`) and absolute
 * external targets, so a crafted link can never navigate the app off-origin.
 */
export function resolveDeepLink(rawUrl: string, cfg: DeepLinkConfig): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== `${cfg.protocolScheme}:`) return null;

  const command = url.hostname;

  if (command === "capture") {
    return quickCaptureUrl(cfg.appUrl);
  }

  if (command === "record") {
    return recordTargetUrl(cfg.appUrl);
  }

  if (command === "open") {
    const path = url.searchParams.get("path") ?? "/";
    // Same-origin guard: must be an absolute in-app path, never `//host` or a
    // full external URL.
    if (!path.startsWith("/") || path.startsWith("//")) return null;
    return `${cfg.appUrl}${path}`;
  }

  return null;
}
