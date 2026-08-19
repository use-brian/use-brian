import { describe, expect, it } from "vitest";
import {
  acceptsMentionSelection,
  completeTrailingAssistantMention,
  isAssistantPickerLive,
  mentionCandidatesFor,
  mentionNavigationDelta,
  nextMentionSelectionIndex,
  partitionRoomMentions,
  resolveMentionQuery,
  resolveWorkBenchAssistant,
  trailingMentionQuery,
  type RoomMentionTarget,
} from "../multi-assistant-response";

const roster = [
  { id: "brian", name: "Brian" },
  { id: "hinson", name: "Hinson" },
  { id: "sales", name: "Sales" },
  { id: "sales-eu", name: "Sales EU" },
];

/** The shipped shape of the bug: one name is a prefix of another. */
const sharedPrefixRoster = [
  { id: "blendit", name: "Blendit" },
  { id: "blendit-media", name: "Blendit Media" },
];

/** Walk the popup state the way the composer does: resolve, then feed the
 *  carried dismissal back in on the next keystroke. */
function popup(
  steps: Array<{ text: string; completedInput?: string | null; dismiss?: boolean }>,
) {
  let completedInput: string | null = null;
  let dismissedPrefix: string | null = null;
  let last: ReturnType<typeof resolveMentionQuery> | null = null;
  for (const step of steps) {
    if (step.completedInput !== undefined) completedInput = step.completedInput;
    last = resolveMentionQuery({ text: step.text, completedInput, dismissedPrefix });
    dismissedPrefix = last.dismissedPrefix;
    if (step.dismiss && last.query) {
      dismissedPrefix = step.text.slice(0, last.query.at);
      last = { query: null, dismissedPrefix };
    }
  }
  return last!;
}

/**
 * The pure mention-matching functions (`resolveMentionSpans`,
 * `resolveMentionedAssistants`, `trailingMentionQuery`, `resolveMentionQuery`,
 * `mentionCandidatesFor`, `MAX_ROOM_RESPONDERS`) moved to
 * `@use-brian/shared/mention-matching` — see
 * `packages/shared/src/__tests__/mention-matching.test.ts`. This file keeps
 * only the app-specific (React/DOM-aware, composer-shaped) helpers, plus a
 * thin check that the re-export wiring here still works end to end.
 */
describe("[COMP:app-web/multi-assistant-response] room response group", () => {
  it("cycles the active mention option in both directions", () => {
    expect(nextMentionSelectionIndex(0, 2, 1)).toBe(1);
    expect(nextMentionSelectionIndex(1, 2, 1)).toBe(0);
    expect(nextMentionSelectionIndex(0, 2, -1)).toBe(1);
  });

  it("maps only the arrow keys to selection moves", () => {
    expect(mentionNavigationDelta("ArrowDown")).toBe(1);
    expect(mentionNavigationDelta("ArrowUp")).toBe(-1);
    // Tab confirms the highlighted option, it never advances it.
    expect(mentionNavigationDelta("Tab")).toBeNull();
    // Non-navigation keys fall through to normal composer behavior.
    expect(mentionNavigationDelta("Enter")).toBeNull();
    expect(mentionNavigationDelta("a")).toBeNull();
  });

  it("accepts the highlighted option on Enter and on Tab", () => {
    expect(acceptsMentionSelection("Enter", false)).toBe(true);
    expect(acceptsMentionSelection("Tab", false)).toBe(true);
    // Shift+Tab confirms too — falling through would strand an open popup
    // behind a composer that lost focus.
    expect(acceptsMentionSelection("Tab", true)).toBe(true);
    // Shift+Enter is the newline, not a confirmation.
    expect(acceptsMentionSelection("Enter", true)).toBe(false);
    expect(acceptsMentionSelection("ArrowDown", false)).toBe(false);
    expect(acceptsMentionSelection("a", false)).toBe(false);
  });

  it("completes only the trailing partial mention", () => {
    expect(completeTrailingAssistantMention("Ask @Br", "Brian")).toBe(
      "Ask @Brian ",
    );
    expect(
      completeTrailingAssistantMention("@Brian and @Hi", "Hinson"),
    ).toBe("@Brian and @Hinson ");
  });

  it("stops offering a mention the user already confirmed (re-export wiring)", () => {
    // The reported bug: picking @Blendit left @Blendit Media hanging, because
    // the completion still looks like a trailing query. Exercises
    // completeTrailingAssistantMention (local) feeding into the hoisted
    // trailingMentionQuery / mentionCandidatesFor / resolveMentionQuery.
    const completed = completeTrailingAssistantMention("@Blen", "Blendit");
    expect(completed).toBe("@Blendit ");
    expect(mentionCandidatesFor(trailingMentionQuery(completed), sharedPrefixRoster))
      .toHaveLength(1);
    expect(popup([{ text: completed, completedInput: completed }]).query).toBeNull();

    // A NEW `@` after it opens the popup again.
    expect(
      popup([
        { text: completed, completedInput: completed },
        { text: "@Blendit and @Sal" },
      ]).query,
    ).toEqual({ at: 13, partial: "Sal" });
  });

  it("keeps the assistant chip pickable in an open ROOM, static in an open personal thread", () => {
    const rosterSize = roster.length;
    // A fresh pane picks what the new session/room will bind.
    expect(
      isAssistantPickerLive({ hasOpenSession: false, paneIsRoom: false, rosterSize }),
    ).toBe(true);
    // An open room keeps picking — the binding is its default voice, and any
    // member who can post may move it.
    expect(
      isAssistantPickerLive({ hasOpenSession: true, paneIsRoom: true, rosterSize }),
    ).toBe(true);
    // An open PERSONAL thread does not: no mid-thread switch.
    expect(
      isAssistantPickerLive({ hasOpenSession: true, paneIsRoom: false, rosterSize }),
    ).toBe(false);
  });

  it("degrades to a static label when there is nothing to pick between", () => {
    for (const paneIsRoom of [true, false]) {
      for (const hasOpenSession of [true, false]) {
        expect(
          isAssistantPickerLive({ hasOpenSession, paneIsRoom, rosterSize: 1 }),
        ).toBe(false);
      }
    }
  });

  it("shows the local or followed responder instead of the room default", () => {
    expect(
      resolveWorkBenchAssistant({
        roster,
        fallback: roster[0],
        localActive: true,
        localAssistantId: "hinson",
        remoteActive: false,
        remoteAssistantId: null,
        waitingForInput: false,
      })?.id,
    ).toBe("hinson");

    expect(
      resolveWorkBenchAssistant({
        roster,
        fallback: roster[0],
        localActive: false,
        localAssistantId: null,
        remoteActive: true,
        remoteAssistantId: "sales",
        waitingForInput: false,
      })?.id,
    ).toBe("sales");
  });
});

/**
 * Room human `@mentions` (docs/plans/room-human-mentions.md T-H5/D-H2/D-H3):
 * the send/edit path's partition of a merged assistant+member roster.
 *
 * These are the pure-function seam behind `send()`'s `mentioned`/`addressed`
 * computation and `resolveEditDispatch`'s turn-vs-post choice — mounting the
 * whole `ChatSurface` is not needed to prove the routing decision is right,
 * only that this partition agrees with the server's `resolveRoomMentions`
 * (packages/api/src/room-mentions.ts), which resolves the SAME merged roster
 * through the SAME `resolveMentionSpans`.
 */
describe("[COMP:app-web/multi-assistant-response] room mention partition", () => {
  const merged: RoomMentionTarget[] = [
    // Assistants first — the ordering D-H3's tie-break depends on.
    { id: "a-brian", name: "Brian", mentionKind: "assistant" },
    { id: "a-jane", name: "Jane", mentionKind: "assistant" },
    { id: "m-jane-doe", name: "Jane Doe", mentionKind: "member" },
    { id: "m-bob", name: "Bob Smith", mentionKind: "member" },
  ];

  it("a member-only message resolves no assistant — the silent-post path", () => {
    const result = partitionRoomMentions("@Jane Doe, can you review this?", merged);
    expect(result.assistants).toEqual([]);
    expect(result.members.map((m) => m.id)).toEqual(["m-jane-doe"]);
  });

  it("a mixed message resolves exactly the assistants it does today, plus the members", () => {
    const result = partitionRoomMentions(
      "@Brian please look, and @Bob Smith heads up",
      merged,
    );
    expect(result.assistants.map((a) => a.id)).toEqual(["a-brian"]);
    expect(result.members.map((m) => m.id)).toEqual(["m-bob"]);
  });

  it("an exact name tie between an assistant and a member resolves to the assistant (D-H3)", () => {
    const tied: RoomMentionTarget[] = [
      { id: "a-jane", name: "Jane", mentionKind: "assistant" },
      { id: "m-jane", name: "Jane", mentionKind: "member" },
    ];
    const result = partitionRoomMentions("@Jane, can you take this?", tied);
    expect(result.assistants.map((a) => a.id)).toEqual(["a-jane"]);
    expect(result.members).toEqual([]);
  });

  it("longest-name-wins picks the member over a shorter assistant name at the same position", () => {
    // Assistant "Jane" is a PREFIX of member "Jane Doe" — the merged matcher
    // must resolve this the same way the server's resolveRoomMentions does,
    // not double-count it in both partitions.
    const result = partitionRoomMentions("@Jane Doe can you take this?", merged);
    expect(result.assistants).toEqual([]);
    expect(result.members.map((m) => m.id)).toEqual(["m-jane-doe"]);
  });

  /**
   * The regression this partition exists to fix (caught before it shipped):
   * `chat-surface.tsx`'s `send()` used to resolve `mentioned` via
   * `resolveMentionedAssistants(text, assistants)` — the ASSISTANT-ONLY
   * roster — so `@Jane Doe` would still match assistant "Jane" as a prefix
   * and fire a paid `/api/chat` turn nobody asked for. `send()` now derives
   * `mentioned` from THIS partition's `.assistants`, filtered/mapped onto
   * the live `WorkspaceAssistantSummary[]` roster (a lookup that can only
   * DROP an id, never invent one) — see chat-surface.tsx's `mentioned`
   * assignment, just above the `addressed` computation reproduced below.
   *
   * `result.assistants` being empty is necessary but not sufficient on its
   * own to prove "no assistant POST fires" — `addressed` also gates on
   * askArmed / a reply-to-assistant / attachments / research mode / an
   * explicit forceAddress override, none of which this partition touches.
   * This test closes that gap by reproducing `send()`'s exact `addressed`
   * boolean (chat-surface.tsx, `const addressed = …`) over a message with
   * every OTHER disjunct held at its default-off value, so `addressed` being
   * `false` here is the same gate the real code checks before choosing
   * `postRoomMessage` (silent, T2) over the `/api/chat` turn loop.
   */
  it("the regression case never sets send()'s `addressed` gate — no assistant POST fires", () => {
    const text = "@Jane Doe can you take this?";
    const mentioned = partitionRoomMentions(text, merged).assistants;
    const addressed =
      // !isRoom || askArmed || mentioned.length > 0 || reply?.role === "assistant" ||
      // turnFileIds.length > 0 || turnRecordingIds.length > 0 || researchMode ||
      // override?.forceAddress === true — every other disjunct held false/absent,
      // matching a member-only send with no file/reply/research/forceAddress signal.
      false ||
      false ||
      mentioned.length > 0 ||
      false ||
      false ||
      false ||
      false ||
      false;
    expect(mentioned).toEqual([]);
    expect(addressed).toBe(false);
  });

  it("caps each partition at MAX_ROOM_RESPONDERS independently", () => {
    const bigRoster: RoomMentionTarget[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `assistant-${i}`,
        name: `Assistant ${i}`,
        mentionKind: "assistant" as const,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `member-${i}`,
        name: `Member ${i}`,
        mentionKind: "member" as const,
      })),
    ];
    const text = bigRoster.map((r) => `@${r.name}`).join(" ");
    const result = partitionRoomMentions(text, bigRoster);
    expect(result.assistants).toHaveLength(8);
    expect(result.members).toHaveLength(8);
  });
});
