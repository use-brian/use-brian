import { describe, expect, it } from "vitest";
import { RecordingApiError } from "@/lib/api/recordings";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import { recordingFailureMessage } from "../failure-copy";

describe.each([en, ja, zh, zhCN])("recording failure copy in every locale", (t) => {
  it.each([
    ["recording_upload_prepare_failed", "uploadPrepareFailed"],
    ["recording_intake_provenance_required", "uploadPrepareFailed"],
    ["recording_upload_complete_failed", "uploadCompleteFailed"],
    ["recording_media_tools_unavailable", "serverSetupRequired"],
  ] as const)("does not blame storage or connectivity for %s", (code, key) => {
    const message = recordingFailureMessage(new RecordingApiError("internal server detail", 503, code), "upload", t);
    expect(message).toBe(t.recordings[key]);
    expect(message.length).toBeGreaterThan(10);
    expect(message).not.toBe(t.recordings.uploadFailed);
    expect(message).not.toContain("internal server detail");
  });

  it("reserves storage copy for actual byte transfer failure", () => {
    expect(recordingFailureMessage(new RecordingApiError("network", 0, "recording_upload_storage_failed"), "upload", t))
      .toBe(t.recordings.uploadFailed);
  });
});
