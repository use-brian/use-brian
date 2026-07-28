/**
 * Pure policy for the Electron display-media handler.
 *
 * The handler grants a primary-display video stream only because Chromium's
 * getDisplayMedia contract requires one; app-web drops that track immediately
 * and keeps the loopback audio. Keeping trust + source selection here makes the
 * security boundary unit-testable without booting Electron.
 *
 * [COMP:app-desktop/system-audio]
 */

export type DisplaySource = {
  display_id: string;
};

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isTrustedCaptureOrigin(
  securityOrigin: string,
  appOrigin: string,
  allowBundledFile: boolean,
): boolean {
  if (allowBundledFile && securityOrigin === "file://") return true;
  const requested = normalizedOrigin(securityOrigin);
  const expected = normalizedOrigin(appOrigin);
  return requested !== null && expected !== null && requested === expected;
}

export function selectPrimaryDisplaySource<T extends DisplaySource>(
  sources: readonly T[],
  primaryDisplayId: string | number,
): T | undefined {
  return sources.find((source) => source.display_id === String(primaryDisplayId)) ?? sources[0];
}

