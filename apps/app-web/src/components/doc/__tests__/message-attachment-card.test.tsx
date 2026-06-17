/**
 * [COMP:app-web/message-attachment-card] Uploaded-file cards in chat history.
 *
 * app-web vitest has no jsdom, so we assert over server-rendered markup
 * (the SSR-only pattern the other doc tests use). Contract: nothing renders
 * for an empty list; an image attachment becomes a clickable thumbnail (`<img>`
 * from the persisted data URL) with its filename + type label; a non-image
 * becomes a static icon card with a type label and no `<img>`.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessageAttachmentRef } from "@/lib/api/sessions";
import { MessageAttachments } from "../message-attachment-card";

function render(attachments: MessageAttachmentRef[]): string {
  return renderToStaticMarkup(<MessageAttachments attachments={attachments} />);
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
    expect(markup).toContain("<a"); // image cards link to full size
  });

  it("renders a non-image as a static icon card (no img, no link)", () => {
    const markup = render([
      { id: "f2", name: "spec.pdf", mime: "application/pdf" },
    ]);
    expect(markup).toContain("spec.pdf");
    expect(markup).toContain("PDF");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<a");
  });

  it("falls back to an icon card for an image whose bytes have expired", () => {
    const markup = render([
      { id: "f3", name: "old.png", mime: "image/png" }, // no dataUrl
    ]);
    expect(markup).not.toContain("<img");
    expect(markup).toContain("old.png");
  });
});
