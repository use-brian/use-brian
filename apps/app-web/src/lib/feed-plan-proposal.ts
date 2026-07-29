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
  date: string;
  platform: FeedPlatform;
  title: string;
  brief?: string;
};

export type PlanProposal = {
  month: string;
  rationale: string;
  slots: ProposedSlot[];
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
  const slots = Array.isArray(obj.slots) ? obj.slots : null;
  if (!slots || slots.length === 0) return null;

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
    out.push({
      index,
      date,
      platform: item.platform,
      title,
      ...(typeof item.brief === "string" && item.brief.trim()
        ? { brief: item.brief.trim() }
        : {}),
    });
  }
  if (out.length === 0) return null;
  return {
    month,
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    slots: out,
  };
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
      current = {
        month: input.month,
        rationale: input.rationale || previous.rationale,
        slots: [...byIndex.values()].sort(
          (a, b) => a.date.localeCompare(b.date) || a.index - b.index,
        ),
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
