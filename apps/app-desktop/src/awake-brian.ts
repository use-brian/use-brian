/**
 * Persisted preference for the ambient Brian desktop companion.
 *
 * The Electron IO lives in `main.ts`; this module owns only the tolerant
 * serialization boundary so a damaged userData file can never keep the machine
 * awake unexpectedly.
 *
 * Spec: docs/plans/desktop-awake-brian.md
 * [COMP:app-desktop/awake-brian]
 */

export const AWAKE_BRIAN_FILE_NAME = "awake-brian.json";

export function parseAwakeBrianPreference(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.v === 1 && record.keepAwake === true;
  } catch {
    return false;
  }
}

export function serializeAwakeBrianPreference(keepAwake: boolean): string {
  return JSON.stringify({ v: 1, keepAwake });
}
