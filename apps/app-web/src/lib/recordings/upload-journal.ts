/** Restart-safe capture transfer checkpoints. [COMP:recordings/upload-journal] */
import { idbReadRequired, idbUpdate } from "@/lib/offline/idb";
import { currentOfflineWriteAuthority, sameOfflineWriteAuthority, pinOfflineWriteSession } from "@/lib/offline/application-write-authority";
export type UploadPlan = { uploadId: string; fileId: string; chunkSizeBytes: number; expiresAt: string;
  parts: Array<{ index: number; offset: number; sizeBytes: number; url: string }>; uploadHeaders?: Record<string, string> };
export type UploadCheckpoint = { plan?: UploadPlan; completing?: boolean; recordingId?: string };
export async function captureUploadJournal(workspaceId: string, id: string) {
  const owner = currentOfflineWriteAuthority(workspaceId);
  if (!owner) throw new Error("Capture owner unavailable");
  const key = `recording-upload:v1:${[owner.apiOrigin, owner.viewerId, workspaceId, id].map(encodeURIComponent).join(":")}`;
  const assertCurrent = () => { if (!sameOfflineWriteAuthority(owner, currentOfflineWriteAuthority(workspaceId))) throw new Error("Capture owner changed"); };
  const state = await idbReadRequired<UploadCheckpoint>(key) ?? {};
  assertCurrent();
  return { state, assertCurrent,
    session: () => pinOfflineWriteSession(owner),
    save: async (next: UploadCheckpoint) => { assertCurrent(); await idbUpdate(key, () => { assertCurrent(); return next; }); assertCurrent(); },
  };
}
