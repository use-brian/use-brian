/**
 * Home landing cadence, now pointing at the Chat work entry.
 *
 * Home resumes the last operator app by default. The work entry interrupts
 * that resume only once per local calendar day, or after three net-new pending
 * approvals since it last rendered. State is per workspace and per device.
 * The retired `/p?suggested=1` briefing transitions to the same destination
 * (doc-shell; home-dock.md -> "Chat-first transition").
 *
 * [COMP:app-web/home-suggested]
 */

const SUGGESTED_APPROVAL_INCREMENT = 3;

export type SuggestedLandingState = {
  shownDay: string;
  approvalWatermark: number;
};

function suggestedLandingStorageKey(workspaceId: string): string {
  return `doc:suggested-landing:${workspaceId}`;
}

/** Local-day key, intentionally derived in the viewer's timezone. */
export function localDayKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shouldAutoOpenSuggested(
  previous: SuggestedLandingState | null,
  approvalCount: number,
  now: Date,
): boolean {
  if (!previous || previous.shownDay !== localDayKey(now)) return true;
  return (
    Math.max(0, approvalCount) >=
    Math.max(0, previous.approvalWatermark) + SUGGESTED_APPROVAL_INCREMENT
  );
}

export function readSuggestedLanding(
  workspaceId: string,
): SuggestedLandingState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(
      suggestedLandingStorageKey(workspaceId),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SuggestedLandingState>;
    if (
      typeof parsed.shownDay !== "string" ||
      !Number.isFinite(parsed.approvalWatermark)
    ) {
      return null;
    }
    return {
      shownDay: parsed.shownDay,
      approvalWatermark: Math.max(0, Number(parsed.approvalWatermark)),
    };
  } catch {
    return null;
  }
}

/** Record a briefing that actually rendered (automatic or manual). */
export function markSuggestedShown(
  workspaceId: string,
  approvalCount: number,
  now: Date = new Date(),
): void {
  if (typeof window === "undefined") return;
  const state: SuggestedLandingState = {
    shownDay: localDayKey(now),
    approvalWatermark: Math.max(0, Math.trunc(approvalCount)),
  };
  try {
    window.localStorage.setItem(
      suggestedLandingStorageKey(workspaceId),
      JSON.stringify(state),
    );
  } catch {
    // Non-fatal: the next Home visit may show the briefing again.
  }
}

/** The Chat work entry: Chat is the working entry point (chat-app.md -> "Work entry"). */
export function workEntryPath(workspaceId: string): string {
  return `/w/${workspaceId}/chat`;
}

/**
 * Where a retired `?suggested=1` URL goes (home-dock.md -> "Chat-first
 * transition"): a URL that addresses a Page keeps that Page and only drops the
 * flag (every other parameter survives); a bare briefing URL becomes the Chat
 * work entry. Null when the URL carries no flag, so nothing else is touched.
 */
export function suggestedTransitionTarget(input: {
  workspaceId: string;
  pathname: string;
  search: string;
  pageAddressed: boolean;
}): string | null {
  const params = new URLSearchParams(input.search);
  if (params.get("suggested") !== "1") return null;
  if (!input.pageAddressed) return workEntryPath(input.workspaceId);
  params.delete("suggested");
  const query = params.toString();
  return query ? `${input.pathname}?${query}` : input.pathname;
}

/** Apply the shared cadence to a resolved operator-app resume destination. */
export function homeLandingPath(
  workspaceId: string,
  resumePath: string,
  approvalCount: number,
  now: Date = new Date(),
): string {
  return shouldAutoOpenSuggested(
    readSuggestedLanding(workspaceId),
    approvalCount,
    now,
  )
    ? workEntryPath(workspaceId)
    : resumePath;
}
