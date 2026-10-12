"use client";

/**
 * Customer accounts on a company record: each seller/customer relationship
 * with its billing details and scope, its accepted account defaults and
 * agreements, and a read-only "Resolve fields" preview showing which accepted
 * term fills each bound field and what is still missing or in conflict.
 *
 * Any member with write can create or edit an account. Accepting terms is an
 * owner/admin action. Hidden records are indistinguishable from missing ones.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Commercial context".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useState } from "react";
import { Landmark, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  listCrmCommercialProfiles,
  listCrmCustomerAccounts,
  listCrmInvoices,
  listCrmOperationDefinitions,
  listCrmSellers,
  resolveCrmCommercialFields,
  type CrmCommercialCommand,
  type CrmCommercialProfile,
  type CrmCommercialResolution,
  type CrmCommercialStatus,
  type CrmCustomerAccount,
  type CrmInvoiceSummary,
  type CrmOperationDefinition,
  type CrmSellerProfile,
  type CrmSensitivity,
} from "@/lib/api/crm-commercial";
import { CrmReferenceRequestError, newCrmOperationId } from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import {
  CommercialInput,
  CommercialSelect,
  CommercialTextarea,
  IssueList,
  ProfileEditor,
  ProfileSummary,
  QuestionGroups,
  ResolvedFieldList,
  RefusalLine,
  SensitivityBadge,
  UUID_PATTERN,
  UncertainWrite,
  describeCommercialRefusal,
  isCalendarDate,
  sensitivityOptions,
  useCommercialCommand,
} from "./commercial-shared";
import { InvoicePreparationForm, InvoicePreparationPanel, InvoiceStateBadge, formatInvoiceMoney } from "./invoice-preparation";

type Loaded = { accounts: CrmCustomerAccount[]; sellers: CrmSellerProfile[] };

export function CrmRecordAccounts({ workspaceId, companyId, canConfigure, contactNames, deals = [] }: {
  workspaceId: string;
  companyId: string;
  /** Owner or admin: accepts terms, and issues, retries and voids invoices. */
  canConfigure: boolean;
  /** Contact id to display name, for the billing contact line. */
  contactNames?: ReadonlyMap<string, string>;
  /** The company's deals, offered when preparing an invoice. */
  deals?: ReadonlyArray<{ id: string; name: string }>;
}) {
  const t = useT().crmPage.commercial;
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<{ account: CrmCustomerAccount | null } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void Promise.all([
      listCrmCustomerAccounts(workspaceId, { companyId, includeArchived: true }),
      listCrmSellers(workspaceId),
    ])
      .then(([accounts, sellers]) => { if (!cancelled) setData({ accounts, sellers }); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, companyId, attempt]);

  useEffect(() => {
    setData(null);
    setEditing(null);
    setSaved(false);
  }, [workspaceId, companyId]);

  const reload = () => setAttempt((value) => value + 1);
  const activeSellers = (data?.sellers ?? []).filter((seller) => seller.status === "active");
  const sellerById = new Map((data?.sellers ?? []).map((seller) => [seller.id, seller]));

  // A workspace with no sellers and no accounts has no commercial context to show.
  if (data && data.sellers.length === 0 && data.accounts.length === 0) return null;

  return (
    <section className="mt-4 border-t border-border/60 pt-4" data-crm-record-accounts>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          <Landmark className="size-3.5" aria-hidden />{t.accountsTitle}
        </div>
        {data && activeSellers.length > 0 && !editing && (
          <Button size="xs" variant="ghost" className="max-md:min-h-11" onClick={() => { setSaved(false); setEditing({ account: null }); }}>
            <Plus aria-hidden />{t.newAccount}
          </Button>
        )}
      </div>
      {saved && <p role="status" className="mb-2 text-xs text-emerald-700 dark:text-emerald-300">{t.accountSaved}</p>}
      {failed ? (
        <div className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>{t.loadFailed}</span>
          <Button size="sm" variant="ghost" onClick={reload}>{t.retry}</Button>
        </div>
      ) : !data ? (
        <div className="text-xs text-muted-foreground">{t.loading}</div>
      ) : (
        <>
          {editing && (
            <AccountForm
              key={editing.account?.id ?? "new"}
              workspaceId={workspaceId}
              companyId={companyId}
              sellers={editing.account ? data.sellers : activeSellers}
              account={editing.account}
              onCancel={() => { setEditing(null); reload(); }}
              onSaved={() => { setEditing(null); setSaved(true); reload(); }}
            />
          )}
          {data.accounts.length === 0 ? (
            <div className="text-xs text-muted-foreground">{activeSellers.length ? t.accountsEmpty : t.accountsNeedSeller}</div>
          ) : (
            <ul className="divide-y divide-border">
              {data.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  workspaceId={workspaceId}
                  account={account}
                  seller={sellerById.get(account.sellerId) ?? null}
                  canConfigure={canConfigure}
                  contactName={account.billingContactId ? contactNames?.get(account.billingContactId) ?? null : null}
                  deals={deals}
                  onEdit={() => { setSaved(false); setEditing({ account }); }}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function AccountRow({ workspaceId, account, seller, canConfigure, contactName, deals, onEdit }: {
  workspaceId: string;
  account: CrmCustomerAccount;
  seller: CrmSellerProfile | null;
  canConfigure: boolean;
  contactName: string | null;
  deals: ReadonlyArray<{ id: string; name: string }>;
  onEdit: () => void;
}) {
  const t = useT().crmPage.commercial;
  const ti = useT().crmPage.invoices;
  const [open, setOpen] = useState<"terms" | "resolve" | "invoices" | null>(null);
  return (
    <li className="py-2" data-crm-account={account.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{account.label}</span>
        <span className="text-[11px] text-muted-foreground">{seller?.displayName ?? account.sellerKey}</span>
        <SensitivityBadge sensitivity={account.sensitivity} baseline={seller?.sensitivity} />
        {account.status === "archived" && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{t.statusLabels.archived}</span>}
        <div className="ml-auto flex flex-wrap gap-1">
          <Button size="xs" variant="ghost" className="max-md:min-h-11" onClick={onEdit}>{t.edit}</Button>
          <Button size="xs" variant={open === "terms" ? "secondary" : "ghost"} className="max-md:min-h-11" aria-pressed={open === "terms"}
            onClick={() => setOpen((value) => value === "terms" ? null : "terms")}>{t.terms}</Button>
          <Button size="xs" variant={open === "resolve" ? "secondary" : "ghost"} className="max-md:min-h-11" aria-pressed={open === "resolve"}
            onClick={() => setOpen((value) => value === "resolve" ? null : "resolve")}>{t.resolveTitle}</Button>
          <Button size="xs" variant={open === "invoices" ? "secondary" : "ghost"} className="max-md:min-h-11" aria-pressed={open === "invoices"}
            onClick={() => setOpen((value) => value === "invoices" ? null : "invoices")}>{ti.toggle}</Button>
        </div>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {account.billingContactId
          ? t.billingContact.replace("{contact}", contactName ?? account.billingContactId)
          : t.noBillingContact}
      </div>
      {account.billingAddress && <div className="mt-0.5 whitespace-pre-line text-[11px] text-muted-foreground">{account.billingAddress}</div>}
      {open === "terms" && <AccountTerms workspaceId={workspaceId} account={account} canConfigure={canConfigure} />}
      {open === "resolve" && <ResolvePreview workspaceId={workspaceId} accountId={account.id} />}
      {open === "invoices" && <AccountInvoices workspaceId={workspaceId} account={account} canIssue={canConfigure} deals={deals} />}
    </li>
  );
}

function AccountForm({ workspaceId, companyId, sellers, account, onCancel, onSaved }: {
  workspaceId: string;
  companyId: string;
  sellers: CrmSellerProfile[];
  account: CrmCustomerAccount | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useT().crmPage.commercial;
  const [sellerKey, setSellerKey] = useState(account?.sellerKey ?? sellers[0]?.sellerKey ?? "");
  const [label, setLabel] = useState(account?.label ?? "");
  const [billingContactId, setBillingContactId] = useState(account?.billingContactId ?? "");
  const [billingAddress, setBillingAddress] = useState(account?.billingAddress ?? "");
  const [status, setStatus] = useState<CrmCommercialStatus>(account?.status ?? "active");
  const [sensitivity, setSensitivity] = useState<string>("default");
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  const issues: string[] = [];
  if (!label.trim()) issues.push(t.accountIssues.label);
  if (!sellerKey) issues.push(t.accountIssues.seller);
  if (billingContactId.trim() && !UUID_PATTERN.test(billingContactId.trim())) issues.push(t.accountIssues.contact);

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) { onSaved(); return; }
    if (!outcome.error.uncertain) setRefusal(describeCommercialRefusal(outcome.error, t));
  }

  function submit() {
    if (issues.length || locked) return;
    void send({
      kind: "save_customer_account",
      operationId: newCrmOperationId(),
      ...(account ? { accountId: account.id, expectedVersion: account.version } : {}),
      account: {
        sellerKey,
        companyId,
        label: label.trim(),
        billingContactId: billingContactId.trim() || null,
        billingAddress: billingAddress.trim() || null,
        status,
      },
      ...(sensitivity !== "default" ? { classification: { sensitivity: sensitivity as CrmSensitivity } } : {}),
    });
  }

  return (
    <div className="mb-3 space-y-3 rounded-lg bg-muted/30 p-3" data-crm-account-form>
      <div className="text-xs font-medium">{account ? t.editAccountTitle.replace("{name}", account.label) : t.newAccountTitle}</div>
      <fieldset disabled={locked} className="grid gap-2 sm:grid-cols-2">
        <CommercialSelect label={t.seller} value={sellerKey} placeholder={t.pickSeller} disabled={Boolean(account)}
          options={sellers.map((seller) => ({ value: seller.sellerKey, label: seller.displayName }))}
          onChange={setSellerKey} />
        <CommercialInput label={t.accountLabel} value={label} maxLength={300} onChange={setLabel} />
        <CommercialInput label={t.billingContactId} value={billingContactId} onChange={setBillingContactId} />
        <CommercialSelect label={t.stricterSensitivity} value={sensitivity} options={sensitivityOptions(t, true)} onChange={setSensitivity} />
        <div className="sm:col-span-2">
          <CommercialTextarea label={t.billingAddress} value={billingAddress} maxLength={2000} onChange={setBillingAddress} />
        </div>
        {account && (
          <CommercialSelect label={t.status} value={status}
            options={(["active", "archived"] as const).map((value) => ({ value, label: t.statusLabels[value] }))}
            onChange={(value) => setStatus(value as CrmCommercialStatus)} />
        )}
      </fieldset>
      {account && <p className="text-[11px] text-muted-foreground">{t.accountBindingHelp}</p>}
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

type EditorTarget = { kind: "account" } | { kind: "agreement"; profile: CrmCommercialProfile | null };

function AccountTerms({ workspaceId, account, canConfigure }: {
  workspaceId: string;
  account: CrmCustomerAccount;
  canConfigure: boolean;
}) {
  const t = useT().crmPage.commercial;
  const [profiles, setProfiles] = useState<CrmCommercialProfile[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void listCrmCommercialProfiles(workspaceId, { accountId: account.id })
      .then((rows) => { if (!cancelled) setProfiles(rows); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, account.id, attempt]);

  const reload = () => setAttempt((value) => value + 1);
  const accepted = (profiles ?? []).filter((profile) => profile.status === "accepted");
  const defaults = accepted.find((profile) => profile.ownerKind === "account") ?? null;
  const agreements = accepted.filter((profile) => profile.ownerKind === "agreement");
  const done = (version: number | null) => {
    setEditor(null);
    setNotice(version === null ? null : t.acceptedProfile.replace("{version}", String(version)));
    reload();
  };

  if (failed) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-destructive">
        <span>{t.loadFailed}</span>
        <Button size="sm" variant="ghost" onClick={reload}>{t.retry}</Button>
      </div>
    );
  }
  if (!profiles) return <div className="mt-2 text-xs text-muted-foreground">{t.loading}</div>;

  return (
    <div className="mt-2 space-y-3 border-l border-border pl-3" data-crm-account-terms>
      {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium">{t.accountDefaults}</span>
          {canConfigure && !editor && (
            <Button size="xs" variant="outline" className="max-md:min-h-11" onClick={() => { setNotice(null); setEditor({ kind: "account" }); }}>{t.acceptDefaults}</Button>
          )}
        </div>
        {defaults ? <ProfileSummary profile={defaults} /> : <p className="text-[11px] text-muted-foreground">{t.noProfile}</p>}
        {editor?.kind === "account" && (
          <ProfileEditor workspaceId={workspaceId} owner={{ kind: "account", accountId: account.id }} current={defaults}
            onAccepted={done} onCancel={() => { setEditor(null); reload(); }} />
        )}
      </div>
      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium">{t.agreements}</span>
          {canConfigure && !editor && (
            <Button size="xs" variant="outline" className="max-md:min-h-11" onClick={() => { setNotice(null); setEditor({ kind: "agreement", profile: null }); }}>
              <Plus aria-hidden />{t.newAgreement}
            </Button>
          )}
        </div>
        {editor?.kind === "agreement" && editor.profile === null && (
          <ProfileEditor workspaceId={workspaceId} owner={{ kind: "agreement", accountId: account.id }} current={null}
            onAccepted={done} onCancel={() => { setEditor(null); reload(); }} />
        )}
        {agreements.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t.agreementsEmpty}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {agreements.map((agreement) => (
              <li key={agreement.id} className="py-2" data-crm-agreement={agreement.agreementKey ?? agreement.id}>
                <ProfileSummary profile={agreement} showDeals />
                {canConfigure && !editor && (
                  <Button size="xs" variant="ghost" className="mt-1 max-md:min-h-11" onClick={() => { setNotice(null); setEditor({ kind: "agreement", profile: agreement }); }}>
                    {t.acceptAgreementVersion}
                  </Button>
                )}
                {editor?.kind === "agreement" && editor.profile?.id === agreement.id && (
                  <ProfileEditor workspaceId={workspaceId} owner={{ kind: "agreement", accountId: account.id }} current={agreement}
                    onAccepted={done} onCancel={() => { setEditor(null); reload(); }} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ResolvePreview({ workspaceId, accountId }: { workspaceId: string; accountId: string }) {
  const t = useT().crmPage.commercial;
  const [operations, setOperations] = useState<CrmOperationDefinition[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [operationKey, setOperationKey] = useState("");
  const [dealId, setDealId] = useState("");
  const [businessDate, setBusinessDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ operation: CrmOperationDefinition; resolution: CrmCommercialResolution } | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void listCrmOperationDefinitions(workspaceId)
      .then((rows) => {
        if (cancelled) return;
        const usable = rows.filter((row) => row.currentVersionId);
        setOperations(usable);
        setOperationKey((current) => current || usable[0]?.operationKey || "");
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, attempt]);

  const dealValid = !dealId.trim() || UUID_PATTERN.test(dealId.trim());
  const dateValid = !businessDate || isCalendarDate(businessDate);

  async function resolve() {
    const operation = operations?.find((row) => row.operationKey === operationKey);
    if (!operation || busy || !dealValid || !dateValid) return;
    setBusy(true);
    setResolveError(null);
    try {
      const resolution = await resolveCrmCommercialFields(workspaceId, {
        operationKey,
        accountId,
        ...(dealId.trim() ? { dealId: dealId.trim() } : {}),
        ...(businessDate ? { businessDate } : {}),
      });
      setResult({ operation, resolution });
    } catch (cause) {
      setResult(null);
      setResolveError(cause instanceof CrmReferenceRequestError && !cause.uncertain
        ? describeCommercialRefusal(cause, t)
        : t.resolveFailed);
    } finally {
      setBusy(false);
    }
  }

  if (failed) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-destructive">
        <span>{t.loadFailed}</span>
        <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>{t.retry}</Button>
      </div>
    );
  }
  if (!operations) return <div className="mt-2 text-xs text-muted-foreground">{t.loading}</div>;
  if (operations.length === 0) return <p className="mt-2 text-xs text-muted-foreground">{t.noAcceptedOperations}</p>;

  const accepted = result?.operation.versions.find((version) => version.id === result.resolution.operationVersionId);
  const labelFor = (fieldKey: string) => accepted?.fieldBindings.find((binding) => binding.fieldKey === fieldKey)?.label ?? fieldKey;

  return (
    <div className="mt-2 space-y-3 border-l border-border pl-3" data-crm-resolve-preview>
      <p className="text-[11px] text-muted-foreground">{t.resolveHelp}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <CommercialSelect label={t.operation} value={operationKey} placeholder={t.pickOperation}
          options={operations.map((operation) => ({ value: operation.operationKey, label: operation.label }))}
          onChange={setOperationKey} />
        <CommercialInput label={t.dealIdOptional} value={dealId} onChange={setDealId} />
        <CommercialInput label={t.businessDateOptional} type="date" value={businessDate} onChange={setBusinessDate} />
      </div>
      <div className="flex justify-end">
        <Button size="sm" disabled={busy || !operationKey || !dealValid || !dateValid} onClick={() => void resolve()}>
          {busy ? t.resolving : t.resolve}
        </Button>
      </div>
      <RefusalLine text={resolveError} />
      {result && (
        <div data-crm-resolution>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className={result.resolution.draftReady ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
              {result.resolution.draftReady ? t.draftReady : t.draftNotReady}
            </span>
            <span className={result.resolution.issueReady ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
              {result.resolution.issueReady ? t.issueReady : t.issueNotReady}
            </span>
          </div>
          <ResolvedFieldList fields={result.resolution.fields} labelFor={labelFor} />
          <QuestionGroups questions={result.resolution.questions} />
        </div>
      )}
    </div>
  );
}

/**
 * The account's invoices, newest state first as the server lists them, and the
 * "Prepare invoice" entry. Selecting an invoice opens its preparation.
 */
function AccountInvoices({ workspaceId, account, canIssue, deals }: {
  workspaceId: string;
  account: CrmCustomerAccount;
  canIssue: boolean;
  deals: ReadonlyArray<{ id: string; name: string }>;
}) {
  const t = useT().crmPage.invoices;
  const [loaded, setLoaded] = useState<{ invoices: CrmInvoiceSummary[]; operations: CrmOperationDefinition[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{ kind: "prepare" } | { kind: "preparation"; preparationId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void Promise.all([listCrmInvoices(workspaceId, { accountId: account.id }), listCrmOperationDefinitions(workspaceId)])
      .then(([invoices, operations]) => {
        if (cancelled) return;
        setLoaded({ invoices, operations: operations.filter((operation) => operation.operationKind === "invoice" && operation.currentVersionId) });
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, account.id, attempt]);

  const reload = () => setAttempt((value) => value + 1);

  if (failed && !loaded) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-destructive">
        <span>{t.loadFailed}</span>
        <Button size="sm" variant="ghost" onClick={reload}>{t.retry}</Button>
      </div>
    );
  }
  if (!loaded) return <div className="mt-2 text-xs text-muted-foreground">{t.loading}</div>;

  return (
    <div className="mt-2 space-y-2 border-l border-border pl-3" data-crm-account-invoices>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">{t.title}</span>
        {view ? (
          <Button size="xs" variant="ghost" className="max-md:min-h-11" onClick={() => { setView(null); reload(); }}>
            <X aria-hidden />{t.close}
          </Button>
        ) : loaded.operations.length > 0 && (
          <Button size="xs" variant="outline" className="max-md:min-h-11" onClick={() => setView({ kind: "prepare" })}>
            <Plus aria-hidden />{t.prepare}
          </Button>
        )}
      </div>
      {!view && loaded.operations.length === 0 && <p className="text-[11px] text-muted-foreground">{t.noInvoiceOperation}</p>}
      {view?.kind === "prepare" && (
        <InvoicePreparationForm
          workspaceId={workspaceId}
          accountId={account.id}
          deals={deals}
          operations={loaded.operations}
          onCancel={() => setView(null)}
          onSaved={(preparationId) => { setView({ kind: "preparation", preparationId }); reload(); }}
        />
      )}
      {view?.kind === "preparation" && (
        <InvoicePreparationPanel
          workspaceId={workspaceId}
          preparationId={view.preparationId}
          canIssue={canIssue}
          deals={deals}
          operations={loaded.operations}
          onChanged={reload}
        />
      )}
      {!view && (loaded.invoices.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t.empty}</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {loaded.invoices.map((invoice) => (
            <li key={invoice.id} data-crm-invoice={invoice.id}>
              <button type="button" disabled={!invoice.preparationId}
                className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2 text-left text-xs hover:bg-muted/40 disabled:cursor-default max-md:min-h-11"
                onClick={() => { if (invoice.preparationId) setView({ kind: "preparation", preparationId: invoice.preparationId }); }}>
                <span className="font-mono">{invoice.number ?? t.numberAtIssue}</span>
                <InvoiceStateBadge state={invoice.state} />
                {invoice.issueDate && <span className="text-muted-foreground">{invoice.issueDate}</span>}
                {invoice.total !== null && (
                  <span className="ml-auto tabular-nums">{formatInvoiceMoney(invoice.total, invoice.currency)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}
