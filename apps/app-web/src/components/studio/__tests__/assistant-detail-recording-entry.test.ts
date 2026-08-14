import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../assistant-detail.tsx", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/assistant-detail] recording entry placement", () => {
  it("keeps recording ingest out of the assistant Brain tab", () => {
    expect(source).not.toContain("RecordingUploadButton");
    expect(source).not.toContain("panel=recordings");
    expect(source).not.toContain("recordings.uploadHint");
  });
});
