import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  askAffordanceVisible,
  effectiveAddressing,
  effectiveHumanCount,
  FRESH_PANE_POLICY,
  isAddressedSend,
  legacyRoomPolicy,
  midTurnPath,
  parseChatSessionPolicy,
  PENDING_POLICY,
  PERSONAL_CHAT_POLICY,
  typingPresenceActive,
  type ChatSessionPolicy,
} from "../chat-session-policy";

const ROOM: ChatSessionPolicy = {
  addressing: "every_message",
  multiVoice: true,
  pins: true,
  queue: true,
  post: true,
  presence: true,
};

describe("[COMP:app-web/chat-session-policy] a personal chat is a room with one human", () => {
  it("D1: a personal chat gets every room surface but posting and presence", () => {
    expect(PERSONAL_CHAT_POLICY).toMatchObject({ multiVoice: true, pins: true, queue: true });
    expect(PERSONAL_CHAT_POLICY.post).toBe(false);
    expect(PERSONAL_CHAT_POLICY.presence).toBe(false);
    // A fresh pane behaves the same whatever it will create.
    expect(FRESH_PANE_POLICY.addressing).toBe("every_message");
    expect(FRESH_PANE_POLICY.multiVoice).toBe(true);
  });

  it("D2: with one human every send is addressed; a second human gates it", () => {
    expect(isAddressedSend({ policy: PERSONAL_CHAT_POLICY, humanCount: 1, explicit: false })).toBe(true);
    expect(isAddressedSend({ policy: ROOM, humanCount: 1, explicit: false })).toBe(true);
    // The server said one human; the transcript now shows two: room rules.
    expect(effectiveAddressing(ROOM, 2)).toBe("mention");
    expect(isAddressedSend({ policy: ROOM, humanCount: 2, explicit: false })).toBe(false);
    expect(isAddressedSend({ policy: ROOM, humanCount: 2, explicit: true })).toBe(true);
    // A conversation that cannot post never carries a silent message.
    expect(isAddressedSend({ policy: { ...ROOM, post: false, addressing: "mention" }, humanCount: 3, explicit: false })).toBe(true);
  });

  it("D2: the Ask toggle and typing show only while another human takes part", () => {
    expect(askAffordanceVisible(PERSONAL_CHAT_POLICY, 1)).toBe(false);
    expect(askAffordanceVisible(ROOM, 1)).toBe(false);
    expect(askAffordanceVisible(ROOM, 2)).toBe(true);
    expect(typingPresenceActive(ROOM, 1)).toBe(false);
    expect(typingPresenceActive(ROOM, 2)).toBe(true);
    expect(typingPresenceActive(PERSONAL_CHAT_POLICY, 1)).toBe(false);
  });

  it("counts the humans the client can see, never fewer than the server said", () => {
    expect(effectiveHumanCount({ serverCount: 1, viewerUserId: "me", senderUserIds: [] })).toBe(1);
    expect(effectiveHumanCount({ serverCount: 1, viewerUserId: "me", senderUserIds: ["me", null, "ana"] })).toBe(2);
    expect(effectiveHumanCount({ serverCount: 3, viewerUserId: "me", senderUserIds: ["me"] })).toBe(3);
    expect(effectiveHumanCount({ serverCount: null, viewerUserId: null, senderUserIds: [] })).toBe(1);
  });

  it("D3: a personal chat queues client-side, a room hands posts to the turn, pending waits", () => {
    expect(midTurnPath(PERSONAL_CHAT_POLICY)).toBe("client_queue");
    expect(midTurnPath(ROOM)).toBe("room_inbox");
    expect(midTurnPath(PENDING_POLICY)).toBe("none");
  });

  it("T1: reads the server's flags and survives an older server", () => {
    expect(parseChatSessionPolicy({ ...ROOM })).toEqual(ROOM);
    expect(parseChatSessionPolicy({ addressing: "loud" })).toBeNull();
    expect(parseChatSessionPolicy(undefined)).toBeNull();
    expect(legacyRoomPolicy("web")).toMatchObject({ post: true, presence: true, pins: true, addressing: "mention" });
    expect(legacyRoomPolicy("slack")).toMatchObject({ post: false, pins: false });
  });
});

describe("[COMP:app-web/chat-session-policy] the Chat surface reads policy, never room-ness", () => {
  const surface = readFileSync(new URL("../../components/chat-app/chat-surface.tsx", import.meta.url), "utf8");

  it("has no list-membership or view-derived room predicate left", () => {
    expect(surface).not.toMatch(/\bpaneIsRoom\b|\bisRoomView\b|\bisSharedOpen\b|\bactiveShared\b/);
  });

  it("derives the pane's policy from the row, the session read, or the fresh-pane default", () => {
    expect(surface).toContain("activeRow?.policy ?? paneSummary?.policy ?? PENDING_POLICY");
    expect(surface).toContain("enabled: panePolicy.multiVoice");
    expect(surface).toContain("panePolicy.pins && activeSessionId ? (");
    expect(surface).toContain("askAffordanceVisible(panePolicy, paneHumanCount)");
  });
});
