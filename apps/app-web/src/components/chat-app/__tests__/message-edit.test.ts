import { describe, expect, it } from "vitest";
import { canEditUserMessage, resolveEditDispatch } from "../message-edit";

const roster = [
  { id: "blendit", name: "Blendit" },
  { id: "shop-cs", name: "Shop CS" },
];

const me = "u-me";

let nextId = 0;

function row(over: Record<string, unknown> = {}) {
  return {
    id: `msg-${nextId++}`,
    role: "user",
    text: "reconcile the orders",
    senderUserId: me,
    ...over,
  };
}

describe("[COMP:app-web/message-edit] editing a sent message", () => {
  it("offers edit on your own text rows", () => {
    expect(
      canEditUserMessage({
        messages: [row()],
        index: 0,
        viewerUserId: me,
        busy: false,
      }),
    ).toBe(true);
  });

  it("treats an unattributed row as the viewer's own", () => {
    // Personal chats and optimistic sends carry no sender.
    expect(
      canEditUserMessage({
        messages: [row({ senderUserId: null })],
        index: 0,
        viewerUserId: null,
        busy: false,
      }),
    ).toBe(true);
  });

  it("refuses a teammate's message, an assistant row, and an empty row", () => {
    const cases = [
      row({ senderUserId: "u-teammate" }),
      row({ role: "assistant", senderUserId: null }),
      row({ text: "   " }),
    ];
    for (const [index, message] of cases.entries()) {
      expect(
        canEditUserMessage({
          messages: [message],
          index: 0,
          viewerUserId: me,
          busy: false,
        }),
        `case ${index}`,
      ).toBe(false);
    }
  });

  it("refuses a row the server has not acknowledged yet", () => {
    // Both edit paths address the row by id; an optimistic one would repost.
    expect(
      canEditUserMessage({
        messages: [row({ id: "local-1770000000000" })],
        index: 0,
        viewerUserId: me,
        busy: false,
      }),
    ).toBe(false);
  });

  it("refuses an attachment-bearing row — a replay cannot carry the files", () => {
    expect(
      canEditUserMessage({
        messages: [row({ userAttachments: [{ id: "f-1" }] })],
        index: 0,
        viewerUserId: me,
        busy: false,
      }),
    ).toBe(false);
  });

  it("refuses while a turn is in flight", () => {
    expect(
      canEditUserMessage({
        messages: [row()],
        index: 0,
        viewerUserId: me,
        busy: true,
      }),
    ).toBe(false);
  });

  it("refuses once a teammate has spoken after it", () => {
    // Re-asking truncates from this row, and a room transcript is not the
    // editor's alone to destroy.
    expect(
      canEditUserMessage({
        messages: [row(), row({ senderUserId: "u-teammate", text: "+1" })],
        index: 0,
        viewerUserId: me,
        busy: false,
      }),
    ).toBe(false);
  });

  it("still allows it when only assistant replies follow", () => {
    expect(
      canEditUserMessage({
        messages: [row(), row({ role: "assistant", senderUserId: null, text: "done" })],
        index: 0,
        viewerUserId: me,
        busy: false,
      }),
    ).toBe(true);
  });

  it("re-asks when the edit adds the mention that was missing", () => {
    expect(
      resolveEditDispatch({
        isRoom: true,
        newText: "@Blendit reconcile the orders",
        roster,
        answered: false,
      }),
    ).toBe("turn");
  });

  it("edits a silent post in place rather than reposting it", () => {
    expect(
      resolveEditDispatch({
        isRoom: true,
        newText: "reconcile the orders (typo fixed)",
        roster,
        answered: false,
      }),
    ).toBe("post");
  });

  it("re-asks when the message already had a reply", () => {
    expect(
      resolveEditDispatch({
        isRoom: true,
        newText: "reconcile the refunds instead",
        roster,
        answered: true,
      }),
    ).toBe("turn");
  });

  it("always re-asks in a personal chat — there is no silent post there", () => {
    expect(
      resolveEditDispatch({
        isRoom: false,
        newText: "reconcile the orders",
        roster,
        answered: false,
      }),
    ).toBe("turn");
  });
});
