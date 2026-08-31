"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  downloadCrmOperationsPrivacyExport,
  listCrmEventDelivery,
  listCrmOperationsAudit,
  type CrmEventDeliveryEntry,
  type CrmOperationsAuditEntry,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";

export function CrmOperationsAuditView({ workspaceId }: { workspaceId: string }) {
  const t = useT().crmPage.operations;
  const [audit, setAudit] = useState<CrmOperationsAuditEntry[]>([]);
  const [events, setEvents] = useState<CrmEventDeliveryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextAudit, nextEvents] = await Promise.all([
      listCrmOperationsAudit(workspaceId),
      listCrmEventDelivery(workspaceId),
    ]);
    setAudit(nextAudit);
    setEvents(nextEvents);
    setError(null);
  }, [workspaceId]);

  useEffect(() => { void load().catch(() => setError(t.auditLoadFailed)); }, [load, t.auditLoadFailed]);

  async function downloadExport() {
    try {
      const blob = await downloadCrmOperationsPrivacyExport(workspaceId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `crm-operations-${workspaceId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t.privacyExportFailed);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-border p-3" data-crm-operations-audit>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold">{t.auditTitle}</h4>
          <p className="mt-1 text-[11px] text-muted-foreground">{t.auditDescription}</p>
        </div>
        <div className="flex gap-1">
          <Button size="icon-xs" variant="ghost" aria-label={t.refresh} onClick={() => void load()}><RefreshCw aria-hidden /></Button>
          <Button size="xs" variant="outline" onClick={() => void downloadExport()}><Download aria-hidden />{t.privacyExport}</Button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.auditChanges}</div>
          <div className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded-lg bg-muted/20 px-2">
            {audit.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-2 py-2 text-[11px]">
                <span className="min-w-0 truncate font-mono">{entry.action}</span>
                <span className="shrink-0 text-muted-foreground">{entry.actorKind}</span>
              </div>
            ))}
            {audit.length === 0 && <div className="py-3 text-xs text-muted-foreground">{t.auditEmpty}</div>}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.eventDelivery}</div>
          <div className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded-lg bg-muted/20 px-2">
            {events.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-2 py-2 text-[11px]">
                <span className="min-w-0 truncate font-mono">{entry.eventType}</span>
                <span className="shrink-0 text-muted-foreground">{entry.status} · {entry.attempts}</span>
              </div>
            ))}
            {events.length === 0 && <div className="py-3 text-xs text-muted-foreground">{t.eventDeliveryEmpty}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
