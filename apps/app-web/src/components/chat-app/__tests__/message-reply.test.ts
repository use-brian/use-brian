import { describe, expect, it } from "vitest";
import {
  REPLY_QUOTE_MAX_CHARS,
  buildReplyTarget,
  canReplyToMessage,
  condenseQuote,
  selectionTextWithin,
} from "../message-reply";

const assistantRow = {
  id: "m-1",
  role: "assistant",
  text: "Monthly Breakdown (FY2025)\n\n| Month | Payroll |\n| Jan | $422.6k |",
  senderAssistantId: "cfo",
};

const userRow = { id: "m-2", role: "user", text: "What drove December?" };

/** A stand-in for the row element and the browser Selection sitting in it. */
function fakeSelection(params: {
  text: string;
  anchorInside?: boolean;
  focusInside?: boolean;
  collapsed?: boolean;
}) {
  const anchorNode = { id: "anchor" } as unknown as Node;
  const focusNode = { id: "focus" } as unknown as Node;
  const inside = new Set<Node>();
  if (params.anchorInside ?? true) inside.add(anchorNode);
  if (params.focusInside ?? true) inside.add(focusNode);
  return {
    container: { contains: (node: Node | null) => !!node && inside.has(node) },
    selection: {
      isCollapsed: params.collapsed ?? false,
      anchorNode,
      focusNode,
      toString: () => params.text,
    },
  };
}

describe("[COMP:app-web/message-reply] Quoting a message in a reply", () => {
  describe("condenseQuote", () => {
    it("flattens a markdown quote to one line", () => {
      expect(condenseQuote(assistantRow.text)).toBe(
        "Monthly Breakdown (FY2025) | Month | Payroll | | Jan | $422.6k |",
      );
    });

    it("caps long text with an ellipsis and never exceeds the cap", () => {
      const condensed = condenseQuote("a".repeat(500), 20);
      expect(condensed).toHaveLength(20);
      expect(condensed.endsWith("…")).toBe(true);
    });

    it("leaves text at or under the cap untouched", () => {
      expect(condenseQuote("short enough", 40)).toBe("short enough");
    });
  });

  describe("canReplyToMessage", () => {
    it("allows both roles", () => {
      expect(canReplyToMessage(assistantRow)).toBe(true);
      expect(canReplyToMessage(userRow)).toBe(true);
    });

    // The id is what the route resolves to decide whether the quoted row was
    // an assistant's; an optimistic id resolves to nothing.
    it("refuses a row the server has not acknowledged", () => {
      expect(canReplyToMessage({ ...userRow, id: "local-1712" })).toBe(false);
    });

    it("refuses an empty row and a non-chat role", () => {
      expect(canReplyToMessage({ ...userRow, text: "   " })).toBe(false);
      expect(canReplyToMessage({ ...userRow, role: "tool" })).toBe(false);
      expect(canReplyToMessage(null)).toBe(false);
    });
  });

  describe("selectionTextWithin", () => {
    it("returns the selected text when both ends sit inside the row", () => {
      const { container, selection } = fakeSelection({ text: "  Dec $1,045.0k " });
      expect(selectionTextWithin(container, selection)).toBe("Dec $1,045.0k");
    });

    // A drag that leaves the message is not a quote of it. Quoting the half
    // that happens to be the anchor would be worse than quoting nothing.
    it("refuses a selection that starts or ends outside the row", () => {
      const spillsForward = fakeSelection({ text: "x", focusInside: false });
      expect(
        selectionTextWithin(spillsForward.container, spillsForward.selection),
      ).toBeNull();
      const spillsBack = fakeSelection({ text: "x", anchorInside: false });
      expect(
        selectionTextWithin(spillsBack.container, spillsBack.selection),
      ).toBeNull();
    });

    it("refuses a collapsed selection, a whitespace one, and missing inputs", () => {
      const collapsed = fakeSelection({ text: "x", collapsed: true });
      expect(selectionTextWithin(collapsed.container, collapsed.selection)).toBeNull();
      const blank = fakeSelection({ text: "   \n " });
      expect(selectionTextWithin(blank.container, blank.selection)).toBeNull();
      expect(selectionTextWithin(null, null)).toBeNull();
    });
  });

  describe("buildReplyTarget", () => {
    it("quotes the whole message when nothing is selected", () => {
      expect(buildReplyTarget({ message: userRow })).toEqual({
        id: "m-2",
        role: "user",
        text: "What drove December?",
      });
    });

    // Selecting first is the whole affordance: quoting a long answer to ask
    // about one figure in it tells the model nothing.
    it("prefers the selection over the message body", () => {
      const target = buildReplyTarget({
        message: assistantRow,
        selection: "  Dec $1,045.0k  ",
      });
      expect(target?.text).toBe("Dec $1,045.0k");
    });

    it("falls back to the body when the selection is only whitespace", () => {
      const target = buildReplyTarget({ message: userRow, selection: "   " });
      expect(target?.text).toBe("What drove December?");
    });

    it("carries the author label and the answering assistant for routing", () => {
      const target = buildReplyTarget({
        message: assistantRow,
        authorName: "CFO",
      });
      expect(target?.authorName).toBe("CFO");
      expect(target?.assistantId).toBe("cfo");
    });

    // Routing only makes sense for a row an assistant wrote.
    it("carries no assistant id for a human row", () => {
      const target = buildReplyTarget({
        message: { ...userRow, senderAssistantId: "cfo" },
        authorName: "Ada",
      });
      expect(target?.assistantId).toBeUndefined();
    });

    it("caps a pathological selection at the wire limit", () => {
      const target = buildReplyTarget({
        message: assistantRow,
        selection: "b".repeat(REPLY_QUOTE_MAX_CHARS * 3),
      });
      expect(target?.text).toHaveLength(REPLY_QUOTE_MAX_CHARS);
    });

    it("returns null for a row that cannot be quoted", () => {
      expect(buildReplyTarget({ message: { ...userRow, id: "local-9" } })).toBeNull();
      expect(buildReplyTarget({ message: { ...userRow, text: "  " } })).toBeNull();
    });
  });
});
