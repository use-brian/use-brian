/**
 * Unit tests for the per-tool approval preview parse layer.
 * Component tag: [COMP:app-web/approvals] (folded into the approvals row —
 * the parsers exist for the queue's tool-specific preview cards).
 */

import { describe, it, expect } from "vitest";
import {
  attachmentDisplayName,
  emailBodyPreviewMarkdown,
  extractAttachmentLines,
  parseEmailSendArgs,
  parseToolPreview,
  splitRecipients,
} from "../approval-previews";

describe("[COMP:app-web/approvals] parseToolPreview", () => {
  it("recognises gmailSendMessage and parses the email shape", () => {
    const preview = parseToolPreview("gmailSendMessage", {
      to: "alice@example.com",
      subject: "Q2 report",
      body: "Attached.",
      attachments: ["/reports/q2.pdf"],
    });
    expect(preview).toEqual({
      kind: "email_send",
      email: {
        to: ["alice@example.com"],
        from: null,
        subject: "Q2 report",
        body: "Attached.",
        attachments: ["/reports/q2.pdf"],
      },
    });
  });

  it("returns null for tools without a specific preview (generic fallback)", () => {
    expect(parseToolPreview("createTask", { title: "x" })).toBeNull();
    expect(parseToolPreview(null, { to: "a@b.c" })).toBeNull();
  });

  it("returns null when a recognised tool's args do not match the shape", () => {
    expect(parseToolPreview("gmailSendMessage", { query: "inbox" })).toBeNull();
    expect(parseToolPreview("gmailSendMessage", {})).toBeNull();
  });
});

describe("[COMP:app-web/approvals] parseEmailSendArgs", () => {
  it("splits comma/semicolon recipient lists and keeps the from alias", () => {
    const email = parseEmailSendArgs({
      to: "a@x.com, b@y.com; c@z.com",
      from: "team@x.com",
      subject: "Hi",
      body: "Hello",
    });
    expect(email?.to).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(email?.from).toBe("team@x.com");
  });

  it("tolerates missing fields as long as one email field is present", () => {
    const email = parseEmailSendArgs({ body: "just a body" });
    expect(email).toEqual({
      to: [],
      from: null,
      subject: "",
      body: "just a body",
      attachments: [],
    });
  });

  it("drops non-string attachment entries instead of failing", () => {
    const email = parseEmailSendArgs({
      to: "a@x.com",
      subject: "s",
      body: "b",
      attachments: ["file-id-1", 42, null, "/docs/plan.md"],
    });
    expect(email?.attachments).toEqual(["file-id-1", "/docs/plan.md"]);
  });
});

describe("[COMP:app-web/approvals] attachment helpers", () => {
  it("extracts resolved attachment lines from displayLines", () => {
    expect(
      extractAttachmentLines([
        "• To: a@x.com",
        "• Attachment: q2.pdf (1.2 MB)",
        "• Attachment: notes.md (14 KB)",
      ]),
    ).toEqual(["q2.pdf (1.2 MB)", "notes.md (14 KB)"]);
    expect(extractAttachmentLines(undefined)).toEqual([]);
  });

  it("uses the basename for path refs and the raw ref otherwise", () => {
    expect(attachmentDisplayName("/reports/q2.pdf")).toBe("q2.pdf");
    expect(attachmentDisplayName("file-abc-123")).toBe("file-abc-123");
  });
});

describe("[COMP:app-web/approvals] emailBodyPreviewMarkdown", () => {
  it("hardens single newlines into markdown hard breaks (send parity)", () => {
    expect(emailBodyPreviewMarkdown("Hi Sarah,\nThanks for the call.")).toBe(
      "Hi Sarah,  \nThanks for the call.",
    );
  });

  it("leaves paragraph breaks (blank lines) untouched", () => {
    expect(emailBodyPreviewMarkdown("Para one.\n\nPara two.")).toBe(
      "Para one.\n\nPara two.",
    );
  });

  it("does not touch newlines inside fenced code blocks", () => {
    const body = "See:\n```\nline1\nline2\n```\nBye";
    expect(emailBodyPreviewMarkdown(body)).toBe(
      "See:  \n```\nline1\nline2\n```  \nBye",
    );
  });
});
