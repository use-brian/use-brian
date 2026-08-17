import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../assistant-detail.tsx", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/assistant-detail] connector account identity", () => {
  it("shows a distinct connected email below the connector label", () => {
    expect(source).toContain("connectedEmail?: string;");
    expect(source).toContain("c.connectedEmail && c.connectedEmail !== c.name");
    expect(source).toContain("{c.connectedEmail}");
  });
});
