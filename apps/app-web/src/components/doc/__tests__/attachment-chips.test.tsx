/**
 * [COMP:app-web/attachment-chips] Staged-attachment chip row.
 *
 * app-web vitest has no jsdom, so we assert over server-rendered markup
 * (`renderToStaticMarkup`) — the SSR-only pattern breadcrumb.test.tsx uses.
 * The contract: nothing renders when empty; a ready chip shows its filename + a
 * localized remove control; an uploading chip shows the localized progress
 * label instead of the name; an errored chip carries the destructive styling
 * and surfaces its error as the title.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { Attachment } from "@/lib/use-file-attachments";
import { AttachmentChips } from "../attachment-chips";

const dict = en as unknown as Dictionary;

function render(attachments: Attachment[]): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={dict}>
      <AttachmentChips attachments={attachments} onRemove={() => {}} />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/attachment-chips] AttachmentChips", () => {
  it("renders nothing when there are no attachments", () => {
    expect(render([])).toBe("");
  });

  it("shows a ready chip's filename and a localized remove control", () => {
    const markup = render([
      { localId: "a", fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: 1, status: "done", fileId: "f_a" },
    ]);
    expect(markup).toContain("report.pdf");
    expect(markup).toContain(`aria-label="${en.attachments.remove}"`);
  });

  it("shows the progress label (not the name) while uploading", () => {
    const markup = render([
      { localId: "b", fileName: "secret.txt", mimeType: "text/plain", sizeBytes: 1, status: "uploading" },
    ]);
    expect(markup).toContain(en.attachments.uploading);
  });

  it("applies destructive styling and an error title on failure", () => {
    const markup = render([
      { localId: "c", fileName: "huge.zip", mimeType: "application/zip", sizeBytes: 1, status: "error", error: "too big" },
    ]);
    expect(markup).toContain("text-destructive");
    expect(markup).toContain('title="too big"');
  });
});
