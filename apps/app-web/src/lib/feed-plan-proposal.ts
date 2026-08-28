/**
 * Reading a `proposePlan` cardboard out of the plan conversation.
 *
 * The exact shape `draft-session-detail.tsx` uses for `proposeDrafts`: walk
 * the persisted assistant messages for `tool_use` blocks, validate each input
 * defensively (a malformed or half-streamed call must not crash the rail),
 * and upsert by index so a revision replaces the slot it revises.
 *
 * Nothing here writes. The operator accepts a proposal before any slot
 * exists, which is the whole point of D9 - a chat turn can never silently
 * rewrite a month.
 *
 * [COMP:app-web/feed-plan-proposal]
 */

import { FEED_PLATFORMS, type FeedPlatform } from "@/lib/feed-nav";

const PROPOSE_PLAN_TOOL = "proposePlan";

export type ProposedSlot = {
  index: number;
  /**
   * Set when this card fills an EXISTING empty slot (feed-revamp-depth D31).
   * Accepting then PATCHes that slot instead of creating a second one beside
   * it, which is the whole point of the opt-in fill: the operator already made
   * those slots and asked for briefs, not for duplicates.
   */
  slotId?: string;
  date: string;
  platform: FeedPlatform;
  title: string;
  brief?: string;
};

/**
 * A proposed revision of the month brief and/or cadence
 * (feed-plan-chat-first.md P11) — its own apply-or-dismiss card, same
 * accept-before-write contract as the slots.
 */
export type ProposedBriefPatch = {
  brief?: string;
  /** null clears the cadence; absent leaves it alone. */
  cadencePerWeek?: number | null;
};

export type PlanProposal = {
  month: string;
  rationale: string;
  slots: ProposedSlot[];
  briefPatch?: ProposedBriefPatch;
};

type StoredMessage = { role?: string; content?: unknown };

function isFeedPlatformValue(value: unknown): value is FeedPlatform {
  return (FEED_PLATFORMS as readonly string[]).includes(String(value));
}

/**
 * Validate an arbitrary value as a `proposePlan` input. Returns null rather
 * than throwing so a bad tool call is simply ignored by the rail.
 */
export function parseProposePlanInput(raw: unknown): PlanProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const month =
    typeof obj.month === "string" && /^\d{4}-\d{2}$/.test(obj.month)
      ? obj.month
      : null;
  if (!month) return null;
  const briefPatch = parseBriefPatch(obj.briefPatch);
  const slots = Array.isArray(obj.slots) ? obj.slots : [];
  if (slots.length === 0 && !briefPatch) return null;

  const out: ProposedSlot[] = [];
  for (const entry of slots) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const index =
      typeof item.index === "number" && Number.isInteger(item.index)
        ? item.index
        : null;
    const date =
      typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date)
        ? item.date
        : null;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (index === null || index < 1 || !date || !title) continue;
    if (!isFeedPlatformValue(item.platform)) continue;
    // A malformed slotId is dropped rather than rejecting the card: the
    // fallback (create a new slot) is safe, whereas discarding a good
    // proposal because the model fumbled one field is not.
    const slotId =
      typeof item.slotId === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.slotId)
        ? item.slotId
        : undefined;
    out.push({
      index,
      ...(slotId ? { slotId } : {}),
      date,
      platform: item.platform,
      title,
      ...(typeof item.brief === "string" && item.brief.trim()
        ? { brief: item.brief.trim() }
        : {}),
    });
  }
  if (out.length === 0 && !briefPatch) return null;
  return {
    month,
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    slots: out,
    ...(briefPatch ? { briefPatch } : {}),
  };
}

/** Validate a `briefPatch` defensively; a malformed one is simply dropped. */
function parseBriefPatch(raw: unknown): ProposedBriefPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const out: ProposedBriefPatch = {};
  if (typeof obj.brief === "string" && obj.brief.trim()) {
    out.brief = obj.brief.trim();
  }
  if (
    obj.cadencePerWeek === null ||
    (typeof obj.cadencePerWeek === "number" &&
      Number.isInteger(obj.cadencePerWeek) &&
      obj.cadencePerWeek >= 1 &&
      obj.cadencePerWeek <= 21)
  ) {
    out.cadencePerWeek = obj.cadencePerWeek as number | null;
  }
  return out.brief !== undefined || out.cadencePerWeek !== undefined
    ? out
    : null;
}

/**
 * Replay the session's history into the current proposal. Upsert by index,
 * newest rationale wins. A proposal for a different month replaces the
 * previous one wholesale rather than merging, so navigating to August never
 * shows July's leftovers.
 */
export function replayPlanProposal(
  rows: readonly StoredMessage[],
): PlanProposal | null {
  let current: PlanProposal | null = null;
  for (const row of rows) {
    if (row.role !== "assistant" || !Array.isArray(row.content)) continue;
    for (const block of row.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b.type !== "tool_use" || b.name !== PROPOSE_PLAN_TOOL) continue;
      const input = parseProposePlanInput(b.input);
      if (!input) continue;
      if (!current || current.month !== input.month) {
        current = input;
        continue;
      }
      const previous: PlanProposal = current;
      const byIndex = new Map<number, ProposedSlot>();
      for (const slot of previous.slots) byIndex.set(slot.index, slot);
      for (const slot of input.slots) byIndex.set(slot.index, slot);
      const briefPatch = input.briefPatch ?? previous.briefPatch;
      current = {
        month: input.month,
        rationale: input.rationale || previous.rationale,
        slots: [...byIndex.values()].sort(
          (a, b) => a.date.localeCompare(b.date) || a.index - b.index,
        ),
        ...(briefPatch ? { briefPatch } : {}),
      };
    }
  }
  return current;
}

/**
 * Drop proposed slots that already exist on the calendar, matched on
 * (day, platform, title). Re-running "Plan this month" should surface what is
 * missing, not offer to duplicate what the operator already accepted.
 */
export function pendingProposedSlots(
  proposal: PlanProposal | null,
  existing: readonly { scheduledFor: string; platform: string; title: string }[],
): ProposedSlot[] {
  if (!proposal) return [];
  const taken = new Set(
    existing.map(
      (s) => `${s.scheduledFor}|${s.platform}|${s.title.trim().toLowerCase()}`,
    ),
  );
  return proposal.slots.filter(
    (s) =>
      !taken.has(`${s.date}|${s.platform}|${s.title.trim().toLowerCase()}`),
  );
}

/**
 * The brief-patch card is pending only while it still differs from the
 * saved brief — applying it (or typing the same thing by hand) retires the
 * card without a dismissal, the same "already on the calendar" rule
 * `pendingProposedSlots` applies to slots.
 */
export function pendingBriefPatch(
  patch: ProposedBriefPatch | null | undefined,
  current: { brief?: string | null; cadencePerWeek?: number | null } | null,
): ProposedBriefPatch | null {
  if (!patch) return null;
  const briefDiffers =
    patch.brief !== undefined &&
    patch.brief.trim() !== (current?.brief ?? "").trim();
  const cadenceDiffers =
    patch.cadencePerWeek !== undefined &&
    patch.cadencePerWeek !== (current?.cadencePerWeek ?? null);
  if (!briefDiffers && !cadenceDiffers) return null;
  return {
    ...(briefDiffers ? { brief: patch.brief } : {}),
    ...(cadenceDiffers ? { cadencePerWeek: patch.cadencePerWeek } : {}),
  };
}
