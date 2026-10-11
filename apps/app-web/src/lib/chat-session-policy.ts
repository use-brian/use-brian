/**
 * The Chat app's one source of "how does this conversation behave".
 *
 * A personal chat is a room with one human (chat-parity D1): every surface a
 * room has, a personal chat has too, and what still differs is answered by
 * the server's policy flags (T1, `clientSessionPolicy` in
 * `packages/api/src/session-kind.ts`), never by which list a row came from or
 * by the `?v=` view. The view only chooses where a NEW conversation is
 * created and which rail lists it.
 *
 * Spec: docs/architecture/features/chat-app.md -> "Personal = room with one
 * human". Plan: docs/plans/chat-parity-and-side-pane.md section 3.
 *
 * [COMP:app-web/chat-session-policy]
 */

export type ChatSessionPolicy = {
  /** Must a message address the assistant to run a turn (D2)? */
  addressing: "mention" | "every_message";
  /** Several assistants may answer: `@` mentions and names in reply headers. */
  multiVoice: boolean;
  /** The Work Bench pins context to this conversation. */
  pins: boolean;
  /** The composer may hand a message to the running turn (D3). */
  queue: boolean;
  /** Free posting: silent posts, post edits, typing, a shared rebind, human `@`s. */
  post: boolean;
  /** A whole-life follow stream with a presence roster; else per-turn reconnect. */
  presence: boolean;
};

/** A personal chat: a room with one human whose audience stays personal. */
export const PERSONAL_CHAT_POLICY: ChatSessionPolicy = {
  addressing: "every_message",
  multiVoice: true,
  pins: true,
  queue: true,
  post: false,
  presence: false,
};

/**
 * A pane with no conversation yet. Whatever the first send creates (a
 * personal chat or a room) has exactly one human then, so both behave alike:
 * every message is addressed and nothing can be posted until it exists.
 */
export const FRESH_PANE_POLICY: ChatSessionPolicy = {
  ...PERSONAL_CHAT_POLICY,
  pins: false,
};

/**
 * An open conversation whose policy has not arrived yet (a deep link before
 * the lists or the session read land). Conservative: nothing room-only
 * renders, a send is an ordinary addressed turn that the server re-decides
 * (it alone knows the humans), and mid-turn sends wait for the real policy.
 */
export const PENDING_POLICY: ChatSessionPolicy = {
  ...PERSONAL_CHAT_POLICY,
  pins: false,
  queue: false,
};

/** A web room as an older server described it (no `policy` on the row). */
export function legacyRoomPolicy(transport: string | undefined): ChatSessionPolicy {
  return {
    addressing: "mention",
    multiVoice: true,
    pins: transport === undefined || transport === "web",
    queue: false,
    post: transport === undefined || transport === "web",
    presence: transport === undefined || transport === "web",
  };
}

/** Parse a server `policy` object, or null when it is absent or malformed. */
export function parseChatSessionPolicy(raw: unknown): ChatSessionPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.addressing !== "mention" && p.addressing !== "every_message") return null;
  const flag = (key: string) => p[key] === true;
  return {
    addressing: p.addressing,
    multiVoice: flag("multiVoice"),
    pins: flag("pins"),
    queue: flag("queue"),
    post: flag("post"),
    presence: flag("presence"),
  };
}

/**
 * How many humans take part, as this client can see right now: the server's
 * count (the starter, every poster, the viewer) raised by any sender the
 * loaded transcript shows that the count predates. A second human's first
 * post reloads the transcript over the follow stream, so the switch to room
 * rules needs no reload (D2).
 */
export function effectiveHumanCount(params: {
  serverCount: number | null | undefined;
  viewerUserId: string | null;
  senderUserIds: readonly (string | null | undefined)[];
}): number {
  const seen = new Set<string>();
  if (params.viewerUserId) seen.add(params.viewerUserId);
  for (const id of params.senderUserIds) if (id) seen.add(id);
  return Math.max(params.serverCount ?? 1, seen.size, 1);
}

/** Addressing with the live human count applied: a second human gates it. */
export function effectiveAddressing(
  policy: ChatSessionPolicy,
  humanCount: number,
): ChatSessionPolicy["addressing"] {
  if (policy.addressing === "mention") return "mention";
  return policy.post && humanCount > 1 ? "mention" : "every_message";
}

/**
 * Is a send addressed to the assistant (a turn), or a silent post? Only a
 * conversation that posts can carry a silent message; everywhere else every
 * send is a turn. `explicit` is any address the sender made on purpose: Ask,
 * an `@` mention, a reply to an assistant message, a slash command, files,
 * research mode.
 */
export function isAddressedSend(params: {
  policy: ChatSessionPolicy;
  humanCount: number;
  explicit: boolean;
}): boolean {
  if (params.explicit) return true;
  if (!params.policy.post) return true;
  return effectiveAddressing(params.policy, params.humanCount) === "every_message";
}

/**
 * Is the Ask affordance (toggle and the Cmd/Ctrl+Enter chord) meaningful?
 * Only where a plain send would NOT already be answered: a conversation that
 * posts, with more than one human in it. Hidden while the user is the only
 * human (D2).
 */
export function askAffordanceVisible(policy: ChatSessionPolicy, humanCount: number): boolean {
  return effectiveAddressing(policy, humanCount) === "mention" && policy.post;
}

/** Typing beacons and the "is typing" line only matter with another human present. */
export function typingPresenceActive(policy: ChatSessionPolicy, humanCount: number): boolean {
  return policy.presence && humanCount > 1;
}

/**
 * Which mid-turn path a send takes while a turn is live (D3):
 *   - `client_queue`: a personal chat; the client holds the message until the
 *     running turn takes it, and sends it as a turn if it never does;
 *   - `room_inbox`: a room; the server saves the message first (every member
 *     sees it) and hands it to the running turn too, falling back to the
 *     room's follow-up turn on its own;
 *   - `none`: the policy is not known yet, so the send waits.
 */
export function midTurnPath(policy: ChatSessionPolicy): "client_queue" | "room_inbox" | "none" {
  if (!policy.queue) return "none";
  return policy.post ? "room_inbox" : "client_queue";
}
