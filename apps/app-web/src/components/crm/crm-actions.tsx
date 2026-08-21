"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ArchiveRestore, Download, GitMerge, MoreHorizontal, Plus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createCrmRecord,
  downloadCrmCsv,
  fetchCrmDuplicates,
  fetchWorkspaceCrm,
  importCrmRecords,
  mergeCrmRecords,
  setCrmRecordArchived,
  undoCrmMerge,
  type CrmDuplicateGroup,
} from "@/lib/api/crm";
import {
  CRM_IMPORT_FIELDS,
  mapCrmCsvRows,
  parseCrmCsv,
  suggestedCrmCsvMapping,
  type CrmImportKind,
  type CsvPreview,
} from "@/lib/crm-r2";
import { useT } from "@/lib/i18n/client";

type DialogKind = "create" | "import" | "duplicates" | "archive" | null;

export function CrmActions({
  workspaceId,
  section,
  onChanged,
}: {
  workspaceId: string;
  section: "deals" | "contacts" | "companies";
  onChanged: () => void;
}) {
  const t = useT().crmPage.r2;
  const [dialog, setDialog] = useState<DialogKind>(null);

  async function exportCsv() {
    const blob = await downloadCrmCsv(workspaceId, section);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `crm-${section}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Button size="sm" onClick={() => setDialog("create")}>
        <Plus aria-hidden /> {t.newRecord}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="icon-sm" variant="ghost" aria-label={t.moreActions}><MoreHorizontal aria-hidden /></Button>}
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setDialog("import")}><Upload aria-hidden />{t.importCsv}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void exportCsv()}><Download aria-hidden />{t.exportCsv}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog("duplicates")}><GitMerge aria-hidden />{t.reviewDuplicates}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog("archive")}><ArchiveRestore aria-hidden />{t.archivedRecords}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateDialog
        workspaceId={workspaceId}
        open={dialog === "create"}
        initialKind={section === "contacts" ? "contact" : section === "companies" ? "company" : "deal"}
        onOpenChange={(open) => setDialog(open ? "create" : null)}
        onCreated={() => { setDialog(null); onChanged(); }}
      />
      <ImportDialog
        workspaceId={workspaceId}
        open={dialog === "import"}
        initialKind={section === "contacts" ? "contact" : section === "companies" ? "company" : "deal"}
        onOpenChange={(open) => setDialog(open ? "import" : null)}
        onImported={() => { setDialog(null); onChanged(); }}
      />
      <DuplicatesDialog
        workspaceId={workspaceId}
        open={dialog === "duplicates"}
        onOpenChange={(open) => setDialog(open ? "duplicates" : null)}
        onMerged={onChanged}
      />
      <ArchivedDialog
        workspaceId={workspaceId}
        open={dialog === "archive"}
        onOpenChange={(open) => setDialog(open ? "archive" : null)}
        onRestored={onChanged}
      />
    </>
  );
}

function Shell({ open, onOpenChange, title, description, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const t = useT().crmPage.r2;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl">
          <div className="flex items-start justify-between border-b border-border px-5 py-4">
            <div><Dialog.Title className="text-base font-semibold">{title}</Dialog.Title><Dialog.Description className="mt-1 text-xs text-muted-foreground">{description}</Dialog.Description></div>
            <Button size="icon-sm" variant="ghost" onClick={() => onOpenChange(false)} aria-label={t.close}><X aria-hidden /></Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CreateDialog({ workspaceId, open, initialKind, onOpenChange, onCreated }: {
  workspaceId: string;
  open: boolean;
  initialKind: CrmImportKind;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const t = useT().crmPage.r2;
  const [kind, setKind] = useState<CrmImportKind>(initialKind);
  const [name, setName] = useState("");
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setKind(initialKind);
  }, [open, initialKind]);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const record: Record<string, unknown> = { kind, name: name.trim() };
    if (kind === "contact") { record.email = primary.trim() || null; record.phone = secondary.trim() || null; }
    else if (kind === "company") record.domain = primary.trim() || null;
    else {
      const amount = Number(primary);
      if (primary.trim() && Number.isFinite(amount)) record.amount = amount;
      record.currencyCode = secondary.trim().toUpperCase() || "USD";
    }
    try {
      await createCrmRecord(workspaceId, record);
      setName(""); setPrimary(""); setSecondary("");
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.createFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell open={open} onOpenChange={onOpenChange} title={t.newRecord} description={t.newRecordDescription}>
      <div className="space-y-4">
        <Select value={kind} onValueChange={(value) => setKind(value as CrmImportKind)}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="contact">{t.kindContact}</SelectItem>
            <SelectItem value="company">{t.kindCompany}</SelectItem>
            <SelectItem value="deal">{t.kindDeal}</SelectItem>
          </SelectContent>
        </Select>
        <Input label={t.name} value={name} onChange={setName} autoFocus />
        {kind === "contact" && <><Input label={t.email} value={primary} onChange={setPrimary} /><Input label={t.phone} value={secondary} onChange={setSecondary} /></>}
        {kind === "company" && <Input label={t.domain} value={primary} onChange={setPrimary} />}
        {kind === "deal" && <><Input label={t.amount} value={primary} onChange={setPrimary} /><Input label={t.currency} value={secondary} onChange={setSecondary} placeholder="USD" /></>}
        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>{t.cancel}</Button><Button disabled={busy || !name.trim()} onClick={() => void submit()}>{busy ? t.saving : t.create}</Button></div>
      </div>
    </Shell>
  );
}

function ImportDialog({ workspaceId, open, initialKind, onOpenChange, onImported }: {
  workspaceId: string;
  open: boolean;
  initialKind: CrmImportKind;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const t = useT().crmPage.r2;
  const [kind, setKind] = useState<CrmImportKind>(initialKind);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<Record<number, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const mapped = useMemo(() => preview ? mapCrmCsvRows(preview, kind, mapping) : [], [preview, kind, mapping]);
  useEffect(() => {
    if (open) setKind(initialKind);
  }, [open, initialKind]);

  return (
    <Shell open={open} onOpenChange={onOpenChange} title={t.importCsv} description={t.importDescription}>
      <div className="space-y-4">
        <Select value={kind} onValueChange={(value) => { setKind(value as CrmImportKind); if (preview) setMapping(suggestedCrmCsvMapping(preview.headers, value as CrmImportKind)); }}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="contact">{t.kindContact}</SelectItem><SelectItem value="company">{t.kindCompany}</SelectItem><SelectItem value="deal">{t.kindDeal}</SelectItem></SelectContent>
        </Select>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label={t.pickCsv}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void file.text().then((source) => {
              const next = parseCrmCsv(source, 500);
              setPreview(next);
              setMapping(suggestedCrmCsvMapping(next.headers, kind));
              setResult(null);
            });
          }}
          className="block w-full rounded-lg border border-border p-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5"
        />
        {preview && (
          <>
            <div className="rounded-xl border border-border p-3">
              <div className="mb-2 text-xs font-medium">{t.mapColumns}</div>
              <div className="space-y-2">
                {preview.headers.map((header, index) => (
                  <div key={`${header}-${index}`} className="grid grid-cols-2 items-center gap-2 text-xs">
                    <span className="truncate text-muted-foreground">{header}</span>
                    <Select value={mapping[index] ?? "__skip__"} onValueChange={(value) => setMapping((current) => ({ ...current, [index]: value === "__skip__" ? null : value }))}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="__skip__">{t.skipColumn}</SelectItem>{CRM_IMPORT_FIELDS[kind].map((field) => <SelectItem key={field} value={field}>{field}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">{t.previewRows.replace("{count}", String(preview.rows.length))}{preview.truncated ? ` ${t.importCapped}` : ""}</div>
          </>
        )}
        {result && <div className="text-xs">{result}</div>}
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>{t.cancel}</Button><Button disabled={busy || mapped.length === 0 || !mapped.every((row) => typeof row.name === "string")} onClick={() => void (async () => {
          setBusy(true);
          try {
            const imported = await importCrmRecords(workspaceId, mapped);
            setResult(t.importResult.replace("{created}", String(imported.created)).replace("{failed}", String(imported.failed)));
            if (imported.failed === 0) onImported();
          } catch (cause) {
            setResult(cause instanceof Error ? cause.message : t.importFailed);
          } finally {
            setBusy(false);
          }
        })()}>{busy ? t.importing : t.importAction}</Button></div>
      </div>
    </Shell>
  );
}

function DuplicatesDialog({ workspaceId, open, onOpenChange, onMerged }: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: () => void;
}) {
  const t = useT().crmPage.r2;
  const [groups, setGroups] = useState<CrmDuplicateGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [lastMerge, setLastMerge] = useState<{ id: string; undoUntil: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || loaded) return;
    setLoaded(true);
    void fetchCrmDuplicates(workspaceId).then(setGroups).catch(() => setGroups([]));
  }, [open, loaded, workspaceId]);
  return (
    <Shell open={open} onOpenChange={(next) => { if (!next) setLoaded(false); onOpenChange(next); }} title={t.reviewDuplicates} description={t.duplicatesDescription}>
      <div className="space-y-3">
        {lastMerge && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
            <div className="text-xs">
              <div className="font-medium">{t.mergeComplete}</div>
              <div className="text-muted-foreground">{t.undoAvailableUntil.replace("{date}", new Date(lastMerge.undoUntil).toLocaleString())}</div>
            </div>
            <Button size="xs" variant="outline" onClick={() => void (async () => {
              setError(null);
              try {
                await undoCrmMerge(workspaceId, lastMerge.id);
                setLastMerge(null);
                setGroups(await fetchCrmDuplicates(workspaceId));
                onMerged();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : t.undoFailed);
              }
            })()}>{t.undoMerge}</Button>
          </div>
        )}
        {error && <div className="text-xs text-destructive">{error}</div>}
        {groups.map((group) => (
          <div key={`${group.kind}:${group.reason}:${group.value}`} className="rounded-xl border border-border p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t.duplicateReasons[group.reason]} · {group.value}</div>
            <div className="mt-2 space-y-1">{group.records.map((record, index) => <div key={record.id} className="flex items-center justify-between text-xs"><span>{record.name}</span>{index === 0 ? <span className="text-muted-foreground">{t.keepRecord}</span> : <Button size="xs" variant="outline" onClick={() => void (async () => {
              const confirmed = await confirmDialog({ title: t.mergeRecords, description: t.mergeDescription.replace("{merged}", record.name).replace("{survivor}", group.records[0].name), confirmLabel: t.merge, cancelLabel: t.cancel });
              if (!confirmed) return;
              setError(null);
              try {
                const merged = await mergeCrmRecords(workspaceId, group.records[0].id, record.id);
                setLastMerge({ id: merged.mergeId, undoUntil: merged.undoUntil });
                setGroups(await fetchCrmDuplicates(workspaceId));
                onMerged();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : t.mergeFailed);
              }
            })()}><GitMerge aria-hidden />{t.merge}</Button>}</div>)}</div>
          </div>
        ))}
        {loaded && groups.length === 0 && <div className="text-sm text-muted-foreground">{t.noDuplicates}</div>}
      </div>
    </Shell>
  );
}

function ArchivedDialog({ workspaceId, open, onOpenChange, onRestored }: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: () => void;
}) {
  const t = useT().crmPage.r2;
  const [rows, setRows] = useState<Array<{ id: string; name: string; kind: string }>>([]);
  useEffect(() => {
    if (!open) return;
    void fetchWorkspaceCrm(workspaceId, true).then((data) => {
      setRows([
        ...data.contacts.filter((row) => row.archivedAt).map((row) => ({ id: row.id, name: row.name, kind: t.kindContact })),
        ...data.companies.filter((row) => row.archivedAt).map((row) => ({ id: row.id, name: row.name, kind: t.kindCompany })),
        ...data.deals.filter((row) => row.archivedAt).map((row) => ({ id: row.id, name: row.name, kind: t.kindDeal })),
      ]);
    }).catch(() => setRows([]));
  }, [open, workspaceId, t]);
  return (
    <Shell open={open} onOpenChange={onOpenChange} title={t.archivedRecords} description={t.archivedDescription}>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div><div className="text-xs font-medium">{row.name}</div><div className="text-[10px] text-muted-foreground">{row.kind}</div></div>
            <Button size="xs" variant="outline" onClick={() => void setCrmRecordArchived(workspaceId, row.id, false).then(() => {
              setRows((current) => current.filter((item) => item.id !== row.id));
              onRestored();
            })}><ArchiveRestore aria-hidden />{t.restore}</Button>
          </div>
        ))}
        {rows.length === 0 && <div className="text-sm text-muted-foreground">{t.noArchived}</div>}
      </div>
    </Shell>
  );
}

function Input({ label, value, onChange, placeholder, autoFocus }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return <label className="block text-xs"><span className="mb-1 block text-muted-foreground">{label}</span><input autoFocus={autoFocus} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none" /></label>;
}
