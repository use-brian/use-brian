import { describe, expect, it } from "vitest";
import { classifyOfficeReconnect, decryptOfficePackage, decryptOfflineJournalEntry, encryptOfficePackage, encryptOfflineJournalEntry, officeManifestHash } from "../offline";

const digest = async (value: Uint8Array | string) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe("[COMP:app-web/office-offline] Encrypted Office offline package", () => {
  it("encrypts with a device-bound key and rejects another device", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const artifactId = "10000000-0000-4000-8000-000000000001";
    const snapshot = { artifactId, title: "Plan" };
    const update = new Uint8Array([1, 2, 3]);
    const renderedFallback = "<svg/>";
    const payload = { artifact: { artifactId, family: "document", title: "Plan", version: 3, lifecycleState: "active", role: "edit" }, snapshot, yjsUpdate: btoa(String.fromCharCode(...update)), comments: [], history: [], renderedFallback, resources: [] };
    const manifest = { artifactId, version: 3, snapshotHash: await officeManifestHash(snapshot), updateHash: await digest(update), fallbackHash: await digest(renderedFallback), resourceHashes: [] };
    const encrypted = await encryptOfficePackage({ artifactId, version: 3, manifest, payload, signature: "signed", pinned: true, deviceSecret: secret });
    await expect(decryptOfficePackage<{ payload: { artifact: { title: string } } }>(encrypted, secret)).resolves.toMatchObject({ payload: { artifact: { title: "Plan" } } });
    await expect(decryptOfficePackage(encrypted, crypto.getRandomValues(new Uint8Array(32)))).rejects.toThrow();
  });

  it("encrypts journal operations before persistence", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const entry = { artifactId: "10000000-0000-4000-8000-000000000001", seq: 7, kind: "comment" as const, anchor: { kind: "block", targetIds: ["10000000-0000-4000-8000-000000000002"] }, body: "Queued privately", createdAt: "2026-08-05T00:00:00.000Z" };
    const encrypted = await encryptOfflineJournalEntry(entry, secret);
    expect(JSON.stringify(encrypted)).not.toContain(entry.body);
    await expect(decryptOfflineJournalEntry(encrypted, secret)).resolves.toEqual(entry);
  });

  it("keeps revocation and structural divergence recoverable", () => {
    expect(classifyOfficeReconnect({ status: "needs_attention", reason: "access_revoked", quarantine: true })).toEqual({ status: "needs_attention", quarantine: true, conflict: false });
    expect(classifyOfficeReconnect({ status: "needs_attention", reason: "structural_conflict" })).toEqual({ status: "needs_attention", quarantine: false, conflict: true });
    expect(classifyOfficeReconnect({ status: "synced" }).status).toBe("synced");
  });
});
