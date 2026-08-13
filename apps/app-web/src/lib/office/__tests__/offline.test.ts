import { describe, expect, it } from "vitest";
import { applyOfficeCommand } from "@use-brian/office-model";
import { classifyOfficeReconnect, decryptOfficePackage, decryptOfflineJournalEntry, encryptOfficePackage, encryptOfflineJournalEntry, officeManifestHash } from "../offline";
import { presentationFixture } from "../../../components/office/__tests__/editor-fixtures";

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

  it("round-trips and replays an atomic presentation command batch", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const snapshot = presentationFixture();
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: "user" as const, id: "00000000-0000-4000-8000-000000000090" }, origin: "offline" as const };
    const entry = {
      artifactId: snapshot.artifactId,
      seq: 8,
      kind: "command" as const,
      expectedSeq: 7,
      createdAt: "2026-08-13T00:00:00.000Z",
      command: {
        ...common,
        commandId: "00000000-0000-4000-8000-000000000091",
        kind: "batch" as const,
        commands: [
          { ...common, commandId: "00000000-0000-4000-8000-000000000092", kind: "setObjectProperty" as const, targetId: snapshot.slides[0].objects[0].id, path: ["geometry", "xPt"], value: 120 },
          { ...common, commandId: "00000000-0000-4000-8000-000000000093", kind: "setObjectProperty" as const, targetId: snapshot.slides[0].objects[0].id, path: ["geometry", "yPt"], value: 140 },
        ],
      },
    };
    const encrypted = await encryptOfflineJournalEntry(entry, secret);
    const restored = await decryptOfflineJournalEntry(encrypted, secret);
    if (restored.kind !== "command") throw new Error("command journal fixture required");
    const next = applyOfficeCommand(snapshot, restored.command);
    expect(next.family === "presentation" && next.slides[0].objects[0].geometry).toMatchObject({ xPt: 120, yPt: 140 });
  });

  it("preserves an admitted image hash across the snapshot ref and encrypted package bytes", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const snapshot = presentationFixture();
    const resource = snapshot.resources[0];
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const hash = await digest(bytes);
    snapshot.resources = [{ ...resource, hash }];
    const update = new Uint8Array([7, 8, 9]);
    const renderedFallback = "<svg/>";
    const payload = {
      artifact: { artifactId: snapshot.artifactId, family: "presentation", title: snapshot.title, version: 4, lifecycleState: "active", role: "edit" },
      snapshot,
      seq: 4,
      baseVersion: 4,
      yjsUpdate: btoa(String.fromCharCode(...update)),
      comments: [], history: [], renderedFallback,
      resources: [{ id: resource.id, mime: resource.mime, hash, bytes: btoa(String.fromCharCode(...bytes)) }],
    };
    const manifest = { artifactId: snapshot.artifactId, version: 4, snapshotHash: await digest(JSON.stringify(snapshot)), updateHash: await digest(update), fallbackHash: await digest(renderedFallback), resourceHashes: [{ id: resource.id, hash }] };
    // The package hashes snapshots canonically; build through its public helper
    // so this fixture cannot accidentally depend on object key order.
    manifest.snapshotHash = await officeManifestHash(snapshot);
    const encrypted = await encryptOfficePackage({ artifactId: snapshot.artifactId, version: 4, manifest, payload, signature: "signed", pinned: true, deviceSecret: secret });
    const restored = await decryptOfficePackage<{ payload: typeof payload }>(encrypted, secret);
    expect(restored.payload.snapshot.resources[0].hash).toBe(hash);
    expect(restored.payload.resources[0].hash).toBe(hash);
    expect(await digest(Uint8Array.from(atob(restored.payload.resources[0].bytes), (character) => character.charCodeAt(0)))).toBe(hash);
  });

  it("keeps revocation and structural divergence recoverable", () => {
    expect(classifyOfficeReconnect({ status: "needs_attention", reason: "access_revoked", quarantine: true })).toEqual({ status: "needs_attention", quarantine: true, conflict: false });
    expect(classifyOfficeReconnect({ status: "needs_attention", reason: "structural_conflict" })).toEqual({ status: "needs_attention", quarantine: false, conflict: true });
    expect(classifyOfficeReconnect({ status: "synced" }).status).toBe("synced");
  });
});
