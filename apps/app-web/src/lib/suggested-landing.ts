/**
 * Suggested-for-you landing cadence.
 *
 * Home resumes the last operator app by default. The briefing interrupts that
 * resume only once per local calendar day, or after three net-new pending
 * approvals since it last rendered. State is per workspace and per device.
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

export function suggestedPath(workspaceId: string): string {
  return `/w/${workspaceId}/p?suggested=1`;
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
    ? suggestedPath(workspaceId)
    : resumePath;
}
