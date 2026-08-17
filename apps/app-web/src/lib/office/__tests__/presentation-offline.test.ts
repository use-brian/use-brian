import { describe, expect, it } from "vitest";
import type { OfficeCommand } from "@use-brian/office-model";
import { decryptOfflineJournalEntry, encryptOfflineJournalEntry } from "../offline";

describe("[COMP:app-web/office-offline] Presentation offline journal", () => {
  it("encrypts and restores a typed multi-object presentation command", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const artifactId = "10000000-0000-4000-8000-000000000001";
    const common = { artifactId, baseVersion: 4, actor: { type: "user" as const, id: "10000000-0000-4000-8000-000000000002" }, origin: "offline" as const };
    const command: OfficeCommand = {
      ...common,
      commandId: "10000000-0000-4000-8000-000000000003",
      kind: "batch",
      commands: [
        { ...common, commandId: "10000000-0000-4000-8000-000000000004", kind: "setObjectProperty", targetId: "10000000-0000-4000-8000-000000000005", path: ["geometry", "xPt"], value: 120 },
        { ...common, commandId: "10000000-0000-4000-8000-000000000006", kind: "setObjectProperty", targetId: "10000000-0000-4000-8000-000000000007", path: ["geometry", "xPt"], value: 240 },
      ],
    };
    const entry = { artifactId, seq: 9, kind: "command" as const, expectedSeq: 8, command, createdAt: "2026-08-13T00:00:00.000Z" };

    const encrypted = await encryptOfflineJournalEntry(entry, secret);
    expect(JSON.stringify(encrypted)).not.toContain(command.commandId);
    await expect(decryptOfflineJournalEntry(encrypted, secret)).resolves.toEqual(entry);
  });
});
