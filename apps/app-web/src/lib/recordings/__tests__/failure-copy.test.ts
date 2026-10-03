/**
 * [COMP:web/recording-upload] Step-aware recording failure copy.
 * Spec: docs/architecture/engine/preflight-confirmation.md.
 */

import { describe, expect, it } from "vitest";
import { RecordingApiError, RecordingResolveError } from "@/lib/api/recordings";
import { en } from "@/lib/i18n/dictionaries/en";
import { recordingFailureMessage } from "../failure-copy";

describe("[COMP:web/recording-upload] recordingFailureMessage", () => {
  it("says the storage is full rather than blaming the connection", () => {
    const e = new RecordingApiError("Workspace storage quota exceeded", 413, "quota_exceeded");
    expect(recordingFailureMessage(e, "upload", en)).toBe(en.recordings.storageFull);
  });

  it("never claims the audio missed storage once the file is stored", () => {
    const e = new RecordingResolveError(new RecordingApiError("boom", 500, "internal"), "file-1");
    const message = recordingFailureMessage(e, "upload", en);
    expect(message).toContain(en.recordings.processFailed);
    expect(message).not.toBe(en.recordings.uploadFailed);
  });

  it("keeps the storage copy for a genuine upload failure", () => {
    const e = new RecordingApiError("Upload to storage failed (network error)", 0);
    expect(recordingFailureMessage(e, "upload", en)).toBe(en.recordings.uploadFailed);
  });
});
