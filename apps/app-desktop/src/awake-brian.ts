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
export const BRIAN_POSITION_FILE_NAME = "brian-position.json";

export type BrianPosition = { x: number; y: number };

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

export function parseBrianPosition(raw: string | null | undefined): BrianPosition | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { v?: unknown; x?: unknown; y?: unknown };
    if (
      value?.v !== 1 ||
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y)
    ) {
      return null;
    }
    return { x: Math.round(value.x), y: Math.round(value.y) };
  } catch {
    return null;
  }
}

export function serializeBrianPosition(position: BrianPosition): string {
  return JSON.stringify({ v: 1, x: Math.round(position.x), y: Math.round(position.y) });
}

export function clampBrianPosition(
  position: BrianPosition,
  area: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): BrianPosition {
  return {
    x: Math.max(area.x, Math.min(area.x + area.width - size.width, position.x)),
    y: Math.max(area.y, Math.min(area.y + area.height - size.height, position.y)),
  };
}
