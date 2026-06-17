/**
 * Pure-logic tests for `lib/api/sessions.ts`.
 *
 * Network calls aren't exercised (vitest in app-web is no-DOM
 * unit-only — see vitest.config.ts). Limit coverage to the helper
 * that the floating-chat resume effect calls on every history row.
 *
 * [COMP:app-web/sessions-sdk]
 */

import { describe, expect, it } from "vitest";
import {
  extractMessageText,
  stripAttachmentMarkup,
  stripCommentThreadReplyTag,
  parseMessageAttachments,
} from "../api/sessions";

describe("[COMP:app-web/sessions-sdk] extractMessageText", () => {
  it("returns a plain string as-is", () => {
    expect(extractMessageText("hello world")).toBe("hello world");
  });

  it("joins text blocks from an Anthropic-style content array", () => {
    const content = [
      { type: "text", text: "first " },
      { type: "text", text: "second" },
    ];
    expect(extractMessageText(content)).toBe("first second");
  });

  it("drops tool_use and tool_result blocks", () => {
    const content = [
      { type: "text", text: "thinking…" },
      { type: "tool_use", id: "t_1", name: "renderView", input: {} },
      { type: "tool_result", tool_use_id: "t_1", content: "ok" },
      { type: "text", text: " done." },
    ];
    expect(extractMessageText(content)).toBe("thinking… done.");
  });

  it("returns empty string for an array with no text blocks", () => {
    const content = [
      { type: "tool_use", id: "t_1", name: "x", input: {} },
    ];
    expect(extractMessageText(content)).toBe("");
  });

  it("returns empty string for null / undefined / non-string content", () => {
    expect(extractMessageText(null)).toBe("");
    expect(extractMessageText(undefined)).toBe("");
    expect(extractMessageText(42)).toBe("");
    expect(extractMessageText({ unexpected: true })).toBe("");
  });

  it("ignores text blocks whose text field isn't a string", () => {
    const content = [
      { type: "text", text: "good" },
      { type: "text", text: 123 },
      { type: "text" },
    ];
    expect(extractMessageText(content)).toBe("good");
  });

  it("handles an empty array", () => {
    expect(extractMessageText([])).toBe("");
  });

  it("collapses an <attached_file> wrapper to a 📎 filename affordance", () => {
    // The chat route emits this for an image/PDF attachment; the comment bubble
    // must not show the raw markup (regression from the screenshot report).
    const content = [
      { type: "image", mimeType: "image/png", data: "iVBOR..." },
      {
        type: "text",
        text: '<attached_file id="0c491d5a" name="Screenshot.png" type="image/png">[image]</attached_file>\n\nwhat is this?',
      },
    ];
    expect(extractMessageText(content)).toBe("📎 Screenshot.png\n\nwhat is this?");
  });

  it("collapses a text attachment without leaking its inlined body", () => {
    const raw =
      '<attached_file id="f1" name="notes.txt" type="text/plain">line one\nline two\nline three</attached_file>\n\nsummarize';
    expect(stripAttachmentMarkup(raw)).toBe("📎 notes.txt\n\nsummarize");
  });

  it("leaves attachment-free text untouched (no trim / newline rewrite)", () => {
    expect(stripAttachmentMarkup("para one\n\n\npara two\n")).toBe(
      "para one\n\n\npara two\n",
    );
  });
});

describe("[COMP:app-web/sessions-sdk] parseMessageAttachments", () => {
  it("returns clean text + no attachments for a plain message", () => {
    const r = parseMessageAttachments([{ type: "text", text: "hello there" }]);
    expect(r.text).toBe("hello there");
    expect(r.attachments).toEqual([]);
  });

  it("extracts an image attachment + thumbnail from the inline image block", () => {
    const content = [
      { type: "image", mimeType: "image/png", data: "BASE64DATA" },
      {
        type: "text",
        text: '<attached_file id="f1" name="cert.png" type="image/png">[image]</attached_file>\n\nwhat is this?',
      },
    ];
    const r = parseMessageAttachments(content);
    expect(r.text).toBe("what is this?");
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]).toMatchObject({ id: "f1", name: "cert.png", mime: "image/png" });
    expect(r.attachments[0].dataUrl).toBe("data:image/png;base64,BASE64DATA");
  });

  it("returns a non-image attachment with no thumbnail and keeps text clean", () => {
    const content = [
      {
        type: "text",
        text: '<attached_file id="f2" name="spec.pdf" type="application/pdf">[pdf]</attached_file>\n\nsummarize',
      },
    ];
    const r = parseMessageAttachments(content);
    expect(r.text).toBe("summarize");
    expect(r.attachments[0]).toMatchObject({ name: "spec.pdf", mime: "application/pdf" });
    expect(r.attachments[0].dataUrl).toBeUndefined();
  });

  it("yields empty text for a file-only message (attachment still present)", () => {
    const content = [
      { type: "image", mimeType: "image/jpeg", data: "X" },
      {
        type: "text",
        text: '<attached_file id="f3" name="photo.jpg" type="image/jpeg">[image]</attached_file>',
      },
    ];
    const r = parseMessageAttachments(content);
    expect(r.text).toBe("");
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].dataUrl).toBe("data:image/jpeg;base64,X");
  });

  it("correlates multiple image attachments to image blocks in order", () => {
    const content = [
      { type: "image", mimeType: "image/png", data: "AAA" },
      { type: "image", mimeType: "image/png", data: "BBB" },
      {
        type: "text",
        text:
          '<attached_file id="a" name="one.png" type="image/png">[image]</attached_file>\n\n' +
          '<attached_file id="b" name="two.png" type="image/png">[image]</attached_file>\n\ncompare',
      },
    ];
    const r = parseMessageAttachments(content);
    expect(r.text).toBe("compare");
    expect(r.attachments.map((a) => a.dataUrl)).toEqual([
      "data:image/png;base64,AAA",
      "data:image/png;base64,BBB",
    ]);
  });

  it("scrubs a confabulated <comment-thread-reply> wrapper from a persisted assistant row", () => {
    // Pre-fix rows already in session_messages carry the leaked tag; the parser
    // unwraps it so the comment surfaces never render the markers or the UUID.
    const content = [
      {
        type: "text",
        text:
          'I have consolidated these into the subpage.\n\n' +
          '<comment-thread-reply pageId="b3317b50-31a9-4223-8aa4-fdfde53478eb">Done.</comment-thread-reply>',
      },
    ];
    const r = parseMessageAttachments(content);
    expect(r.text).toBe("I have consolidated these into the subpage.\n\nDone.");
    expect(r.attachments).toEqual([]);
  });
});

describe("[COMP:app-web/sessions-sdk] stripCommentThreadReplyTag", () => {
  it("returns text unchanged when no tag is present", () => {
    expect(stripCommentThreadReplyTag("plain reply")).toBe("plain reply");
  });

  it("unwraps the tag and keeps the inner reply", () => {
    expect(
      stripCommentThreadReplyTag('<comment-thread-reply pageId="p">Done.</comment-thread-reply>'),
    ).toBe("Done.");
  });

  it("drops a half-streamed unclosed opener (live stream frame)", () => {
    expect(stripCommentThreadReplyTag("Working.\n\n<comment-thread-reply pageId=")).toBe(
      "Working.",
    );
  });
});
