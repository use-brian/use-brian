"use client";
/** Explicit resolution preserves both authored versions. [COMP:app-web/metadata-conflicts] */
import { useEffect, useState } from "react";
import { readPendingWrites, resolveMetadataConflict, subscribePendingCount } from "@/lib/offline/offline-writes";
import { pinOfflineWriteSession } from "@/lib/offline/application-write-authority";
import type { QueuedWrite } from "@/lib/offline/write-queue";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
export function MetadataConflicts() {
  const t = useT().docPage;
  const [rows, setRows] = useState<QueuedWrite[]>([]);
  const [remote, setRemote] = useState<Record<string, { name: string; value: unknown }>>({});
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const load = () => { const current = ++generation; void readPendingWrites().then(async values => {
      if (!alive || current !== generation) return;
      const conflicts = values.filter(row => row.conflict); setRows(conflicts); setRemote({});
      for (const row of conflicts) try {
        if (!row.authority) continue;
        const session = await pinOfflineWriteSession(row.authority);
        const pageId = (row.payload as { id: string }).id;
        const response = await session.request(`/api/views/${encodeURIComponent(pageId)}`);
        if (!response.ok) continue;
        const page = await response.json(); session.assertCurrent();
        const field = row.base?.field ?? (row.kind === "view.rename" ? "name" : row.kind.slice(5));
        if (alive && current === generation && page.id === pageId && page.workspaceId === row.authority.workspaceId) {
          setRemote(before => ({ ...before, [row.id]: { name: page.name, value: page[field] } }));
        }
      } catch { /* Retain the authored version until fresh comparison is available. */ }
    }); };
    const unsubscribe = subscribePendingCount(load); load();
    return () => { alive = false; unsubscribe(); };
  }, []);
  async function resolve(id: string, choice: "local" | "remote") {
    setBusy(true); setFailed(false);
    try { await resolveMetadataConflict(id, choice); } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return <>{rows.map(row => <div key={row.id} className="space-y-2 border-t pt-2">
    <p>{t.metadataConflict}</p>
    {remote[row.id] && <p className="font-medium">{remote[row.id].name}</p>}
    <p className="break-words text-muted-foreground">{t.localMetadataValue}: {String(Object.values(row.payload as Record<string, unknown>).filter(value => value !== (row.payload as { id: string }).id).join(", "))}</p>
    <p className="break-words text-muted-foreground">{t.remoteMetadataValue}: {remote[row.id] ? String(remote[row.id].value ?? "") : t.metadataConflictRetry}</p>
    <div className="flex flex-wrap gap-2">
      <Button className="min-h-8 max-sm:min-h-11" disabled={busy || !remote[row.id]} onClick={() => void resolve(row.id, "local")}>{t.keepLocalMetadata}</Button>
      <Button className="min-h-8 max-sm:min-h-11" disabled={busy || !remote[row.id]} onClick={() => void resolve(row.id, "remote")}>{t.keepRemoteMetadata}</Button>
    </div>
  </div>)}{failed && <p role="status">{t.metadataConflictRetry}</p>}</>;
}
