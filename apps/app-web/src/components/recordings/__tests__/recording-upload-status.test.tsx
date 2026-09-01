/** [COMP:web/recording-upload] Determinate composer upload status. */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { RecordingUploadStatus } from "../recording-upload-status";

const dict = en as unknown as Dictionary;

function render(
  status: "idle" | "uploading" | "estimating" | "processing" | "done" | "error",
  uploadProgress = 0,
  message = "Complete",
) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={dict}>
      <RecordingUploadStatus
        status={status}
        uploadProgress={uploadProgress}
        message={message}
      />
    </I18nProvider>,
  );
}

describe("[COMP:web/recording-upload] RecordingUploadStatus", () => {
  it("renders a labelled determinate bar during the signed upload", () => {
    const markup = render("uploading", 0.364);
    expect(markup).toContain("Uploading 36%");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="36"');
    expect(markup).toContain('style="width:36%"');
  });

  it("clamps out-of-range transport progress", () => {
    expect(render("uploading", 2)).toContain('aria-valuenow="100"');
    expect(render("uploading", -1)).toContain('aria-valuenow="0"');
  });

  it("keeps existing non-upload state copy and hides idle", () => {
    expect(render("estimating")).toContain(en.recordings.estimating);
    expect(render("processing")).toContain(en.recordings.processing);
    expect(render("error", 0, "Upload failed")).toContain("Upload failed");
    expect(render("idle")).toBe("");
  });
});
