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
  parseShopifyCancelArgs,
  parseShopifyRefundArgs,
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
        cc: [],
        bcc: [],
        from: null,
        subject: "Q2 report",
        body: "Attached.",
        attachments: ["/reports/q2.pdf"],
      },
    });
  });

  it("recognises imapSendMessage — the company-mailbox lane renders the same email card", () => {
    const preview = parseToolPreview("imapSendMessage", {
      to: ["ops@example.com"],
      cc: ["lead@example.com"],
      bcc: ["archive@example.com"],
      subject: "Re: Deal terms",
      body: "Agreed.",
      inReplyTo: "INBOX:7",
    });
    expect(preview).toEqual({
      kind: "email_send",
      email: {
        to: ["ops@example.com"],
        cc: ["lead@example.com"],
        bcc: ["archive@example.com"],
        from: null,
        subject: "Re: Deal terms",
        body: "Agreed.",
        attachments: [],
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

  it("recognises shopifyRefundOrder and shopifyCancelOrder", () => {
    expect(
      parseToolPreview("shopifyRefundOrder", { orderId: "gid://Order/1" }),
    ).toEqual({
      kind: "shopify_refund",
      refund: {
        orderId: "gid://Order/1",
        lineItems: null,
        notify: true,
        note: null,
      },
    });
    expect(
      parseToolPreview("shopifyCancelOrder", { orderId: "1234" }),
    ).toEqual({
      kind: "shopify_cancel",
      cancel: {
        orderId: "1234",
        reason: "OTHER",
        restock: true,
        refund: true,
        notifyCustomer: true,
        staffNote: null,
      },
    });
  });

  it("returns null for shopify order tools missing the orderId", () => {
    expect(parseToolPreview("shopifyRefundOrder", { notify: false })).toBeNull();
    expect(parseToolPreview("shopifyCancelOrder", {})).toBeNull();
  });
});

describe("[COMP:app-web/approvals] parseShopifyRefundArgs", () => {
  it("treats an absent or empty lineItems as a full refund", () => {
    expect(parseShopifyRefundArgs({ orderId: "1" })?.lineItems).toBeNull();
    expect(
      parseShopifyRefundArgs({ orderId: "1", lineItems: [] })?.lineItems,
    ).toBeNull();
  });

  it("keeps well-formed refund lines and drops malformed ones", () => {
    const refund = parseShopifyRefundArgs({
      orderId: "1",
      lineItems: [
        { lineItemId: "li-1", quantity: 2 },
        { lineItemId: "li-2" }, // missing quantity
        { quantity: 1 }, // missing id
        "nope",
      ],
    });
    expect(refund?.lineItems).toEqual([{ lineItemId: "li-1", quantity: 2 }]);
  });

  it("defaults notify to true and drops a blank note", () => {
    expect(parseShopifyRefundArgs({ orderId: "1" })?.notify).toBe(true);
    expect(parseShopifyRefundArgs({ orderId: "1", notify: false })?.notify).toBe(
      false,
    );
    expect(parseShopifyRefundArgs({ orderId: "1", note: "  " })?.note).toBeNull();
    expect(
      parseShopifyRefundArgs({ orderId: "1", note: "gesture" })?.note,
    ).toBe("gesture");
  });

  it("never carries a money amount (Shopify computes it server-side)", () => {
    const refund = parseShopifyRefundArgs({
      orderId: "1",
      amount: "42.00",
    } as Record<string, unknown>);
    expect(refund).not.toHaveProperty("amount");
    expect(Object.keys(refund ?? {})).toEqual([
      "orderId",
      "lineItems",
      "notify",
      "note",
    ]);
  });
});

describe("[COMP:app-web/approvals] parseShopifyCancelArgs", () => {
  it("defaults the three flags to true and reason to OTHER when omitted", () => {
    expect(parseShopifyCancelArgs({ orderId: "1" })).toEqual({
      orderId: "1",
      reason: "OTHER",
      restock: true,
      refund: true,
      notifyCustomer: true,
      staffNote: null,
    });
  });

  it("honours explicit false flags and a known reason", () => {
    expect(
      parseShopifyCancelArgs({
        orderId: "1",
        reason: "FRAUD",
        restock: false,
        refund: false,
        notifyCustomer: false,
        staffNote: "chargeback",
      }),
    ).toEqual({
      orderId: "1",
      reason: "FRAUD",
      restock: false,
      refund: false,
      notifyCustomer: false,
      staffNote: "chargeback",
    });
  });

  it("degrades an unrecognised reason to OTHER", () => {
    expect(
      parseShopifyCancelArgs({ orderId: "1", reason: "BECAUSE" })?.reason,
    ).toBe("OTHER");
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
      cc: [],
      bcc: [],
      from: null,
      subject: "",
      body: "just a body",
      attachments: [],
    });
  });

  it("parses an array `to` (the current tool shape) alongside cc and bcc", () => {
    const email = parseEmailSendArgs({
      to: ["primary@example.com", "second@example.com"],
      cc: ["colleague@example.com"],
      bcc: ["silent@example.com"],
      subject: "Intro",
      body: "Hello",
    });
    expect(email?.to).toEqual(["primary@example.com", "second@example.com"]);
    expect(email?.cc).toEqual(["colleague@example.com"]);
    expect(email?.bcc).toEqual(["silent@example.com"]);
  });

  it("still splits a legacy comma/semicolon `to` string into chips", () => {
    const email = parseEmailSendArgs({ to: "a@x.com, b@y.com; c@z.com" });
    expect(email?.to).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(email?.cc).toEqual([]);
    expect(email?.bcc).toEqual([]);
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
