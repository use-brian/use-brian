/** Pure route helpers for the companion's dedicated chat window. */

const WORKSPACE_ROUTE = /^\/w\/([^/?#]+)(?:\/|$)/;

export const COMPANION_PHASES = [
  "idle",
  "loading",
  "thinking",
  "responding",
  "action-required",
] as const;

export type CompanionPhase = (typeof COMPANION_PHASES)[number];
export type CompanionState = { phase: CompanionPhase; label?: string };
export type NativeUseBrianTarget = "main" | "nearby" | "nearby-pending";

/** Select the one renderer that owns a native Use Brian invocation. */
export function nativeUseBrianTarget(
  brianNearby: boolean,
  workspaceId: string | null,
): NativeUseBrianTarget {
  if (!brianNearby) return "main";
  return workspaceId ? "nearby" : "nearby-pending";
}

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
export function desktopChatRoute(workspaceId: string, assistantId?: string): string {
  const route = `/desktop/chat/${encodeURIComponent(workspaceId)}`;
  return assistantId ? `${route}?assistant=${encodeURIComponent(assistantId)}` : route;
}

/** A companion click immediately following panel blur is the outside click itself. */
export function companionClickFollowsChatBlur(
  nowMs: number,
  blurredAtMs: number,
  windowMs = 400,
): boolean {
  return blurredAtMs > 0 && nowMs >= blurredAtMs && nowMs - blurredAtMs <= windowMs;
}

/** Accept only the small display-only state surface sent by the chat renderer. */
export function parseCompanionState(value: unknown): CompanionState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { phase?: unknown; label?: unknown };
  if (
    typeof candidate.phase !== "string" ||
    !COMPANION_PHASES.includes(candidate.phase as CompanionPhase)
  ) {
    return null;
  }
  const label =
    typeof candidate.label === "string"
      ? candidate.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120)
      : "";
  return { phase: candidate.phase as CompanionPhase, ...(label ? { label } : {}) };
}
