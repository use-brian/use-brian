import { authFetch } from "../auth-fetch";
import { fetchLatestSession, listSessionsForAssistants, listWorkspaceSessions, listAuditSessions, getChatSessionSummary, listPersonalSessions, setSessionArchived } from "../api/sessions";
import { PERSONAL_CHAT_POLICY } from "../chat-session-policy";
vi.mock("../auth-fetch", () => ({ authFetch: vi.fn() }));
/**
 * Pure logic and transport-mapping tests for `lib/api/sessions.ts`.
 *
 * Provider transports are isolated here. Canonical title authority is
 * exercised with real JWTs and non-owner SQL in the API integration suite.
 *
 * [COMP:app-web/sessions-sdk]
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  extractMessageText,
  extractPresentedDocuments,
  stripAttachmentMarkup,
  stripCommentThreadReplyTag,
  parseMessageAttachments,
} from "../api/sessions";

describe("[COMP:app-web/sessions-sdk] archived history", () => {
  it("sends a strict per-viewer archive command", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({ archived: true })));
    await setSessionArchived("chat-id", true);
    expect(authFetch).toHaveBeenLastCalledWith(expect.stringContaining("/api/sessions/chat-id/archive"), expect.objectContaining({ method: "PATCH", body: '{"archived":true}' }));
  });
  it("queries archived Personal history with its cursor", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response("[]"));
    await listPersonalSessions({ workspaceId: "workspace", archived: true, strict: true, before: { id: "last", lastActive: "2026-10-01T00:00:00Z" } });
    const url = new URL(String(vi.mocked(authFetch).mock.calls.at(-1)![0]), "http://localhost");
    expect(url.searchParams.get("archived")).toBe("true");
    expect(url.searchParams.get("beforeId")).toBe("last");
    expect(url.searchParams.get("channels")).toBe("all");
  });
  it("reports archive mutation and list failures", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response("", { status: 403 }));
    await expect(setSessionArchived("chat-id", false)).rejects.toThrow();
    vi.mocked(authFetch).mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(listPersonalSessions({ workspaceId: "workspace", archived: true, strict: true })).rejects.toThrow();
  });
});

describe("[COMP:app-web/chat-document-viewer] persisted document payloads", () => {
  it("restores a validated presentDocument tool input verbatim", () => {
    expect(
      extractPresentedDocuments([
        {
          type: "tool_use",
          id: "tool-doc-1",
          name: "presentDocument",
          input: {
            title: "Design objective.docx",
            sourceName: "Email attachment",
            content: "First line\n\n**literal source**",
            format: "text",
          },
        },
      ]),
    ).toEqual([
      {
        id: "tool-doc-1",
        title: "Design objective.docx",
        sourceName: "Email attachment",
        content: "First line\n\n**literal source**",
        format: "text",
      },
    ]);
  });

  it("defaults legacy missing format to text and drops malformed inputs", () => {
    expect(
      extractPresentedDocuments([
        {
          type: "tool_use",
          id: "valid",
          name: "presentDocument",
          input: { title: "Notes", content: "verbatim" },
        },
        {
          type: "tool_use",
          id: "missing-body",
          name: "presentDocument",
          input: { title: "No body" },
        },
        {
          type: "tool_use",
          id: "wrong-tool",
          name: "fileRead",
          input: { title: "Ignore", content: "Ignore" },
        },
      ]),
    ).toEqual([
      {
        id: "valid",
        title: "Notes",
        content: "verbatim",
        format: "text",
      },
    ]);
  });
});

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

  it("extracts a PDF attachment's preview bytes from its inline media block", () => {
    const content = [
      { type: "image", mimeType: "application/pdf", data: "PDFDATA", name: "spec.pdf" },
      {
        type: "text",
        text: '<attached_file id="f4" name="spec.pdf" type="application/pdf">[image]</attached_file>\n\nsummarize',
      },
    ];
    const r = parseMessageAttachments(content);
    expect(r.text).toBe("summarize");
    expect(r.attachments[0]).toMatchObject({ id: "f4", name: "spec.pdf", mime: "application/pdf" });
    expect(r.attachments[0].dataUrl).toBe("data:application/pdf;base64,PDFDATA");
  });

  it("keeps an image thumbnail on the image when a store-only PDF has no block", () => {
    // A PDF above the inline threshold has a tag but no media block; positional
    // zipping would hand the image's block to the PDF. Family/name matching
    // must keep the assignment on the image.
    const content = [
      { type: "image", mimeType: "image/png", data: "IMGDATA", name: "shot.png" },
      {
        type: "text",
        text:
          '<attached_file id="p" name="big.pdf" type="application/pdf">[image]</attached_file>\n\n' +
          '<attached_file id="i" name="shot.png" type="image/png">[image]</attached_file>\n\nlook',
      },
    ];
    const r = parseMessageAttachments(content);
    expect(r.attachments[0].dataUrl).toBeUndefined();
    expect(r.attachments[1].dataUrl).toBe("data:image/png;base64,IMGDATA");
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


describe("[COMP:app-web/sessions-sdk] admitted title revision transport", () => {
  afterEach(() => vi.mocked(authFetch).mockReset());
  const row = (titleRevisionId: string | null) => ({
    id: "fictional-session", title: titleRevisionId ? "Fictional current title" : "New Chat",
    titleRevisionId, channelId: "fictional-channel", lastActive: "2026-10-21T00:00:00.000Z",
    assistantId: "fictional-assistant", appOrigin: "chat", policy: PERSONAL_CHAT_POLICY,
  });
  for (const revision of ["opaque-current-revision", null]) {
    it(`preserves ${revision === null ? "held null" : "current opaque"} revision identity through every actual title mapping`, async () => {
      vi.mocked(authFetch).mockImplementation(async input => new Response(JSON.stringify(
        /sessions\/fictional-session$/.test(String(input)) ? row(revision) : [row(revision)],
      ), { status: 200, headers: { "Content-Type": "application/json" } }));
      const opts = {workspaceId: "fictional-workspace", assistantId: "fictional-assistant"};
      const values = [
        await fetchLatestSession({...opts, appOrigin: "chat"}),
        ...(await listSessionsForAssistants({...opts, assistantIds: [opts.assistantId]})),
        ...(await listWorkspaceSessions(opts)),
        ...(await listAuditSessions(opts)),
        await getChatSessionSummary("fictional-session"),
      ];
      expect(values).toHaveLength(5);
      for (const value of values) expect(value).toMatchObject({titleRevisionId: revision, title: row(revision).title});
    });
  }
});


describe("[COMP:app-web/sessions-sdk] provider channel names", () => {
  it.each([500, 503])("preserves personal and shared list HTTP %i as failures for cached readers", async (status) => {
    vi.mocked(authFetch).mockImplementation(async () => new Response("", { status }));
    await expect(listSessionsForAssistants({ workspaceId: "workspace", assistantIds: ["assistant"], strict: true })).rejects.toThrow();
    await expect(listWorkspaceSessions({ workspaceId: "workspace", strict: true })).rejects.toThrow();
  });

  it("rejects malformed successful list responses in strict mode", async () => {
    vi.mocked(authFetch).mockImplementation(async () => new Response(JSON.stringify({ error: "unavailable" })));
    await expect(listPersonalSessions({ workspaceId: "workspace", strict: true })).rejects.toThrow();
    await expect(listWorkspaceSessions({ workspaceId: "workspace", strict: true })).rejects.toThrow();
  });

  it("preserves source names independently of conversation titles and accepts older servers", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify([
      { id: "a", title: "Conversation title", channelId: "C123", channelType: "slack", channelName: "#engineering", lastActive: "2026-01-01" },
      { id: "b", title: "Older conversation", channelId: "C456", channelType: "slack", lastActive: "2026-01-01" },
    ])));
    const rows = await listPersonalSessions({ workspaceId: "workspace" });
    expect(rows[0]).toMatchObject({ title: "Conversation title", channelName: "#engineering", transport: "slack" });
    expect(rows[1].channelName).toBeUndefined();
  });
});
