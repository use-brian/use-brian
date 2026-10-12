"use client";

/**
 * CRM configuration -> Commercial context: sellers and their accepted default
 * terms, and bounded operations (invoice first) with their accepted and
 * proposed versions. Proposing records a new version; only a human owner or
 * admin accepts one, after a confirm that summarizes what changes against the
 * accepted version. Members see the same content read-only.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Commercial context".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useState, type ReactNode } from "react";
import { Briefcase, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  CRM_COMMERCIAL_FIELD_TYPES,
  CRM_COMMERCIAL_SOURCE_KINDS,
  listCrmCommercialProfiles,
  listCrmOperationDefinitions,
  listCrmSellers,
  type CrmCommercialCommand,
  type CrmCommercialFieldType,
  type CrmCommercialProfile,
  type CrmCommercialStatus,
  type CrmFieldBinding,
  type CrmOperationDefinition,
  type CrmOperationVersion,
  type CrmOperationVersionInput,
  type CrmSellerProfile,
  type CrmSensitivity,
} from "@/lib/api/crm-commercial";
import { listCrmReferenceDefinitions, newCrmOperationId, type CrmReferenceDefinition } from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import {
  CommercialInput,
  CommercialSelect,
  CommercialTextarea,
  IssueList,
  ProfileEditor,
  ProfileSummary,
  RefusalLine,
  STABLE_KEY_PATTERN,
  SensitivityBadge,
  UUID_PATTERN,
  UncertainWrite,
  describeCommercialRefusal,
  sensitivityOptions,
  useCommercialCommand,
  type CommercialCopy,
} from "./commercial-shared";

const MAX_INSTRUCTIONS = 20_000;
const MAX_BINDINGS = 200;
const BINDING_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const TOKEN_PATTERN = /^[A-Z][A-Z0-9_]{0,62}$/;
const NO_REFERENCE = "__none__";

type Loaded = {
  sellers: CrmSellerProfile[];
  operations: CrmOperationDefinition[];
  referenceDefinitions: CrmReferenceDefinition[];
};

export function CrmCommercialSettings({ workspaceId, canConfigure }: { workspaceId: string; canConfigure: boolean }) {
  const t = useT().crmPage.commercial;
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void Promise.all([
      listCrmSellers(workspaceId),
      listCrmOperationDefinitions(workspaceId),
      listCrmReferenceDefinitions(workspaceId).catch(() => [] as CrmReferenceDefinition[]),
    ])
      .then(([sellers, operations, referenceDefinitions]) => {
        if (!cancelled) setData({ sellers, operations, referenceDefinitions });
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, attempt]);

  const reload = () => setAttempt((value) => value + 1);

  return (
    <section className="border-t border-border pt-5" data-crm-commercial-settings>
      <div className="mb-3 min-w-0">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Briefcase className="size-3.5" aria-hidden />{t.title}</h3>
        <p className="text-xs text-muted-foreground">{t.description}</p>
      </div>
      {!canConfigure && <p className="mb-2 text-xs text-muted-foreground">{t.readOnly}</p>}
      {failed ? (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{t.loadFailed}</span>
          <Button size="sm" variant="ghost" onClick={reload}>{t.retry}</Button>
        </div>
      ) : !data ? (
        <div className="text-xs text-muted-foreground">{t.loading}</div>
      ) : (
        <div className="space-y-6">
          <SellersPanel workspaceId={workspaceId} sellers={data.sellers} canConfigure={canConfigure} onReload={reload} />
          <OperationsPanel
            workspaceId={workspaceId}
            operations={data.operations}
            referenceDefinitions={data.referenceDefinitions.filter((definition) => definition.status !== "archived")}
            canConfigure={canConfigure}
            onReload={reload}
          />
        </div>
      )}
    </section>
  );
}

function PanelHeading({ title, help, action }: { title: string; help: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h4 className="text-xs font-semibold">{title}</h4>
        <p className="text-[11px] text-muted-foreground">{help}</p>
      </div>
      {action}
    </div>
  );
}

// ── Sellers ─────────────────────────────────────────────────────────

function SellersPanel({ workspaceId, sellers, canConfigure, onReload }: {
  workspaceId: string;
  sellers: CrmSellerProfile[];
  canConfigure: boolean;
  onReload: () => void;
}) {
  const t = useT().crmPage.commercial;
  const [editing, setEditing] = useState<{ seller: CrmSellerProfile | null } | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <div data-commercial-sellers>
      <PanelHeading
        title={t.sellersTitle}
        help={t.sellersHelp}
        action={canConfigure && !editing ? (
          <Button size="sm" variant="outline" onClick={() => { setSaved(false); setEditing({ seller: null }); }}><Plus aria-hidden />{t.newSeller}</Button>
        ) : undefined}
      />
      {saved && <p role="status" className="mb-2 text-xs text-emerald-700 dark:text-emerald-300">{t.sellerSaved}</p>}
      {editing && canConfigure && (
        <SellerForm
          key={editing.seller?.id ?? "new"}
          workspaceId={workspaceId}
          seller={editing.seller}
          onCancel={() => { setEditing(null); onReload(); }}
          onSaved={() => { setEditing(null); setSaved(true); onReload(); }}
        />
      )}
      {sellers.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.sellersEmpty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {sellers.map((seller) => (
            <SellerRow key={seller.id} workspaceId={workspaceId} seller={seller} canConfigure={canConfigure}
              onEdit={() => { setSaved(false); setEditing({ seller }); }} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SellerRow({ workspaceId, seller, canConfigure, onEdit }: {
  workspaceId: string;
  seller: CrmSellerProfile;
  canConfigure: boolean;
  onEdit: () => void;
}) {
  const t = useT().crmPage.commercial;
  const [showTerms, setShowTerms] = useState(false);
  return (
    <li className={seller.status === "archived" ? "py-2 opacity-75" : "py-2"} data-commercial-seller={seller.sellerKey}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{seller.displayName}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{seller.sellerKey}</span>
        <SensitivityBadge sensitivity={seller.sensitivity} />
        {seller.status === "archived" && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{t.statusLabels.archived}</span>}
        <div className="ml-auto flex flex-wrap gap-1">
          {canConfigure && <Button size="xs" variant="ghost" className="max-md:min-h-11" onClick={onEdit}><Pencil aria-hidden />{t.edit}</Button>}
          <Button size="xs" variant={showTerms ? "secondary" : "ghost"} className="max-md:min-h-11" aria-pressed={showTerms}
            onClick={() => setShowTerms((value) => !value)}>{showTerms ? t.hideTerms : t.defaultTerms}</Button>
        </div>
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{seller.legalName} · {seller.timezone}</div>
      {showTerms && <SellerTerms workspaceId={workspaceId} seller={seller} canConfigure={canConfigure} />}
    </li>
  );
}

function SellerTerms({ workspaceId, seller, canConfigure }: { workspaceId: string; seller: CrmSellerProfile; canConfigure: boolean }) {
  const t = useT().crmPage.commercial;
  const [profiles, setProfiles] = useState<CrmCommercialProfile[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void listCrmCommercialProfiles(workspaceId, { sellerKey: seller.sellerKey })
      .then((rows) => { if (!cancelled) setProfiles(rows); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, seller.sellerKey, attempt]);

  const reload = () => setAttempt((value) => value + 1);
  if (failed) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-destructive">
        <span>{t.loadFailed}</span>
        <Button size="sm" variant="ghost" onClick={reload}>{t.retry}</Button>
      </div>
    );
  }
  if (!profiles) return <div className="mt-2 text-xs text-muted-foreground">{t.loading}</div>;
  const current = profiles.find((profile) => profile.ownerKind === "seller" && profile.status === "accepted") ?? null;
  return (
    <div className="mt-2 space-y-2 border-l border-border pl-3" data-commercial-seller-terms>
      {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {current ? <ProfileSummary profile={current} /> : <p className="text-[11px] text-muted-foreground">{t.noProfile}</p>}
      {canConfigure && !editing && (
        <Button size="xs" variant="outline" className="max-md:min-h-11" onClick={() => { setNotice(null); setEditing(true); }}>{t.acceptDefaults}</Button>
      )}
      {canConfigure && editing && (
        <ProfileEditor
          workspaceId={workspaceId}
          owner={{ kind: "seller", sellerKey: seller.sellerKey }}
          current={current}
          onAccepted={(version) => {
            setEditing(false);
            setNotice(version === null ? null : t.acceptedProfile.replace("{version}", String(version)));
            reload();
          }}
          onCancel={() => { setEditing(false); reload(); }}
        />
      )}
    </div>
  );
}

function SellerForm({ workspaceId, seller, onCancel, onSaved }: {
  workspaceId: string;
  seller: CrmSellerProfile | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useT().crmPage.commercial;
  const [sellerKey, setSellerKey] = useState(seller?.sellerKey ?? "");
  const [legalName, setLegalName] = useState(seller?.legalName ?? "");
  const [displayName, setDisplayName] = useState(seller?.displayName ?? "");
  const [companyId, setCompanyId] = useState(seller?.companyId ?? "");
  const [timezone, setTimezone] = useState(seller?.timezone ?? "UTC");
  const [status, setStatus] = useState<CrmCommercialStatus>(seller?.status ?? "active");
  const [sensitivity, setSensitivity] = useState("default");
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  const issues: string[] = [];
  if (!STABLE_KEY_PATTERN.test(sellerKey)) issues.push(t.sellerIssues.key);
  if (!legalName.trim() || !displayName.trim()) issues.push(t.sellerIssues.names);
  if (companyId.trim() && !UUID_PATTERN.test(companyId.trim())) issues.push(t.sellerIssues.companyId);

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) { onSaved(); return; }
    if (!outcome.error.uncertain) setRefusal(describeCommercialRefusal(outcome.error, t));
  }

  function submit() {
    if (issues.length || locked) return;
    void send({
      kind: "save_seller_profile",
      operationId: newCrmOperationId(),
      ...(seller ? { sellerId: seller.id, expectedVersion: seller.version } : {}),
      seller: {
        sellerKey,
        legalName: legalName.trim(),
        displayName: displayName.trim(),
        companyId: companyId.trim() || null,
        timezone: timezone.trim() || "UTC",
        status,
      },
      ...(sensitivity !== "default" ? { classification: { sensitivity: sensitivity as CrmSensitivity } } : {}),
    });
  }

  return (
    <div className="mb-3 space-y-3 rounded-lg bg-muted/30 p-3" data-commercial-seller-form>
      <div className="text-xs font-medium">{seller ? t.editSellerTitle.replace("{name}", seller.displayName) : t.newSellerTitle}</div>
      <fieldset disabled={locked} className="grid gap-2 sm:grid-cols-2">
        <div>
          <CommercialInput label={t.sellerKey} value={sellerKey} disabled={Boolean(seller)} maxLength={63}
            onChange={(value) => setSellerKey(value.trim().toLowerCase())} />
          <p className="mt-1 text-[11px] text-muted-foreground">{t.sellerKeyHelp}</p>
        </div>
        <CommercialInput label={t.displayName} value={displayName} maxLength={300} onChange={setDisplayName} />
        <CommercialInput label={t.legalName} value={legalName} maxLength={300} onChange={setLegalName} />
        <CommercialInput label={t.sellerCompanyId} value={companyId} onChange={setCompanyId} />
        <CommercialInput label={t.timezone} value={timezone} maxLength={64} onChange={setTimezone} />
        <CommercialSelect label={t.sensitivity} value={sensitivity} options={sensitivityOptions(t, true)} onChange={setSensitivity} />
        {seller && (
          <CommercialSelect label={t.status} value={status}
            options={(["active", "archived"] as const).map((value) => ({ value, label: t.statusLabels[value] }))}
            onChange={(value) => setStatus(value as CrmCommercialStatus)} />
        )}
      </fieldset>
      <IssueList issues={issues} />
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onCancel} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={onCancel}>{t.cancel}</Button>
        <Button size="sm" disabled={issues.length > 0 || locked} onClick={submit}>{writer.busy ? t.saving : t.save}</Button>
      </div>
    </div>
  );
}

// ── Operations ──────────────────────────────────────────────────────

const acceptedVersionOf = (operation: CrmOperationDefinition) =>
  operation.versions.find((version) => version.id === operation.currentVersionId) ?? null;

/** What accepting `proposed` changes against the current accepted version, phrased for the confirm. */
function operationVersionDiff(accepted: CrmOperationVersion | null, proposed: CrmOperationVersion, t: CommercialCopy): string[] {
  const before = new Map((accepted?.fieldBindings ?? []).map((binding) => [binding.fieldKey, binding]));
  const after = new Map(proposed.fieldBindings.map((binding) => [binding.fieldKey, binding]));
  const added = [...after.keys()].filter((key) => !before.has(key));
  const removed = [...before.keys()].filter((key) => !after.has(key));
  const changed = [...after.keys()].filter((key) => before.has(key) && JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)));
  const lines = [accepted && accepted.instructions === proposed.instructions ? t.diffInstructionsSame : t.diffInstructionsChanged];
  if (added.length) lines.push(t.diffAdded.replace("{keys}", added.join(", ")));
  if (removed.length) lines.push(t.diffRemoved.replace("{keys}", removed.join(", ")));
  if (changed.length) lines.push(t.diffChanged.replace("{keys}", changed.join(", ")));
  if (!added.length && !removed.length && !changed.length) lines.push(t.diffNoBindingChanges);
  return lines;
}

function OperationsPanel({ workspaceId, operations, referenceDefinitions, canConfigure, onReload }: {
  workspaceId: string;
  operations: CrmOperationDefinition[];
  referenceDefinitions: CrmReferenceDefinition[];
  canConfigure: boolean;
  onReload: () => void;
}) {
  const t = useT().crmPage.commercial;
  const [editing, setEditing] = useState<{ operation: CrmOperationDefinition | null } | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  async function send(command: CrmCommercialCommand) {
    setNotice(null);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      const record = outcome.result.record as { version?: { versionNumber?: unknown } } | null;
      setNotice({ tone: "success", text: t.acceptedDone.replace("{version}", String(record?.version?.versionNumber ?? "")) });
      onReload();
      return;
    }
    if (!outcome.error.uncertain) setNotice({ tone: "error", text: describeCommercialRefusal(outcome.error, t) });
  }

  async function accept(operation: CrmOperationDefinition, version: CrmOperationVersion) {
    if (locked) return;
    const accepted = acceptedVersionOf(operation);
    const confirmed = await confirmDialog({
      title: t.acceptTitle.replace("{version}", String(version.versionNumber)).replace("{name}", operation.label),
      description: accepted ? t.acceptDescription : t.acceptDescriptionFirst,
      content: (
        <ul className="list-disc space-y-0.5 pl-5 text-xs" data-operation-version-diff>
          {operationVersionDiff(accepted, version, t).map((line) => <li key={line}>{line}</li>)}
        </ul>
      ),
      confirmLabel: t.accept,
      cancelLabel: t.cancel,
    });
    if (!confirmed) return;
    await send({
      kind: "accept_operation_version",
      operationId: newCrmOperationId(),
      operationKey: operation.operationKey,
      versionId: version.id,
      expectedVersion: operation.version,
    });
  }

  return (
    <div data-commercial-operations>
      <PanelHeading
        title={t.operationsTitle}
        help={t.operationsHelp}
        action={canConfigure && !editing ? (
          <Button size="sm" variant="outline" onClick={() => { setNotice(null); setEditing({ operation: null }); }}><Plus aria-hidden />{t.newOperation}</Button>
        ) : undefined}
      />
      {notice && (
        <p role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? "mb-2 text-xs text-destructive" : "mb-2 text-xs text-emerald-700 dark:text-emerald-300"}>
          {notice.text}
        </p>
      )}
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onReload} />
      {editing && canConfigure && (
        <OperationEditor
          key={editing.operation?.id ?? "new"}
          workspaceId={workspaceId}
          operation={editing.operation}
          referenceDefinitions={referenceDefinitions}
          onCancel={() => { setEditing(null); onReload(); }}
          onProposed={() => { setEditing(null); setNotice({ tone: "success", text: t.proposedDone }); onReload(); }}
        />
      )}
      {operations.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.operationsEmpty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {operations.map((operation) => {
            const accepted = acceptedVersionOf(operation);
            const proposed = operation.versions.filter((version) => version.state === "proposed");
            return (
              <li key={operation.id} className="py-3" data-commercial-operation={operation.operationKey}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">{operation.label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{operation.operationKey}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{t.operationKindLabels[operation.operationKind] ?? operation.operationKind}</span>
                  {canConfigure && !editing && (
                    <Button size="xs" variant="ghost" className="ml-auto max-md:min-h-11" onClick={() => { setNotice(null); setEditing({ operation }); }}>
                      {t.proposeVersion}
                    </Button>
                  )}
                </div>
                {accepted ? (
                  <VersionSummary title={t.acceptedVersion.replace("{version}", String(accepted.versionNumber))} version={accepted} />
                ) : (
                  <p className="mt-1 text-[11px] text-muted-foreground">{t.noAcceptedVersion}</p>
                )}
                {proposed.map((version) => (
                  <div key={version.id} className="mt-2 flex flex-wrap items-start gap-2" data-proposed-version={version.versionNumber}>
                    <div className="min-w-0 flex-1">
                      <VersionSummary title={t.proposedVersion.replace("{version}", String(version.versionNumber))} version={version} />
                    </div>
                    {canConfigure && (
                      <Button size="sm" disabled={locked} onClick={() => void accept(operation, version)}>{t.accept}</Button>
                    )}
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function VersionSummary({ title, version }: { title: string; version: CrmOperationVersion }) {
  const t = useT().crmPage.commercial;
  return (
    <div className="mt-1 min-w-0 text-xs">
      <div className="font-medium text-foreground/80">{title}</div>
      <div className="text-[11px] text-muted-foreground">
        {t.versionSummary
          .replace("{count}", String(version.fieldBindings.length))
          .replace("{review}", t.reviewPolicyLabels[version.reviewPolicy])}
      </div>
      <p className="mt-1 line-clamp-3 whitespace-pre-line text-[11px] text-muted-foreground">{version.instructions}</p>
    </div>
  );
}

type BindingRow = Omit<CrmFieldBinding, "templateToken"> & { rowId: number; templateToken: string };

let bindingSequence = 0;
const nextBindingId = () => { bindingSequence += 1; return bindingSequence; };

const emptyBinding = (): BindingRow => ({
  rowId: nextBindingId(),
  fieldKey: "",
  label: "",
  type: "string",
  requiredFor: "draft",
  overridable: false,
  protected: false,
  sources: [...CRM_COMMERCIAL_SOURCE_KINDS],
  templateToken: "",
});

function bindingIssues(rows: BindingRow[], t: CommercialCopy): string[] {
  const issues: string[] = [];
  if (rows.length < 1 || rows.length > MAX_BINDINGS) issues.push(t.operationIssues.bindings);
  if (rows.some((row) => !BINDING_KEY_PATTERN.test(row.fieldKey))) issues.push(t.operationIssues.bindingKey);
  if (new Set(rows.map((row) => row.fieldKey)).size !== rows.length) issues.push(t.operationIssues.duplicateBinding);
  if (rows.some((row) => !row.label.trim())) issues.push(t.operationIssues.bindingLabel);
  if (rows.some((row) => row.sources.length === 0)) issues.push(t.operationIssues.sources);
  const tokens = rows.map((row) => row.templateToken).filter(Boolean);
  if (tokens.some((token) => !TOKEN_PATTERN.test(token))) issues.push(t.operationIssues.token);
  if (new Set(tokens).size !== tokens.length) issues.push(t.operationIssues.duplicateToken);
  return issues;
}

function OperationEditor({ workspaceId, operation, referenceDefinitions, onCancel, onProposed }: {
  workspaceId: string;
  operation: CrmOperationDefinition | null;
  referenceDefinitions: CrmReferenceDefinition[];
  onCancel: () => void;
  onProposed: () => void;
}) {
  const t = useT().crmPage.commercial;
  // Start from the newest version (a pending proposal, else the accepted one).
  const base = operation ? operation.versions[0] ?? acceptedVersionOf(operation) : null;
  const [operationKey, setOperationKey] = useState(operation?.operationKey ?? "");
  const [label, setLabel] = useState(operation?.label ?? "");
  const [instructions, setInstructions] = useState(base?.instructions ?? "");
  const [rows, setRows] = useState<BindingRow[]>(() => base
    ? base.fieldBindings.map((binding) => ({ ...binding, sources: [...binding.sources], templateToken: binding.templateToken ?? "", rowId: nextBindingId() }))
    : [emptyBinding()]);
  const [templateId, setTemplateId] = useState(base?.templateBinding?.templateId ?? "");
  const [pdfPreset, setPdfPreset] = useState<"invoice" | "worksheet">(base?.templateBinding?.pdfPreset ?? "invoice");
  const [reviewPolicy, setReviewPolicy] = useState<CrmOperationVersionInput["reviewPolicy"]>(base?.reviewPolicy ?? "direct");
  const [referenceKey, setReferenceKey] = useState(base?.referenceDefinitionKey ?? NO_REFERENCE);
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  const issues: string[] = [];
  if (!STABLE_KEY_PATTERN.test(operationKey)) issues.push(t.operationIssues.key);
  if (!label.trim()) issues.push(t.operationIssues.label);
  if (!instructions.trim() || instructions.length > MAX_INSTRUCTIONS) issues.push(t.operationIssues.instructions);
  issues.push(...bindingIssues(rows, t));
  if (templateId.trim() && !UUID_PATTERN.test(templateId.trim())) issues.push(t.operationIssues.templateId);

  const updateRow = (rowId: number, patch: Partial<BindingRow>) =>
    setRows((current) => current.map((row) => row.rowId === rowId ? { ...row, ...patch } : row));

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) { onProposed(); return; }
    if (!outcome.error.uncertain) setRefusal(describeCommercialRefusal(outcome.error, t));
  }

  function submit() {
    if (issues.length || locked) return;
    const trimmedTemplate = templateId.trim();
    // A Page source revision is only true while the snapshot is unchanged.
    const instructionSource = base?.instructionSource && base.instructions === instructions.trim() ? base.instructionSource : null;
    void send({
      kind: "save_operation_definition",
      operationId: newCrmOperationId(),
      operationKey,
      operationKind: "invoice",
      label: label.trim(),
      expectedVersion: operation?.version ?? 0,
      version: {
        instructions: instructions.trim(),
        instructionSource,
        fieldBindings: rows.map(({ rowId: _rowId, templateToken, ...binding }) => ({
          ...binding,
          label: binding.label.trim(),
          sources: CRM_COMMERCIAL_SOURCE_KINDS.filter((source) => binding.sources.includes(source)),
          ...(templateToken ? { templateToken } : {}),
        })),
        templateBinding: trimmedTemplate
          ? {
            templateId: trimmedTemplate,
            ...(base?.templateBinding?.templateId === trimmedTemplate && base.templateBinding.templateVersionId
              ? { templateVersionId: base.templateBinding.templateVersionId } : {}),
            pdfPreset,
          }
          : null,
        reviewPolicy,
        referenceDefinitionKey: referenceKey === NO_REFERENCE ? null : referenceKey,
      },
    });
  }

  const typeOptions = CRM_COMMERCIAL_FIELD_TYPES.map((type) => ({ value: type, label: t.fieldTypes[type] }));
  const requiredOptions = (["draft", "issue", "never"] as const).map((value) => ({ value, label: t.requiredForLabels[value] }));
  const referenceOptions = [
    { value: NO_REFERENCE, label: t.noReferenceDefinition },
    ...referenceDefinitions.map((definition) => ({ value: definition.definitionKey, label: definition.label })),
  ];

  return (
    <div className="mb-3 space-y-3 rounded-lg bg-muted/30 p-3" data-commercial-operation-editor>
      <div className="text-xs font-medium">{operation ? t.proposeTitle.replace("{name}", operation.label) : t.newOperationTitle}</div>
      <fieldset disabled={locked} className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <CommercialInput label={t.operationKey} value={operationKey} disabled={Boolean(operation)} maxLength={63}
            onChange={(value) => setOperationKey(value.trim().toLowerCase())} />
          <CommercialInput label={t.operationLabel} value={label} maxLength={200} onChange={setLabel} />
          <div className="text-xs">
            <span className="mb-1 block text-muted-foreground">{t.operationKind}</span>
            <span className="block py-2">{t.operationKindLabels.invoice}</span>
          </div>
        </div>
        <div>
          <CommercialTextarea label={t.instructions} value={instructions} maxLength={MAX_INSTRUCTIONS} onChange={setInstructions} />
          <div className="mt-1 flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{t.instructionsHelp}</span>
            <span data-instructions-count>
              {t.instructionsCount.replace("{count}", instructions.length.toLocaleString()).replace("{max}", MAX_INSTRUCTIONS.toLocaleString())}
            </span>
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium">{t.bindings}</div>
          <ul className="divide-y divide-border" data-binding-rows>
            {rows.map((row) => (
              <li key={row.rowId} className="space-y-2 py-2" data-binding-row>
                <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <CommercialInput label={t.fieldKey} value={row.fieldKey} maxLength={63}
                    onChange={(fieldKey) => updateRow(row.rowId, { fieldKey: fieldKey.trim().toLowerCase() })} />
                  <CommercialInput label={t.bindingLabel} value={row.label} maxLength={200} onChange={(value) => updateRow(row.rowId, { label: value })} />
                  <CommercialSelect label={t.fieldType} value={row.type} options={typeOptions}
                    onChange={(type) => updateRow(row.rowId, { type: type as CrmCommercialFieldType })} />
                  <CommercialSelect label={t.requiredFor} value={row.requiredFor} options={requiredOptions}
                    onChange={(value) => updateRow(row.rowId, { requiredFor: value as BindingRow["requiredFor"] })} />
                  <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={t.removeBinding}
                    onClick={() => setRows((current) => current.filter((item) => item.rowId !== row.rowId))}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Button size="sm" variant={row.overridable ? "default" : "outline"} aria-pressed={row.overridable}
                    onClick={() => updateRow(row.rowId, { overridable: !row.overridable })}>{t.overridable}</Button>
                  <Button size="sm" variant={row.protected ? "default" : "outline"} aria-pressed={row.protected}
                    onClick={() => updateRow(row.rowId, { protected: !row.protected })}>{t.protectedTerm}</Button>
                  <div className="min-w-40 flex-1">
                    <CommercialInput label={t.templateToken} value={row.templateToken} maxLength={63}
                      onChange={(value) => updateRow(row.rowId, { templateToken: value.trim().toUpperCase() })} />
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-muted-foreground">{t.sources}</div>
                  <div className="flex flex-wrap gap-1" role="group" aria-label={t.sources}>
                    {CRM_COMMERCIAL_SOURCE_KINDS.map((source) => (
                      <Button key={source} size="xs" variant={row.sources.includes(source) ? "default" : "outline"} className="max-md:min-h-11"
                        aria-pressed={row.sources.includes(source)}
                        onClick={() => updateRow(row.rowId, {
                          sources: row.sources.includes(source) ? row.sources.filter((item) => item !== source) : [...row.sources, source],
                        })}>
                        {t.sourceKinds[source]}
                      </Button>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <Button className="mt-2" size="sm" variant="outline" disabled={rows.length >= MAX_BINDINGS}
            onClick={() => setRows((current) => [...current, emptyBinding()])}>
            <Plus aria-hidden />{t.addBinding}
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <CommercialInput label={t.templateId} value={templateId} onChange={setTemplateId} />
          <CommercialSelect label={t.pdfPreset} value={pdfPreset}
            options={(["invoice", "worksheet"] as const).map((value) => ({ value, label: t.pdfPresetLabels[value] }))}
            onChange={(value) => setPdfPreset(value as "invoice" | "worksheet")} />
          <CommercialSelect label={t.reviewPolicy} value={reviewPolicy}
            options={(["direct", "exact_version_review"] as const).map((value) => ({ value, label: t.reviewPolicyLabels[value] }))}
            onChange={(value) => setReviewPolicy(value as CrmOperationVersionInput["reviewPolicy"])} />
          <CommercialSelect label={t.referenceDefinition} value={referenceKey} options={referenceOptions} onChange={setReferenceKey} />
        </div>
      </fieldset>
      <IssueList issues={[...new Set(issues)]} />
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onCancel} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={onCancel}>{t.cancel}</Button>
        <Button size="sm" disabled={issues.length > 0 || locked} onClick={submit}>{writer.busy ? t.proposing : t.propose}</Button>
      </div>
    </div>
  );
}
