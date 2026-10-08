"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Archive, ArchiveRestore, Download, GitMerge, MoreHorizontal, Plus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { canSelectCrmMergePair, crmDuplicatePairs, selectCrmMergePairs, type CrmMergePair } from "@/lib/crm-duplicate-selection";
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
  fetchCrmCreationDestination,
  type CrmCreationDestination,
  type CrmCreationPreview,
  createCrmField,
  downloadCrmCsv,
  fetchCrmDuplicates,
  fetchCrmSeparations,
  fetchWorkspaceCrm,
  keepCrmRecordsSeparate,
  mergeCrmRecords,
  reviewCrmSeparationAgain,
  setCrmRecordArchived,
  undoCrmMerge,
  type CrmConfig,
  type CrmData,
  type CrmDuplicateGroup,
  type CrmSeparation,
  type CrmFieldDefinition,
  type CrmFieldType,
} from "@/lib/api/crm";
import {
  CRM_IMPORT_FIELDS,
  crmFieldKeyFromLabel,
  parseCrmCsv,
  suggestedCrmCsvMapping,
  type CrmImportKind,
  type CsvPreview,
} from "@/lib/crm-r2";
import { useT } from "@/lib/i18n/client";
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import { isPhoneViewport } from "@/lib/viewport";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CrmProductionImportPanel } from "@/components/crm/operations/import-panel";

export type CrmActionDialog = "create" | "import" | "duplicates" | "archive" | null;

export function CrmActions({
  workspaceId,
  section,
  data,
  config,
  onChanged,
  onCreated,
  role,
  mobileMenu = false,
  dialogsOnly = false,
  renderDialogs = true,
  activeDialog,
  onDialogChange,
}: {
  workspaceId: string;
  section: "deals" | "contacts" | "companies";
  data: CrmData | null;
  config: CrmConfig | null;
  onChanged: () => void;
  onCreated: (created: { id: string; kind: "deal" | "contact" | "company" }) => void | Promise<void>;
  role: string | null | undefined;
  /** Render action items inside the surface's one narrow-screen menu. */
  mobileMenu?: boolean;
  /** Render the dialogs beside a menu whose popup unmounts when closed. */
  dialogsOnly?: boolean;
  /** Keep dialogs outside an unmounting dropdown popup. */
  renderDialogs?: boolean;
  activeDialog?: CrmActionDialog;
  onDialogChange?: (dialog: CrmActionDialog) => void;
}) {
  const t = useT().crmPage.r2;
  const [localDialog, setLocalDialog] = useState<CrmActionDialog>(null);
  const dialog = activeDialog === undefined ? localDialog : activeDialog;
  const setDialog = (next: CrmActionDialog) => {
    if (activeDialog === undefined) setLocalDialog(next);
    onDialogChange?.(next);
  };

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
      {!dialogsOnly && (mobileMenu ? <>
        <DropdownMenuItem disabled={!data} onClick={() => setDialog("create")}><Plus aria-hidden />{t.newRecord}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setDialog("import")}><Upload aria-hidden />{t.importCsv}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void exportCsv()}><Download aria-hidden />{t.exportCsv}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setDialog("duplicates")}><GitMerge aria-hidden />{t.reviewDuplicates}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setDialog("archive")}><ArchiveRestore aria-hidden />{t.archivedRecords}</DropdownMenuItem>
      </> : <>
        <Button size="sm" disabled={!data} onClick={() => setDialog("create")}>
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
      </>)}

      {renderDialogs && <><CreateDialog
        workspaceId={workspaceId}
        data={data}
        config={config}
        open={dialog === "create"}
        initialKind={section === "contacts" ? "contact" : section === "companies" ? "company" : "deal"}
        onOpenChange={(open) => setDialog(open ? "create" : null)}
        onCreated={(created) => {
          setDialog(null);
          onChanged();
          void onCreated(created);
        }}
      />
      <ImportDialog
        workspaceId={workspaceId}
        config={config}
        canCreateField={role === "owner" || role === "admin"}
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
      </>}
    </>
  );
}

function Shell({ open, onOpenChange, title, description, children, busy = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: React.ReactNode;
  busy?: boolean;
}) {
  const t = useT().crmPage.r2;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        {/* Full-screen below `sm` (the settings-modal shape, responsive
            contract M5): a floating card with the iOS keyboard open left its
            lower third, Create included, under the keyboard. */}
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex h-[100dvh] w-full max-w-none -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-none border border-border bg-background shadow-xl sm:h-auto sm:max-h-[85dvh] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:rounded-2xl">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div><Dialog.Title className="text-base font-semibold">{title}</Dialog.Title><Dialog.Description className="mt-1 text-xs text-muted-foreground">{description}</Dialog.Description></div>
            <Button size="icon-sm" variant="ghost" className="max-sm:size-11" disabled={busy} onClick={() => onOpenChange(false)} aria-label={t.close}><X aria-hidden /></Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CreateDialog({ workspaceId, data, config, open, initialKind, onOpenChange, onCreated }: {
  workspaceId: string;
  data: CrmData | null;
  config: CrmConfig | null;
  open: boolean;
  initialKind: CrmImportKind;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: { id: string; kind: "deal" | "contact" | "company" }) => void;
}) {
  const copy = useT();
  const t = copy.crmPage.r2;
  const [destination, setDestination] = useState<CrmCreationDestination | null>(null);
  const [preview, setPreview] = useState<CrmCreationPreview | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    const invalidate = () => { current = false; setDestination(null); setPreview(null); setPreviewError(true); };
    setDestination(null); setPreview(null); setPreviewError(false);
    if (open) void fetchCrmCreationDestination(workspaceId).then(value => {
      if (!current) return;
      const remaining = 30_000 - (performance.now() - started);
      if (remaining <= 0) { invalidate(); return; }
      setPreview(value); setDestination(value.defaultDestination);
      timer = setTimeout(invalidate, remaining);
    }).catch(() => { if (current) setPreviewError(true); });
    window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT, invalidate);
    window.addEventListener("brian:organization-changed", invalidate);
    return () => {
      current = false; clearTimeout(timer);
      window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT, invalidate);
      window.removeEventListener("brian:organization-changed", invalidate);
    };
  }, [open, workspaceId, previewAttempt]);
  const tiers = ["public", "internal", "confidential"] as const;
  const ceiling = destination?.departmentId
    ? preview?.departments.find(row => row.id === destination.departmentId)?.clearance
    : preview?.generalClearance;

  const [kind, setKind] = useState<CrmImportKind>(initialKind);
  const [name, setName] = useState("");
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [contactId, setContactId] = useState("");
  const [pipelineStageId, setPipelineStageId] = useState("");
  const [closeDate, setCloseDate] = useState("");
  const [source, setSource] = useState("");
  const [tags, setTags] = useState("");
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setName("");
    setPrimary("");
    setSecondary("");
    setCompanyId("");
    setContactId("");
    setPipelineStageId(
      config?.pipelines.find((pipeline) => pipeline.isDefault)?.stages[0]?.id ??
        config?.pipelines[0]?.stages[0]?.id ??
        "",
    );
    setCloseDate("");
    setSource("");
    setTags("");
    setCustomFields({});
    setError(null);
  }, [open, initialKind, config]);

  const fields = (config?.fields ?? []).filter(
    (field) => field.entityKind === (kind === "contact" ? "person" : kind),
  );

  async function submit() {
    if (!name.trim() || !destination || !preview) return;
    setBusy(true);
    setError(null);
    const record: Record<string, unknown> = { kind, name: name.trim(), destination };
    if (kind === "contact") {
      record.email = primary.trim() || null;
      record.phone = secondary.trim() || null;
      record.companyId = companyId || null;
      record.tags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    }
    else if (kind === "company") {
      record.domain = primary.trim() || null;
      record.tags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    }
    else {
      const amount = Number(primary);
      if (primary.trim() && Number.isFinite(amount)) record.amount = amount;
      record.currencyCode = secondary.trim().toUpperCase() || "USD";
      record.companyId = companyId || null;
      record.contactId = contactId || null;
      record.pipelineStageId = pipelineStageId || undefined;
      record.closeDate = closeDate || null;
      record.source = source.trim() || null;
    }
    if (Object.keys(customFields).length > 0) record.customFields = customFields;
    try {
      const created = await createCrmRecord(workspaceId, record);
      const createdKind = created.kind === "person" ? "contact" : created.kind;
      if (createdKind === "deal" || createdKind === "contact" || createdKind === "company") {
        onCreated({ id: created.id, kind: createdKind });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.createFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell open={open} onOpenChange={onOpenChange} title={t.newRecord} description={t.newRecordDescription}>
      <div className="space-y-4">
        <Select value={kind} onValueChange={(value) => {
          setKind(value as CrmImportKind);
          setPrimary("");
          setSecondary("");
          setCompanyId("");
          setContactId("");
          setCloseDate("");
          setSource("");
          setTags("");
          setCustomFields({});
        }}>
          <SelectTrigger className="w-full max-sm:min-h-11"><SelectValue>{kind === "contact" ? t.kindContact : kind === "company" ? t.kindCompany : t.kindDeal}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value="contact">{t.kindContact}</SelectItem>
            <SelectItem value="company">{t.kindCompany}</SelectItem>
            <SelectItem value="deal">{t.kindDeal}</SelectItem>
          </SelectContent>
        </Select>
        {preview && destination ? <div className="space-y-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs">{copy.contextScope.team}
              <SearchableSelect className="max-sm:min-h-11" value={destination.departmentId ?? "__general__"}
                items={[{ value: "__general__", label: copy.contextScope.general }, ...preview.departments.map(row => ({ value: row.id, label: row.name }))]}
                onValueChange={value => { const departmentId = value === "__general__" ? null : value;
                  const cap = departmentId ? preview.departments.find(row => row.id === departmentId)!.clearance : preview.generalClearance;
                  setDestination({ departmentId, sensitivity: tiers[Math.min(tiers.indexOf(destination.sensitivity), tiers.indexOf(cap))] }); }} />
            </label>
            <label className="grid gap-1.5 text-xs">{copy.manage.sensitivity.titlePrefix}
              <SearchableSelect className="max-sm:min-h-11" value={destination.sensitivity}
                items={tiers.slice(0, tiers.indexOf(ceiling ?? "public") + 1).map(tier => ({ value: tier, label: copy.manage.sensitivity[tier] }))}
                onValueChange={value => setDestination({ ...destination, sensitivity: value as CrmCreationDestination["sensitivity"] })} />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t.creationDestinationHint}</p>
        </div> : previewError ? <div role="alert" className="space-y-2"><p>{copy.contextScope.loadFailed}</p><Button variant="outline" onClick={() => setPreviewAttempt(value => value + 1)}>{copy.contextScope.retryProjects}</Button></div>
          : <p role="status">{copy.contextScope.loading}</p>}
        <Input label={t.name} value={name} onChange={setName} autoFocus />
        {kind === "contact" && <><Input label={t.email} value={primary} onChange={setPrimary} /><Input label={t.phone} value={secondary} onChange={setSecondary} /><RelationshipSelect allowClear label={t.company} value={companyId} placeholder={t.noCompany} items={(data?.companies ?? []).map((row) => ({ value: row.id, label: row.name }))} onChange={setCompanyId} /><Input label={t.tags} value={tags} onChange={setTags} placeholder={t.tagsPlaceholder} /></>}
        {kind === "company" && <><Input label={t.domain} value={primary} onChange={setPrimary} /><Input label={t.tags} value={tags} onChange={setTags} placeholder={t.tagsPlaceholder} /></>}
        {kind === "deal" && <>
          <div className="grid gap-4 sm:grid-cols-2"><Input label={t.amount} type="number" value={primary} onChange={setPrimary} /><Input label={t.currency} value={secondary} onChange={setSecondary} placeholder="USD" /></div>
          <RelationshipSelect label={t.pipelineStage} value={pipelineStageId} placeholder={t.pickStage} items={(config?.pipelines ?? []).flatMap((pipeline) => pipeline.stages.map((stage) => ({ value: stage.id, label: `${pipeline.name}: ${stage.name}` })))} onChange={setPipelineStageId} />
          <div className="grid gap-4 sm:grid-cols-2"><RelationshipSelect allowClear label={t.company} value={companyId} placeholder={t.noCompany} items={(data?.companies ?? []).map((row) => ({ value: row.id, label: row.name }))} onChange={setCompanyId} /><RelationshipSelect allowClear label={t.contact} value={contactId} placeholder={t.noContact} items={(data?.contacts ?? []).map((row) => ({ value: row.id, label: row.name }))} onChange={setContactId} /></div>
          <div className="grid gap-4 sm:grid-cols-2"><Input label={t.closeDate} type="date" value={closeDate} onChange={setCloseDate} /><Input label={t.source} value={source} onChange={setSource} /></div>
        </>}
        {fields.length > 0 && (
          <div className="space-y-3 rounded-xl border border-border p-3">
            <div className="text-xs font-medium">{t.customFields}</div>
            {fields.map((field) => (
              <CreateField key={field.id} field={field} data={data} value={customFields[field.fieldKey]} onChange={(value) => setCustomFields((current) => ({ ...current, [field.fieldKey]: value }))} />
            ))}
          </div>
        )}
        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>{t.cancel}</Button><Button disabled={busy || !name.trim() || !destination || !preview} onClick={() => void submit()}>{busy ? t.saving : t.create}</Button></div>
      </div>
    </Shell>
  );
}

function ImportDialog({ workspaceId, config, canCreateField, open, initialKind, onOpenChange, onImported }: {
  workspaceId: string;
  config: CrmConfig | null;
  canCreateField: boolean;
  open: boolean;
  initialKind: CrmImportKind;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const t = useT().crmPage.r2;
  const [kind, setKind] = useState<CrmImportKind>(initialKind);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<Record<number, string | null>>({});
  const [fields, setFields] = useState<CrmFieldDefinition[]>(config?.fields ?? []);
  const [createColumn, setCreateColumn] = useState<number | null>(null);
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const [newFieldType, setNewFieldType] = useState<CrmFieldType>("text");
  const [newFieldOptions, setNewFieldOptions] = useState("");
  const [newReferenceKinds, setNewReferenceKinds] = useState<Array<"person" | "company" | "deal">>(["company"]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const entityKind = kind === "contact" ? "person" : kind;
  const availableFields = fields.filter((field) => field.entityKind === entityKind);
  const importLabels: Record<string, string> = {
    name: t.name,
    email: t.email,
    phone: t.phone,
    companyId: t.company,
    contactId: t.contact,
    tags: t.tags,
    domain: t.domain,
    stage: t.pipelineStage,
    amount: t.amount,
    currencyCode: t.currency,
    closeDate: t.closeDate,
    source: t.source,
  };
  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setFields(config?.fields ?? []);
    setCreateColumn(null);
    setFile(null);
    setPreview(null);
    setMapping({});
    setResult(null);
  }, [open, initialKind, config]);

  async function createMappedField() {
    if (createColumn === null || !newFieldLabel.trim()) return;
    const fieldKey = crmFieldKeyFromLabel(newFieldLabel);
    const options = newFieldType === "entity_reference"
      ? newReferenceKinds
      : newFieldType === "single_select" || newFieldType === "multi_select"
        ? newFieldOptions.split(",").map((option) => option.trim()).filter(Boolean)
        : [];
    if (!fieldKey || ((newFieldType === "single_select" || newFieldType === "multi_select" || newFieldType === "entity_reference") && options.length === 0)) return;
    setBusy(true);
    setResult(null);
    try {
      const created = await createCrmField(workspaceId, {
        entityKind,
        fieldKey,
        label: newFieldLabel.trim(),
        fieldType: newFieldType,
        options,
      });
      setFields((current) => [...current, created]);
      setMapping((current) => ({ ...current, [createColumn]: `custom:${created.fieldKey}` }));
      setCreateColumn(null);
      setNewFieldLabel("");
      setNewFieldOptions("");
      setNewFieldType("text");
    } catch (cause) {
      setResult(cause instanceof Error ? cause.message : t.configFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell open={open} onOpenChange={onOpenChange} title={t.importCsv} description={t.importDescription}>
      <div className="space-y-4">
        <Select value={kind} onValueChange={(value) => { const nextKind = value as CrmImportKind; setKind(nextKind); setCreateColumn(null); if (preview) setMapping(suggestedCrmCsvMapping(preview.headers, nextKind, fields)); }}>
          <SelectTrigger className="max-sm:min-h-11"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="contact">{t.kindContact}</SelectItem><SelectItem value="company">{t.kindCompany}</SelectItem><SelectItem value="deal">{t.kindDeal}</SelectItem></SelectContent>
        </Select>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label={t.pickCsv}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setFile(file);
            void file.text().then((source) => {
              const next = parseCrmCsv(source, 50);
              setPreview(next);
              setMapping(suggestedCrmCsvMapping(next.headers, kind, fields));
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
                    <Select value={mapping[index] ?? "__skip__"} onValueChange={(value) => {
                      if (value === "__create__") {
                        setCreateColumn(index);
                        setNewFieldLabel(header);
                        return;
                      }
                      setCreateColumn(null);
                      setMapping((current) => ({ ...current, [index]: value === "__skip__" ? null : value }));
                    }}>
                      <SelectTrigger className="w-full max-sm:min-h-11"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__skip__">{t.skipColumn}</SelectItem>
                        {CRM_IMPORT_FIELDS[kind].map((field) => <SelectItem key={field} value={field}>{importLabels[field] ?? field}</SelectItem>)}
                        {availableFields.map((field) => <SelectItem key={field.id} value={`custom:${field.fieldKey}`}>{field.label}</SelectItem>)}
                        {canCreateField && <SelectItem value="__create__">{t.createFieldFromColumn}</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {createColumn !== null && (
                <div className="mt-3 space-y-3 border-l-2 border-border pl-3">
                  <div className="text-xs font-medium">{t.createFieldFromColumn}</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input label={t.fieldLabel} value={newFieldLabel} onChange={setNewFieldLabel} />
                    <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.fieldType}</span>
                      <Select value={newFieldType} onValueChange={(value) => setNewFieldType(value as CrmFieldType)}>
                        <SelectTrigger className="w-full max-sm:min-h-11"><SelectValue /></SelectTrigger>
                        <SelectContent>{(["text", "number", "date", "boolean", "single_select", "multi_select", "entity_reference"] as CrmFieldType[]).map((type) => <SelectItem key={type} value={type}>{t.fieldTypes[type]}</SelectItem>)}</SelectContent>
                      </Select>
                    </label>
                  </div>
                  {(newFieldType === "single_select" || newFieldType === "multi_select") && <Input label={t.fieldOptions} value={newFieldOptions} onChange={setNewFieldOptions} placeholder={t.fieldOptionsPlaceholder} />}
                  {newFieldType === "entity_reference" && (
                    <div className="space-y-1"><div className="text-xs text-muted-foreground">{t.referenceTargets}</div><div className="flex flex-wrap gap-2">{(["person", "company", "deal"] as const).map((target) => <Button key={target} size="xs" variant={newReferenceKinds.includes(target) ? "default" : "outline"} onClick={() => setNewReferenceKinds((current) => current.includes(target) ? current.filter((item) => item !== target) : [...current, target])}>{target === "person" ? t.kindContact : target === "company" ? t.kindCompany : t.kindDeal}</Button>)}</div></div>
                  )}
                  <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setCreateColumn(null)}>{t.cancel}</Button><Button size="sm" disabled={busy || !newFieldLabel.trim()} onClick={() => void createMappedField()}>{busy ? t.saving : t.addField}</Button></div>
                </div>
              )}
            </div>
            {preview.rows.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-max text-left text-[11px]">
                  <thead className="bg-muted/30 text-muted-foreground"><tr>{preview.headers.map((header, index) => <th key={`${header}-${index}`} className="px-2.5 py-2 font-medium">{header}</th>)}</tr></thead>
                  <tbody>{preview.rows.slice(0, 3).map((row, rowIndex) => <tr key={rowIndex} className="border-t border-border/60">{preview.headers.map((_, index) => <td key={index} className="max-w-48 truncate px-2.5 py-2">{row[index] ?? ""}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
            <div className="text-xs text-muted-foreground">{t.previewRows.replace("{count}", String(preview.rows.length))}{preview.truncated ? ` ${t.importPreviewOnly}` : ""}</div>
          </>
        )}
        {result && <div className="text-xs">{result}</div>}
        <div className="flex justify-end"><Button variant="outline" onClick={() => onOpenChange(false)}>{t.cancel}</Button></div>
        <CrmProductionImportPanel
          workspaceId={workspaceId}
          file={file}
          kind={kind}
          mapping={mapping}
          ready={!!preview && Object.values(mapping).includes("name")}
          onImported={onImported}
        />
      </div>
    </Shell>
  );
}

export function DuplicatesDialog(props: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: () => void;
}) {
  // Selection and Undo receipts must never cross workspace boundaries.
  return <DuplicateReview key={props.workspaceId} {...props} />;
}

function DuplicateReview({ workspaceId, open, onOpenChange, onMerged }: Parameters<typeof DuplicatesDialog>[0]) {
  const t = useT().crmPage.r2;
  const [groups, setGroups] = useState<CrmDuplicateGroup[]>([]);
  const [separations, setSeparations] = useState<CrmSeparation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [receipts, setReceipts] = useState<Array<{ id: string; undoUntil: string }>>([]);
  const [lastSeparation, setLastSeparation] = useState<CrmSeparation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const operation = useRef(false);
  const mounted = useRef(true);
  const readVersion = useRef(0);
  const pairs = useMemo(() => crmDuplicatePairs(groups), [groups]);
  const selectedPairs = pairs.filter((pair) => selected.has(pair.key));
  const allCompatible = selectCrmMergePairs(selectedPairs, pairs, separations);
  const disabled = busy || loading || needsRefresh;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readVersion.current++; };
  }, []);

  async function refreshCandidates() {
    const version = ++readVersion.current;
    setLoading(true);
    setNeedsRefresh(true);
    try {
      const [nextGroups, nextSeparations] = await Promise.all([
        fetchCrmDuplicates(workspaceId), fetchCrmSeparations(workspaceId),
      ]);
      if (!mounted.current || version !== readVersion.current) return;
      setGroups(nextGroups);
      setSeparations(nextSeparations);
      setSelected(new Set());
      setNeedsRefresh(false);
      setLoaded(true);
    } catch (cause) {
      if (mounted.current && version === readVersion.current) {
        setError(cause instanceof Error ? cause.message : t.duplicatesLoadFailed);
      }
    } finally {
      if (mounted.current && version === readVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      setError(null);
      void refreshCandidates();
    }
    return () => { readVersion.current++; };
    // Reads are explicitly refreshed on open and after a mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function begin() {
    if (operation.current) return false;
    operation.current = true;
    setBusy(true);
    setError(null);
    return true;
  }

  function finish() {
    operation.current = false;
    if (mounted.current) setBusy(false);
  }

  function choose(candidates: CrmMergePair[], include: boolean) {
    if (disabled) return;
    const next = include
      ? selectCrmMergePairs(selectedPairs, candidates, separations)
      : selectedPairs.filter((pair) => !candidates.some((candidate) => candidate.key === pair.key));
    setSelected(new Set(next.map((pair) => pair.key)));
  }

  async function mergeSelection(requested: CrmMergePair[]) {
    const plan = selectCrmMergePairs([], requested, separations);
    if (disabled || plan.length === 0 || !begin()) return;
    let completed = 0;
    try {
      const kept = new Map<string, { name: string; count: number }>();
      for (const pair of plan) {
        const summary = kept.get(pair.survivor.id) ?? { name: pair.survivor.name, count: 0 };
        summary.count++;
        kept.set(pair.survivor.id, summary);
      }
      const confirmed = await confirmDialog({
        title: t.mergeRecords,
        description: t.bulkMergeDescription.replace("{count}", String(plan.length)),
        confirmLabel: t.mergeSelected.replace("{count}", String(plan.length)),
        cancelLabel: t.cancel,
        content: <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">{[...kept].map(([id, summary]) => (
          <li key={id}>{t.bulkKeepSummary.replace("{name}", summary.name).replace("{count}", String(summary.count))}</li>
        ))}</ul>,
      });
      if (!confirmed || !mounted.current) return;
      setSelected(new Set());
      setStatus(t.bulkMergeProgress.replace("{count}", "0").replace("{total}", String(plan.length)));
      for (const pair of plan) {
        if (!mounted.current) break;
        const result = await mergeCrmRecords(workspaceId, pair.survivor.id, pair.duplicate.id);
        completed++;
        if (!mounted.current) break;
        setReceipts((previous) => [...previous, { id: result.mergeId, undoUntil: result.undoUntil }]);
        setGroups((previous) => previous.map((group) => ({ ...group,
          records: group.records.filter((record) => record.id !== pair.duplicate.id),
        })).filter((group) => group.records.length > 1));
        setStatus(t.bulkMergeProgress.replace("{count}", String(completed)).replace("{total}", String(plan.length)));
      }
      if (mounted.current) await refreshCandidates();
    } catch (cause) {
      if (mounted.current) {
        setNeedsRefresh(true);
        setError(`${t.bulkMergeStopped} ${cause instanceof Error ? cause.message : t.mergeFailed}`);
      }
    } finally {
      if (mounted.current && completed > 0) onMerged();
      finish();
    }
  }

  async function undoCompleted(all: boolean) {
    if (receipts.length === 0 || !begin()) return;
    const plan = (all ? receipts : receipts.slice(-1)).slice().reverse();
    let completed = 0;
    try {
      for (const receipt of plan) {
        if (!mounted.current) break;
        await undoCrmMerge(workspaceId, receipt.id);
        completed++;
        if (!mounted.current) break;
        setReceipts((previous) => previous.filter((item) => item.id !== receipt.id));
        setStatus(t.bulkUndoProgress.replace("{count}", String(completed)).replace("{total}", String(plan.length)));
      }
      if (mounted.current) await refreshCandidates();
    } catch (cause) {
      if (mounted.current) {
        setNeedsRefresh(true);
        setError(cause instanceof Error ? cause.message : t.undoFailed);
      }
    } finally {
      if (mounted.current && completed > 0) onMerged();
      finish();
    }
  }

  async function keepSeparate(pair: CrmMergePair) {
    if (disabled || !begin()) return;
    try {
      const kept = await keepCrmRecordsSeparate(workspaceId, pair.survivor.id, pair.duplicate.id);
      if (mounted.current) {
        setLastSeparation(kept.separation);
        await refreshCandidates();
      }
    } catch (cause) {
      if (mounted.current) { setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : t.keepSeparateFailed); }
    } finally { finish(); }
  }

  async function reviewAgain(id: string) {
    if (disabled || !begin()) return;
    try {
      await reviewCrmSeparationAgain(workspaceId, id);
      if (mounted.current) { setLastSeparation(null); await refreshCandidates(); }
    } catch (cause) {
      if (mounted.current) { setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : t.reviewAgainFailed); }
    } finally { finish(); }
  }

  async function archive(record: { id: string; name: string }) {
    if (disabled || !begin()) return;
    try {
      const confirmed = await confirmDialog({ title: t.archiveTitle, description: t.archiveDescription.replace("{name}", record.name), confirmLabel: t.archive, cancelLabel: t.cancel });
      if (!confirmed || !mounted.current) return;
      await setCrmRecordArchived(workspaceId, record.id, true);
      if (mounted.current) { onMerged(); await refreshCandidates(); }
    } catch (cause) {
      if (mounted.current) { setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : t.archiveFailed); }
    } finally { finish(); }
  }

  return (
    <Shell open={open} busy={busy} onOpenChange={(next) => { if (!operation.current) onOpenChange(next); }} title={t.reviewDuplicates} description={t.duplicatesDescription}>
      <div className="space-y-3">
        {receipts.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="text-xs">
            <div className="font-medium">{t.bulkUndoReady.replace("{count}", String(receipts.length))}</div>
            <div className="text-muted-foreground">{t.undoAvailableUntil.replace("{date}", new Date(receipts[0].undoUntil).toLocaleString())}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" className="max-sm:min-h-11" disabled={busy || loading} onClick={() => void undoCompleted(false)}>{t.undoMerge}</Button>
            {receipts.length > 1 && <Button size="xs" variant="outline" className="max-sm:min-h-11" disabled={busy || loading} onClick={() => void undoCompleted(true)}>{t.undoAllMerges.replace("{count}", String(receipts.length))}</Button>}
          </div>
        </div>}
        {lastSeparation && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-xs">
          <span>{t.keptSeparate}: {lastSeparation.leftName} · {lastSeparation.rightName}</span>
          <Button size="xs" variant="outline" className="max-sm:min-h-11" disabled={disabled} onClick={() => void reviewAgain(lastSeparation.id)}>{t.reviewAgain}</Button>
        </div>}
        {error && <div role="alert" className="flex items-center justify-between gap-2 text-xs text-destructive"><span>{error}</span><Button size="xs" variant="outline" className="max-sm:min-h-11" disabled={busy || loading} onClick={() => { setError(null); void refreshCandidates(); }}>{t.retry}</Button></div>}
        {status && <div role="status" className="text-sm">{status}</div>}
        {loading && <div role="status" aria-label={t.duplicatesLoading} className="space-y-2">{[0, 1, 2].map((row) => <div key={row} className="h-10 animate-pulse rounded-lg bg-muted" />)}</div>}
        {groups.length > 0 && <div className="sticky -top-5 z-10 space-y-2 border-b border-border bg-background py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="max-sm:min-h-11" disabled={disabled || allCompatible.length === selectedPairs.length} onClick={() => choose(pairs, true)}>{t.selectAllDuplicates}</Button>
            <Button size="sm" variant="ghost" className="max-sm:min-h-11" disabled={disabled || selectedPairs.length === 0} onClick={() => setSelected(new Set())}>{t.clearDuplicateSelection}</Button>
            <Button size="sm" className="max-sm:min-h-11 sm:ml-auto" disabled={disabled || selectedPairs.length === 0} onClick={() => void mergeSelection(selectedPairs)}><GitMerge aria-hidden />{t.mergeSelected.replace("{count}", String(selectedPairs.length))}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{t.bulkDuplicateScope}</p>
          {pairs.some((pair) => !canSelectCrmMergePair(pair, selectedPairs, separations)) && <p className="text-xs text-muted-foreground">{t.bulkDuplicateOverlap}</p>}
        </div>}
        {groups.map((group) => {
          const groupPairs = crmDuplicatePairs([group]);
          const eligible = groupPairs.filter((pair) => canSelectCrmMergePair(pair, selectedPairs, separations));
          const chosen = eligible.filter((pair) => selected.has(pair.key));
          return <section key={`${group.kind}:${group.reason}:${group.value}`} className="rounded-xl border border-border p-3">
            <label className="flex min-h-8 max-sm:min-h-11 cursor-pointer items-center gap-2 text-xs font-medium">
              <Checkbox aria-label={t.selectDuplicateGroup.replace("{name}", group.value)} checked={eligible.length > 0 && chosen.length === eligible.length} indeterminate={chosen.length > 0 && chosen.length < eligible.length} disabled={disabled || eligible.length === 0} onCheckedChange={(include) => choose(eligible, include)} />
              <span className="min-w-0 break-words">{t.duplicateReasons[group.reason]} · {group.value}</span>
            </label>
            <div className="space-y-2">{group.records.map((record, index) => {
              const pair = groupPairs.find((candidate) => candidate.duplicate.id === record.id);
              const conflict = pair ? !canSelectCrmMergePair(pair, selectedPairs, separations) : false;
              return <div key={record.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2 text-xs">
                <label className="flex min-h-8 max-sm:min-h-11 min-w-32 flex-1 cursor-pointer items-center gap-2">
                  {index > 0 && pair && <Checkbox aria-label={t.includeDuplicate.replace("{name}", record.name).replace("{survivor}", pair.survivor.name)} checked={selected.has(pair.key)} disabled={disabled || conflict} onCheckedChange={(include) => choose([pair], include)} />}
                  <span className="break-words">{record.name}</span>
                </label>
                {index === 0 ? <span className="rounded bg-muted px-2 py-1 font-medium">{t.keepRecord}</span> : pair && <div className="flex flex-wrap items-center gap-1">
                  <Button size="xs" variant="outline" className="max-sm:min-h-11" disabled={disabled || conflict} onClick={() => void mergeSelection([pair])}><GitMerge aria-hidden />{t.merge}</Button>
                  <Button size="xs" variant="ghost" className="max-sm:min-h-11" disabled={disabled} onClick={() => void keepSeparate(pair)}>{t.keepSeparate}</Button>
                  <Button size="xs" variant="ghost" className="max-sm:min-h-11" disabled={disabled} onClick={() => void archive(record)}><Archive aria-hidden />{t.archive}</Button>
                </div>}
              </div>;
            })}</div>
          </section>;
        })}
        {loaded && !loading && !error && groups.length === 0 && <div className="text-sm text-muted-foreground">{t.noDuplicates}</div>}
        {separations.length > 0 && <details className="rounded-xl border border-border p-3"><summary className="min-h-8 max-sm:min-h-11 cursor-pointer text-xs font-medium">{t.keptSeparateSection.replace("{count}", String(separations.length))}</summary><div className="mt-2 space-y-2">{separations.map((separation) => <div key={separation.id} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{separation.leftName} · {separation.rightName}</span><Button size="xs" variant="ghost" className="max-sm:min-h-11" disabled={disabled} onClick={() => void reviewAgain(separation.id)}>{t.reviewAgain}</Button></div>)}</div></details>}
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkspaceCrm(workspaceId, true);
      setRows([
        ...data.contacts.filter((row) => row.archivedAt).map((row) => ({ id: row.id, name: row.name, kind: t.kindContact })),
        ...data.companies.filter((row) => row.archivedAt).map((row) => ({ id: row.id, name: row.name, kind: t.kindCompany })),
        ...data.deals.filter((row) => row.archivedAt).map((row) => ({ id: row.id, name: row.name, kind: t.kindDeal })),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.archivedLoadFailed);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!open) return;
    void reload();
  }, [open, workspaceId, t]);
  return (
    <Shell open={open} onOpenChange={onOpenChange} title={t.archivedRecords} description={t.archivedDescription}>
      <div className="space-y-2">
        {error && <div className="flex items-center justify-between gap-2 text-xs text-destructive"><span>{error}</span><Button size="xs" variant="ghost" onClick={() => void reload()}>{t.retry}</Button></div>}
        {loading && <div className="text-sm text-muted-foreground">{t.archivedLoading}</div>}
        {rows.map((row) => (
          <div key={row.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div><div className="text-xs font-medium">{row.name}</div><div className="text-[10px] text-muted-foreground">{row.kind}</div></div>
            <Button size="xs" variant="outline" onClick={() => void setCrmRecordArchived(workspaceId, row.id, false).then(() => {
              setRows((current) => current.filter((item) => item.id !== row.id));
              onRestored();
            }).catch((cause) => setError(cause instanceof Error ? cause.message : t.restoreFailed))}><ArchiveRestore aria-hidden />{t.restore}</Button>
          </div>
        ))}
        {!loading && !error && rows.length === 0 && <div className="text-sm text-muted-foreground">{t.noArchived}</div>}
      </div>
    </Shell>
  );
}

function RelationshipSelect({ label, value, placeholder, items, onChange, allowClear = false }: {
  label: string;
  value: string;
  placeholder: string;
  items: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  allowClear?: boolean;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <Select value={value || undefined} onValueChange={(next) => typeof next === "string" && onChange(next === "__none__" ? "" : next)}>
        <SelectTrigger className="w-full max-sm:min-h-11"><SelectValue placeholder={placeholder}>{items.find(item => item.value === value)?.label ?? placeholder}</SelectValue></SelectTrigger>
        <SelectContent>{allowClear && <SelectItem value="__none__">{placeholder}</SelectItem>}{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  );
}

function CreateField({ field, data, value, onChange }: {
  field: CrmFieldDefinition;
  data: CrmData | null;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const t = useT().crmPage.r2;
  if (field.fieldType === "boolean") {
    return <RelationshipSelect label={field.label} value={value === true ? "true" : value === false ? "false" : ""} placeholder={t.pickValue} items={[{ value: "true", label: t.yes }, { value: "false", label: t.no }]} onChange={(next) => onChange(next === "true")} />;
  }
  if (field.fieldType === "single_select") {
    return <RelationshipSelect label={field.label} value={typeof value === "string" ? value : ""} placeholder={t.pickValue} items={field.options.map((option) => ({ value: option, label: option }))} onChange={onChange} />;
  }
  if (field.fieldType === "entity_reference") {
    const items = [
      ...(field.options.includes("person") ? data?.contacts ?? [] : []),
      ...(field.options.includes("company") ? data?.companies ?? [] : []),
      ...(field.options.includes("deal") ? data?.deals ?? [] : []),
    ].map((row) => ({ value: row.id, label: row.name }));
    return <label className="block text-xs"><span className="mb-1 block text-muted-foreground">{field.label}</span><SearchableSelect value={typeof value === "string" ? value : ""} onValueChange={(next) => onChange(next || null)} items={items} placeholder={t.pickValue} searchPlaceholder={t.searchRecords} emptyMessage={t.noMatchingRecords} /></label>;
  }
  return (
    <Input
      label={field.label}
      type={field.fieldType === "number" ? "number" : field.fieldType === "date" ? "date" : "text"}
      value={Array.isArray(value) ? value.join(", ") : typeof value === "string" || typeof value === "number" ? String(value) : ""}
      onChange={(next) => {
        if (field.fieldType === "number") onChange(next === "" ? null : Number(next));
        else if (field.fieldType === "multi_select") onChange(next.split(",").map((part) => part.trim()).filter(Boolean));
        else onChange(next);
      }}
    />
  );
}

function Input({ label, value, onChange, placeholder, autoFocus, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; autoFocus?: boolean; type?: "text" | "number" | "date" }) {
  // 16px below `md` (M4) and no auto-focus on a phone: an auto-focused 14px
  // Name field opened the dialog already zoomed, with the kind select and
  // Cancel / Create scrolled off-screen (D4).
  return <label className="block text-xs"><span className="mb-1 block text-muted-foreground">{label}</span><input type={type} autoFocus={autoFocus && !isPhoneViewport()} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="h-9 max-sm:min-h-11 w-full rounded-lg border border-border bg-background px-3 text-[16px] outline-none md:text-sm" /></label>;
}
