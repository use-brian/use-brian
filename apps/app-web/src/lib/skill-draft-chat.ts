/**
 * Pure helpers for the skill iteration chat (`skill-iteration-chat.tsx`) —
 * the transcript model and its wire mapping for `POST /api/skills/draft`.
 *
 * The endpoint is STATELESS: the client resends the whole conversation plus
 * the live document every turn, so the clamping/trimming rules live here as
 * plain functions (unit-tested without a DOM) instead of inside the
 * component. Caps mirror the server's zod schema
 * (`packages/api/src/routes/skills.ts` → `draftBodySchema`) so a turn never
 * 400s on a limit the client could have applied itself.
 *
 * [COMP:app-web/skill-draft-chat]
 */

import type { SkillDraft } from "@/lib/api/skills";

export type SkillChatRole = "user" | "assistant";

/** One transcript entry as the chat rail renders it. */
export type SkillChatTurn = {
  /** Stable client id — the render key. */
  id: string;
  role: SkillChatRole;
  content: string;
  /** The send failed — rendered with error styling and EXCLUDED from the
   *  wire so a retried conversation never replays a half-turn. */
  failed?: boolean;
};

/** Server caps (draftBodySchema) — change together with the route. */
export const SKILL_CHAT_TURN_MAX_CHARS = 4000;
export const SKILL_CHAT_WIRE_MAX_MESSAGES = 24;

/** Wire caps for the live document (`currentDraft` in draftBodySchema) —
 *  lenient vs the save caps so an over-limit document can still be sent to
 *  the agent to shorten. */
const DRAFT_WIRE_CAPS = {
  name: 120,
  description: 300,
  whenToUse: 1000,
  content: 6000,
} as const;

/**
 * Transcript → wire messages: drop failed sends and empties, clamp each turn
 * to the server's per-message cap, keep the freshest window. The server
 * additionally trims by characters; this keeps the request comfortably
 * inside the schema.
 */
export function toWireMessages(
  transcript: ReadonlyArray<SkillChatTurn>,
): Array<{ role: SkillChatRole; content: string }> {
  return transcript
    .filter((t) => !t.failed && t.content.trim().length > 0)
    .map((t) => ({
      role: t.role,
      content: t.content.trim().slice(0, SKILL_CHAT_TURN_MAX_CHARS),
    }))
    .slice(-SKILL_CHAT_WIRE_MAX_MESSAGES);
}

/** Clamp the live document to the wire caps (a hand-paste past a cap must
 *  not 400 the whole turn — the agent can be asked to shorten it). */
export function clampDraftForWire(draft: SkillDraft): SkillDraft {
  return {
    name: draft.name.slice(0, DRAFT_WIRE_CAPS.name),
    description: draft.description.slice(0, DRAFT_WIRE_CAPS.description),
    whenToUse: draft.whenToUse.slice(0, DRAFT_WIRE_CAPS.whenToUse),
    content: draft.content.slice(0, DRAFT_WIRE_CAPS.content),
    sensitivity: draft.sensitivity,
  };
}

/** Whether the document has anything worth sending as `currentDraft`. */
export function draftHasContent(draft: SkillDraft): boolean {
  return (
    draft.name.trim().length > 0 ||
    draft.description.trim().length > 0 ||
    draft.whenToUse.trim().length > 0 ||
    draft.content.trim().length > 0
  );
}
