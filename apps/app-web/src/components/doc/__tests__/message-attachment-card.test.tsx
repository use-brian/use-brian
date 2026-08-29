/**
 * [COMP:app-web/message-attachment-card] Uploaded-file cards in chat history.
 *
 * app-web vitest has no jsdom, so we assert over server-rendered markup
 * (the SSR-only pattern the other doc tests use). Contract: nothing renders
 * for an empty list; an image attachment becomes a clickable thumbnail card
 * that opens the in-app lightbox; a PDF whose bytes ride the message becomes
 * a clickable icon card that opens the in-app viewer; anything without
 * client-side bytes stays a static icon card.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { MessageAttachmentRef } from "@/lib/api/sessions";
import { MessageAttachments } from "../message-attachment-card";

function render(attachments: MessageAttachmentRef[], workspaceId?: string): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={en}>
      <MessageAttachments attachments={attachments} workspaceId={workspaceId} />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/message-attachment-card] MessageAttachments", () => {
  it("renders nothing for an empty list", () => {
    expect(render([])).toBe("");
  });

  it("renders an image attachment as a clickable thumbnail with name + type", () => {
    const markup = render([
      { id: "f1", name: "cert.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ]);
    expect(markup).toContain('src="data:image/png;base64,AAA"');
    expect(markup).toContain('alt="cert.png"');
    expect(markup).toContain("cert.png");
    expect(markup).toContain("PNG");
    expect(markup).toContain("<button"); // opens the in-app lightbox
  });

  it("renders a PDF with client-side bytes as a clickable icon card", () => {
    const markup = render([
      {
        id: "f2",
        name: "spec.pdf",
        mime: "application/pdf",
        dataUrl: "data:application/pdf;base64,BBB",
      },
    ]);
    expect(markup).toContain("spec.pdf");
    expect(markup).toContain("PDF");
    expect(markup).toContain("<button"); // opens the in-app PDF viewer
    expect(markup).not.toContain("<img"); // icon tile, not a thumbnail
  });

  it("renders an office doc as clickable when a workspace scope is provided", () => {
    // Server-rendered preview (LibreOffice → PDF via /api/files/:id/preview-pdf)
    // needs the file id + workspace scope, nothing client-side.
    const markup = render(
      [
        {
          id: "f3",
          name: "notes.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
      "ws-1",
    );
    expect(markup).toContain("notes.docx");
    expect(markup).toContain("<button");
  });

  it("keeps an office doc static without a workspace scope or file id", () => {
    const noWorkspace = render([
      {
        id: "f3",
        name: "notes.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ]);
    expect(noWorkspace).not.toContain("<button");
    const noId = render(
      [{ id: "", name: "notes.docx", mime: "application/msword" }],
      "ws-1",
    );
    expect(noId).not.toContain("<button");
  });

  it("renders a non-previewable file as a static icon card (no button, no img)", () => {
    const markup = render([{ id: "f5", name: "notes.zip", mime: "application/zip" }], "ws-1");
    expect(markup).toContain("notes.zip");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<button");
  });

  it("falls back to a static icon card for an image whose bytes have expired", () => {
    const markup = render([
      { id: "f4", name: "old.png", mime: "image/png" }, // no dataUrl
    ]);
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<button");
    expect(markup).toContain("old.png");
  });
});
