import { describe, expect, it } from "vitest";
import {
  acceptsMentionSelection,
  completeTrailingAssistantMention,
  isAssistantPickerLive,
  mentionCandidatesFor,
  mentionNavigationDelta,
  nextMentionSelectionIndex,
  resolveMentionQuery,
  resolveMentionSpans,
  resolveMentionedAssistants,
  resolveWorkBenchAssistant,
  trailingMentionQuery,
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

  it("returns every distinct mentioned assistant in textual order", () => {
    expect(
      resolveMentionedAssistants("@HINSON and @Brian, what do you both know? @hinson", roster)
        .map((assistant) => assistant.id),
    ).toEqual(["hinson", "brian"]);
  });

  it("uses the longest overlapping assistant name", () => {
    expect(
      resolveMentionedAssistants("Ask @Sales EU, then @Sales.", roster)
        .map((assistant) => assistant.id),
    ).toEqual(["sales-eu", "sales"]);
  });

  it("does not treat a longer word as a mention", () => {
    expect(resolveMentionedAssistants("@Brianna", roster)).toEqual([]);
  });

  it("bounds one response group to eight assistants", () => {
    const largeRoster = Array.from({ length: 10 }, (_, index) => ({
      id: `assistant-${index}`,
      name: `Assistant ${index}`,
    }));
    const message = largeRoster.map((assistant) => `@${assistant.name}`).join(" ");

    expect(resolveMentionedAssistants(message, largeRoster)).toHaveLength(8);
  });

  it("reports each mention's range so the composer can chip it", () => {
    expect(
      resolveMentionSpans("Ask @Sales EU, then @Sales.", roster),
    ).toMatchObject([
      { assistant: { id: "sales-eu" }, start: 4, end: 13 },
      { assistant: { id: "sales" }, start: 20, end: 26 },
    ]);
    // What is painted is what is addressed: a repeat still highlights, but the
    // assistant answers once.
    const repeated = "@Brian and @Brian again";
    expect(resolveMentionSpans(repeated, roster)).toHaveLength(2);
    expect(resolveMentionedAssistants(repeated, roster)).toHaveLength(1);
  });

  it("finds the trailing `@` query, spaces and all", () => {
    expect(trailingMentionQuery("ask @sales e")).toEqual({
      at: 4,
      partial: "sales e",
    });
    expect(trailingMentionQuery("no mention here")).toBeNull();
    // An `@` glued to a word is an address, not a mention query.
    expect(trailingMentionQuery("mail me@example.com")).toBeNull();
  });

  it("stops offering a mention the user already confirmed", () => {
    // The reported bug: picking @Blendit left @Blendit Media hanging, because
    // the completion still looks like a trailing query.
    const completed = completeTrailingAssistantMention("@Blen", "Blendit");
    expect(completed).toBe("@Blendit ");
    expect(mentionCandidatesFor(trailingMentionQuery(completed), sharedPrefixRoster))
      .toHaveLength(1);
    expect(popup([{ text: completed, completedInput: completed }]).query).toBeNull();

    // Typing on is prose, not a longer query.
    expect(
      popup([
        { text: completed, completedInput: completed },
        { text: "@Blendit Media please" },
      ]).query,
    ).toBeNull();

    // A NEW `@` after it opens the popup again.
    expect(
      popup([
        { text: completed, completedInput: completed },
        { text: "@Blendit and @Sal" },
      ]).query,
    ).toEqual({ at: 13, partial: "Sal" });

    // Deleting back INTO the name is how you extend it to the longer name.
    expect(
      popup([
        { text: completed, completedInput: completed },
        { text: "@Blendit" },
      ]).query,
    ).toEqual({ at: 0, partial: "Blendit" });
  });

  it("keeps the popup closed for the `@` the user dismissed", () => {
    // Escape (or a click outside) at "ask @sa" — typing on does not reopen it.
    expect(popup([{ text: "ask @sa", dismiss: true }, { text: "ask @sal" }]).query)
      .toBeNull();
    // A different `@` is a different question.
    expect(
      popup([{ text: "ask @sa", dismiss: true }, { text: "ask @sal @hi" }]).query,
    ).toEqual({ at: 9, partial: "hi" });
    // Dropping the `@` clears the anchor, so the next one opens fresh.
    expect(
      popup([
        { text: "ask @sa", dismiss: true },
        { text: "ask " },
        { text: "ask @sa" },
      ]).query,
    ).toEqual({ at: 4, partial: "sa" });
  });

  it("filters the roster by what was typed after the `@`", () => {
    expect(
      mentionCandidatesFor({ at: 0, partial: "sales " }, roster).map((a) => a.id),
    ).toEqual(["sales-eu"]);
    // An empty query offers the whole roster.
    expect(mentionCandidatesFor({ at: 0, partial: "" }, roster)).toHaveLength(4);
    expect(mentionCandidatesFor(null, roster)).toHaveLength(0);
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
