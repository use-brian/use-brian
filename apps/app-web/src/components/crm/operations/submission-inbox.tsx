"use client";

/** Addressable CRM submission review Inbox. [COMP:app-web/crm-operations] */

import { useCallback, useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  getCrmSubmission,
  listCrmSubmissions,
  updateCrmSubmission,
  type CrmSubmission,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";

export function CrmSubmissionInbox({
  workspaceId,
  selectedId,
  onSelect,
}: {
  workspaceId: string;
  selectedId: string | null;
  onSelect: (submissionId: string | null) => void;
}) {
  const t = useT().crmPage.operations;
  const [rows, setRows] = useState<CrmSubmission[]>([]);
  const [selected, setSelected] = useState<CrmSubmission | null>(null);
  const [status, setStatus] = useState<CrmSubmission["status"] | "all">("new");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await listCrmSubmissions(workspaceId, { status: status === "all" ? undefined : status });
      setRows(next);
      const nextId = selectedId && next.some((row) => row.id === selectedId) ? selectedId : next[0]?.id ?? null;
      if (nextId !== selectedId) onSelect(nextId);
    } catch { setError(t.submissionsLoadFailed); }
    finally { setLoading(false); }
  }, [workspaceId, status, selectedId, onSelect, t.submissionsLoadFailed]);

  useEffect(() => { void reload(); }, [workspaceId, status]);
  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    void getCrmSubmission(workspaceId, selectedId).then(setSelected).catch(() => setError(t.submissionsLoadFailed));
  }, [workspaceId, selectedId, t.submissionsLoadFailed]);

  async function update(changes: { status?: CrmSubmission["status"]; note?: string }) {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try {
      await updateCrmSubmission(workspaceId, selected.id, changes);
      setNote("");
      await reload();
      setSelected(await getCrmSubmission(workspaceId, selected.id));
    } catch { setError(t.submissionSaveFailed); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 max-md:flex-col" data-crm-submission-inbox>
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-border/60 max-md:max-h-[45%] max-md:w-full max-md:border-b max-md:border-r-0">
        <div className="sticky top-0 z-10 border-b border-border/60 bg-background p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Inbox className="size-4" aria-hidden />{t.submissions}</div>
          <Select value={status} onValueChange={(value) => setStatus((value ?? "new") as typeof status)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t.allStatuses}</SelectItem>{(["new", "in_progress", "resolved", "spam"] as const).map((item) => <SelectItem key={item} value={item}>{t.submissionStatusLabels[item]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {error && <div className="p-3 text-xs text-destructive">{error}</div>}
        {loading ? <div className="p-3 text-xs text-muted-foreground">{t.loading}</div> : rows.length === 0 ? <div className="p-3 text-xs text-muted-foreground">{t.noSubmissions}</div> : rows.map((row) => <button type="button" key={row.id} className={`block w-full border-b border-border/40 px-3 py-3 text-left text-xs ${row.id === selectedId ? "bg-accent" : "hover:bg-accent/50"}`} onClick={() => onSelect(row.id)}><div className="font-medium">{row.contactName}</div><div className="mt-1 text-muted-foreground">{row.definitionLabel ?? row.definitionKey ?? t.legacySubmission} · {t.submissionStatusLabels[row.status]}</div><time className="mt-1 block text-[10px] text-muted-foreground" dateTime={row.submittedAt}>{new Date(row.submittedAt).toLocaleString()}</time></button>)}
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-5">
        {!selected ? <div className="text-sm text-muted-foreground">{t.pickSubmission}</div> : <>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{selected.contactName}</h2><div className="text-xs text-muted-foreground">{selected.definitionLabel ?? selected.definitionKey ?? t.legacySubmission}</div></div><Select value={selected.status} onValueChange={(value) => value && void update({ status: value as CrmSubmission["status"] })}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent>{(["new", "in_progress", "resolved", "spam"] as const).map((item) => <SelectItem key={item} value={item}>{t.submissionStatusLabels[item]}</SelectItem>)}</SelectContent></Select></div>
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">{t.queue}</dt><dd>{selected.queueKey}</dd></div><div><dt className="text-xs text-muted-foreground">{t.followUpTask}</dt><dd className="font-mono text-xs">{selected.followUpTaskId ?? t.none}</dd></div></dl>
          <div className="mt-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t.submittedFields}</h3><div className="mt-2 space-y-2">{Object.entries(selected.fields ?? {}).map(([key, value]) => <div key={key} className="rounded-lg bg-muted/30 px-3 py-2 text-xs"><div className="font-mono text-[10px] text-muted-foreground">{key}</div><div className="mt-1 whitespace-pre-wrap break-words">{typeof value === "string" ? value : JSON.stringify(value)}</div></div>)}</div></div>
          <div className="mt-5"><label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.addNote}</span><textarea rows={3} className="w-full rounded-md border border-input bg-transparent px-3 py-2" value={note} onChange={(event) => setNote(event.target.value)} /></label><Button className="mt-2" size="sm" disabled={busy || !note.trim()} onClick={() => void update({ note: note.trim() })}>{t.saveNote}</Button></div>
          {selected.notes?.length ? <div className="mt-5 space-y-2">{selected.notes.map((item) => <div key={item.id} className="rounded-lg border border-border/60 p-3 text-xs"><div>{item.body}</div><time className="mt-1 block text-[10px] text-muted-foreground" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></div>)}</div> : null}
        </>}
      </main>
    </div>
  );
}
