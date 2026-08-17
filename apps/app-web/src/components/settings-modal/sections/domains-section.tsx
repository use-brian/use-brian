"use client";

/**
 * Settings -> Domains (Notion-style, workspace-first lifecycle): the owner
 * surface for workspace website and assistant-email hostnames. Four moves:
 *   - Workspace subdomain (platform-subdomains.md): claim with a random
 *     fruit+digits default (grape209.usebrian.page), rename, Reset (re-roll
 *     a fresh random name), release. No page required to claim.
 *   - Custom domains (custom-domains.md): connect a BYO hostname (unbound),
 *     DNS instructions + re-check, disconnect.
 *   - Default page per domain: what serves at `/`. Pages get their aliases
 *     from their own Share dialog; this surface owns the domain lifecycle.
 *   - Assistant email domains (agentmail.md): register separately with the
 *     email provider, show its exact MX/authentication records, verify, remove.
 *     These never enter the page-domain/Vercel provisioner.
 *
 * [COMP:app-web/settings-domains]
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Dices, Globe, Mail } from "lucide-react";
import { useT, format } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  checkSubdomainAvailability,
  checkWorkspaceDomain,
  claimSubdomain,
  connectWorkspaceDomain,
  getSubdomainSuggestion,
  listViews,
  listWorkspaceDomains,
  releaseSubdomain,
  removeWorkspaceDomain,
  renameSubdomain,
  setDomainDefaultPage,
  type DnsInstruction,
  type ViewListRow,
  type WorkspaceDomainRow,
} from "@/lib/api/views";
import {
  connectEmailDomain,
  probeEmailInboxes,
  removeEmailDomain,
  verifyEmailDomain,
  type EmailDomainSummary,
} from "@/lib/api/email-inboxes";

const NONE = "__none__";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "ready";
      domains: WorkspaceDomainRow[];
      subdomainApex: string | null;
      pages: ViewListRow[];
      /** Null means the AgentMail provider is not configured on this edition. */
      emailDomains: EmailDomainSummary[] | null;
    };

function StatusChip({ status }: { status: WorkspaceDomainRow["status"] }) {
  const t = useT().docPage.share;
  const label =
    status === "live" ? t.site.statusLive : status === "error" ? t.site.statusError : t.site.statusPending;
  const cls =
    status === "live"
      ? "text-emerald-600 dark:text-emerald-400"
      : status === "error"
        ? "text-destructive"
        : "text-muted-foreground";
  return <span className={`shrink-0 text-xs font-medium ${cls}`}>{label}</span>;
}

function DnsRows({ instructions }: { instructions: DnsInstruction[] }) {
  const t = useT().docPage.share;
  if (instructions.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
      <p className="mb-1 text-muted-foreground">{t.site.dnsHint}</p>
      <div className="space-y-1 font-mono">
        {instructions.map((ins, i) => (
          <div key={`${ins.type}-${i}`} className="flex flex-wrap gap-x-3">
            <span className="font-semibold">{ins.type}</span>
            <span className="min-w-0 break-all">{ins.name}</span>
            <span className="min-w-0 break-all text-muted-foreground">{ins.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Which page serves at `/` on this domain. */
function DefaultPagePicker({
  workspaceId,
  row,
  pages,
  onChanged,
}: {
  workspaceId: string;
  row: WorkspaceDomainRow;
  pages: ViewListRow[];
  onChanged: () => Promise<void>;
}) {
  const t = useT().chrome.settingsModal.domains;
  const [err, setErr] = useState<string | null>(null);
  const items = [
    { value: NONE, label: t.defaultPageNone },
    ...pages.map((p) => ({ value: p.id, label: p.name || t.untitledPage })),
  ];
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">{t.defaultPageLabel}</span>
        <SearchableSelect
          value={row.pageId ?? NONE}
          onValueChange={(v) => {
            setErr(null);
            void setDomainDefaultPage(workspaceId, row.id, v === NONE || !v ? null : v)
              .then(onChanged)
              .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
          }}
          items={items}
          placeholder={t.defaultPageNone}
          className="min-w-0 flex-1"
          aria-label={t.defaultPageLabel}
        />
      </div>
      {err ? (
        <p role="alert" className="break-all text-xs text-destructive">
          {err}
        </p>
      ) : null}
    </div>
  );
}

/** Claimed subdomain row: hostname + rename (availability-checked) + Reset
 *  (fresh random name) + release + default-page picker. */
export function SubdomainRow({
  workspaceId,
  row,
  pages,
  onChanged,
}: {
  workspaceId: string;
  row: WorkspaceDomainRow;
  pages: ViewListRow[];
  onChanged: () => Promise<void>;
}) {
  const t = useT().chrome.settingsModal.domains;
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(row.subdomainLabel ?? "");
  const [state, setState] = useState<
    "idle" | "checking" | "available" | "taken" | "reserved" | "invalid" | "saving"
  >("idle");
  const [err, setErr] = useState<string | null>(null);

  // Debounced availability while the rename editor is open.
  useEffect(() => {
    if (!editing) return;
    const value = label.trim().toLowerCase();
    if (!value || value === row.subdomainLabel) {
      setState("idle");
      return;
    }
    setState("checking");
    const timer = setTimeout(async () => {
      try {
        const r = await checkSubdomainAvailability(workspaceId, value);
        setState(!r.valid ? "invalid" : r.reserved ? "reserved" : r.available ? "available" : "taken");
      } catch {
        setState("idle");
      }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, editing]);

  const rename = async (value: string) => {
    setState("saving");
    setErr(null);
    try {
      await renameSubdomain(workspaceId, value);
      setEditing(false);
      await onChanged();
      setState("idle");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  };

  const save = async () => {
    const value = label.trim().toLowerCase();
    if (!value || value === row.subdomainLabel) {
      setEditing(false);
      return;
    }
    await rename(value);
  };

  // Reset = re-roll a fresh random fruit+digits name and rename to it.
  const reset = async () => {
    const ok = await confirmDialog({
      title: t.resetConfirmTitle,
      description: format(t.resetConfirmBody, { hostname: row.hostname }),
      confirmLabel: t.resetConfirmCta,
    });
    if (!ok) return;
    try {
      const s = await getSubdomainSuggestion(workspaceId);
      await rename(s.label);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const release = async () => {
    const ok = await confirmDialog({
      title: t.releaseConfirmTitle,
      description: format(t.releaseConfirmBody, { hostname: row.hostname }),
      confirmLabel: t.releaseConfirmCta,
      variant: "destructive",
    });
    if (!ok) return;
    await releaseSubdomain(workspaceId).catch(() => {});
    await onChanged();
  };

  const apexSuffix = row.subdomainLabel ? row.hostname.slice(row.subdomainLabel.length) : "";
  const statusCopy =
    state === "checking"
      ? t.labelChecking
      : state === "available"
        ? t.labelAvailable
        : state === "taken"
          ? t.labelTaken
          : state === "reserved"
            ? t.labelReserved
            : state === "invalid"
              ? t.labelInvalid
              : null;

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {editing ? (
          <div className="flex min-w-0 flex-1 items-center rounded-md border border-border bg-background transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 [&_:focus-visible]:shadow-none">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
              aria-label={t.subdomainHeading}
              className="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm outline-none focus-visible:shadow-none"
            />
            <span className="shrink-0 pr-2 text-sm text-muted-foreground">{apexSuffix}</span>
          </div>
        ) : (
          <a
            href={`https://${row.hostname}`}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 truncate text-sm hover:underline"
          >
            {row.hostname}
          </a>
        )}
        <StatusChip status={row.status} />
      </div>
      <div className="flex items-center justify-end gap-1">
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => void save()}
              disabled={state === "saving" || state === "checking" || state === "taken" || state === "reserved" || state === "invalid"}
              className="rounded px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {t.save}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setLabel(row.subdomainLabel ?? "");
                setErr(null);
              }}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              {t.cancel}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t.rename}
            </button>
            <button
              type="button"
              onClick={() => void reset()}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t.reset}
            </button>
            <button
              type="button"
              onClick={() => void release()}
              className="rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
            >
              {t.release}
            </button>
          </>
        )}
      </div>
      {editing && statusCopy ? <p className="text-xs text-muted-foreground">{statusCopy}</p> : null}
      <DefaultPagePicker workspaceId={workspaceId} row={row} pages={pages} onChanged={onChanged} />
      {err ? (
        <p role="alert" className="break-all text-xs text-destructive">
          {err}
        </p>
      ) : null}
    </div>
  );
}

/** Unclaimed state: a pre-rolled random fruit+digits label, a re-roll die,
 *  availability check, and Claim. */
export function SubdomainClaim({
  workspaceId,
  apex,
  onChanged,
}: {
  workspaceId: string;
  apex: string;
  onChanged: () => Promise<void>;
}) {
  const t = useT().chrome.settingsModal.domains;
  const [label, setLabel] = useState("");
  const [state, setState] = useState<
    "idle" | "checking" | "available" | "taken" | "reserved" | "invalid" | "claiming"
  >("idle");
  const [err, setErr] = useState<string | null>(null);

  // Pre-fill with a server-rolled random suggestion.
  useEffect(() => {
    let cancelled = false;
    void getSubdomainSuggestion(workspaceId)
      .then((s) => {
        if (!cancelled) setLabel((prev) => prev || s.label);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Debounced availability while typing a custom label.
  useEffect(() => {
    const value = label.trim().toLowerCase();
    if (!value) {
      setState("idle");
      return;
    }
    setState("checking");
    const timer = setTimeout(async () => {
      try {
        const r = await checkSubdomainAvailability(workspaceId, value);
        setState(!r.valid ? "invalid" : r.reserved ? "reserved" : r.available ? "available" : "taken");
      } catch {
        setState("idle");
      }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  const reroll = async () => {
    try {
      const s = await getSubdomainSuggestion(workspaceId);
      setLabel(s.label);
    } catch {
      // keep the current label
    }
  };

  const claim = async () => {
    const value = label.trim().toLowerCase();
    if (!value) return;
    setState("claiming");
    setErr(null);
    try {
      await claimSubdomain(workspaceId, value);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  };

  const statusCopy =
    state === "checking"
      ? t.labelChecking
      : state === "available"
        ? t.labelAvailable
        : state === "taken"
          ? t.labelTaken
          : state === "reserved"
            ? t.labelReserved
            : state === "invalid"
              ? t.labelInvalid
              : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-border bg-background transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 [&_:focus-visible]:shadow-none">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void claim();
              }
            }}
            aria-label={t.subdomainHeading}
            className="min-w-0 flex-1 bg-transparent px-3 py-1.5 text-sm outline-none focus-visible:shadow-none"
          />
          <span className="shrink-0 pr-2 text-sm text-muted-foreground">.{apex}</span>
          <button
            type="button"
            onClick={() => void reroll()}
            aria-label={t.reroll}
            title={t.reroll}
            className="shrink-0 rounded p-1 mr-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Dices className="size-4" aria-hidden />
          </button>
        </div>
        <button
          type="button"
          onClick={() => void claim()}
          disabled={
            state === "claiming" || state === "checking" || !label.trim() || state === "taken" || state === "reserved" || state === "invalid"
          }
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          {state === "claiming" ? t.claiming : t.claim}
        </button>
      </div>
      {statusCopy ? <p className="text-xs text-muted-foreground">{statusCopy}</p> : null}
      {err ? (
        <p role="alert" className="break-all text-xs text-destructive">
          {err}
        </p>
      ) : null}
    </div>
  );
}

/** A BYO custom-domain row: status + re-check (DNS rows when pending) +
 *  disconnect + default-page picker. */
export function CustomDomainRow({
  workspaceId,
  row,
  pages,
  onChanged,
}: {
  workspaceId: string;
  row: WorkspaceDomainRow;
  pages: ViewListRow[];
  onChanged: () => Promise<void>;
}) {
  const shareT = useT().docPage.share;
  const [checking, setChecking] = useState(false);
  const [instructions, setInstructions] = useState<DnsInstruction[]>([]);

  const check = async () => {
    setChecking(true);
    try {
      const r = await checkWorkspaceDomain(workspaceId, row.id);
      setInstructions(r.live ? [] : r.instructions);
      await onChanged();
    } finally {
      setChecking(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: shareT.site.removeConfirmTitle,
      description: format(shareT.site.removeConfirmBody, { hostname: row.hostname }),
      confirmLabel: shareT.site.removeConfirmCta,
      variant: "destructive",
    });
    if (!ok) return;
    await removeWorkspaceDomain(workspaceId, row.id).catch(() => {});
    await onChanged();
  };

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm">{row.hostname}</span>
        <StatusChip status={row.status} />
        <div className="flex shrink-0 items-center gap-1">
          {row.status !== "live" ? (
            <button
              type="button"
              onClick={() => void check()}
              disabled={checking}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {checking ? shareT.site.checking : shareT.site.recheck}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void remove()}
            className="rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            {shareT.site.removeDomain}
          </button>
        </div>
      </div>
      {row.status !== "live" && instructions.length ? <DnsRows instructions={instructions} /> : null}
      {row.status !== "live" && !instructions.length && row.verificationError ? (
        <p className="break-all text-xs text-muted-foreground">{row.verificationError}</p>
      ) : null}
      <DefaultPagePicker workspaceId={workspaceId} row={row} pages={pages} onChanged={onChanged} />
    </div>
  );
}

/** Connect input for a BYO hostname; shows the DNS rows right after connect. */
export function ConnectDomainForm({
  workspaceId,
  onChanged,
}: {
  workspaceId: string;
  onChanged: () => Promise<void>;
}) {
  const shareT = useT().docPage.share;
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<DnsInstruction[]>([]);

  const errCopy = (code: string): string => {
    switch (code) {
      case "hostname_taken":
        return shareT.site.errHostnameTaken;
      case "invalid_hostname":
        return shareT.site.errInvalidHostname;
      case "blocked_hostname":
        return shareT.site.errBlockedHostname;
      case "domain_limit":
        return shareT.site.errDomainLimit;
      default:
        return code;
    }
  };

  const connect = async () => {
    const hostname = input.trim();
    if (!hostname) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await connectWorkspaceDomain(workspaceId, hostname);
      setInstructions(r.instructions);
      setInput("");
      await onChanged();
    } catch (e) {
      setErr(errCopy(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void connect();
            }
          }}
          placeholder={shareT.site.domainPlaceholder}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none"
        />
        <button
          type="button"
          onClick={() => void connect()}
          disabled={busy || !input.trim()}
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          {busy ? shareT.site.connecting : shareT.site.connect}
        </button>
      </div>
      <DnsRows instructions={instructions} />
      {err ? (
        <p role="alert" className="break-all text-xs text-destructive">
          {err}
        </p>
      ) : null}
    </div>
  );
}

function EmailDomainStatusChip({ status }: { status: EmailDomainSummary["status"] }) {
  const t = useT().chrome.settingsModal.domains;
  const label =
    status === "verified"
      ? t.emailStatusVerified
      : status === "failed"
        ? t.emailStatusFailed
        : t.emailStatusPending;
  const cls =
    status === "verified"
      ? "text-emerald-600 dark:text-emerald-400"
      : status === "failed"
        ? "text-destructive"
        : "text-muted-foreground";
  return <span className={`shrink-0 text-xs font-medium ${cls}`}>{label}</span>;
}

function EmailDnsRows({ records }: { records: EmailDomainSummary["records"] }) {
  const t = useT().chrome.settingsModal.domains;
  if (records.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
      <p className="mb-2 text-muted-foreground">{t.emailDnsHint}</p>
      <div className="space-y-2 font-mono">
        {records.map((record, index) => (
          <div
            key={`${record.type}-${record.name}-${index}`}
            className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[auto_minmax(0,0.8fr)_minmax(0,1.5fr)]"
          >
            <span className="font-semibold">
              {record.type}
              {record.priority === null
                ? ""
                : ` ${format(t.emailDnsPriority, { priority: record.priority })}`}
            </span>
            <span className="min-w-0 break-all">{record.name}</span>
            <span className="min-w-0 break-all text-muted-foreground">{record.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmailDomainRow({
  workspaceId,
  domain,
  onChanged,
}: {
  workspaceId: string;
  domain: EmailDomainSummary;
  onChanged: () => Promise<void>;
}) {
  const t = useT().chrome.settingsModal.domains;
  const [busy, setBusy] = useState<"verify" | "remove" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const verify = async () => {
    setBusy("verify");
    setErr(null);
    try {
      await verifyEmailDomain({ workspaceId, domainId: domain.id });
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: t.emailRemoveConfirmTitle,
      description: format(t.emailRemoveConfirmBody, { domain: domain.domain }),
      confirmLabel: t.emailRemove,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy("remove");
    setErr(null);
    try {
      await removeEmailDomain({ workspaceId, domainId: domain.id });
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm">{domain.domain}</span>
        <EmailDomainStatusChip status={domain.status} />
        <div className="flex shrink-0 items-center gap-1">
          {domain.status !== "verified" ? (
            <button
              type="button"
              onClick={() => void verify()}
              disabled={busy !== null}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {busy === "verify" ? t.emailVerifying : t.emailVerify}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy !== null}
            className="rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            {busy === "remove" ? t.emailRemoving : t.emailRemove}
          </button>
        </div>
      </div>
      {domain.status === "verified" ? (
        <p className="text-xs text-muted-foreground">{t.emailReadyHint}</p>
      ) : (
        <EmailDnsRows records={domain.records} />
      )}
      {err ? (
        <p role="alert" className="break-all text-xs text-destructive">
          {err}
        </p>
      ) : null}
    </div>
  );
}

export function EmailDomainsPanel({
  workspaceId,
  domains,
  onChanged,
}: {
  workspaceId: string;
  domains: EmailDomainSummary[];
  onChanged: () => Promise<void>;
}) {
  const t = useT().chrome.settingsModal.domains;
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const connect = async () => {
    const domain = input.trim().toLowerCase();
    if (!domain) return;
    setBusy(true);
    setErr(null);
    try {
      await connectEmailDomain({ workspaceId, domain });
      setInput("");
      await onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErr(message === "email_domain_reserved" ? t.emailReservedError : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 border-t border-border pt-6">
      <div>
        <h3 className="text-sm font-medium">{t.emailHeading}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t.emailHint}</p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void connect();
              }
            }}
            aria-label={t.emailHeading}
            placeholder={t.emailPlaceholder}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none"
          />
          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy || !input.trim()}
            className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            {busy ? t.emailConnecting : t.emailConnect}
          </button>
        </div>
        {err ? (
          <p role="alert" className="break-all text-xs text-destructive">
            {err}
          </p>
        ) : null}
      </div>
      {domains.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.emailEmpty}</p>
      ) : (
        <div className="space-y-2">
          {domains.map((domain) => (
            <EmailDomainRow
              key={domain.id}
              workspaceId={workspaceId}
              domain={domain}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function DomainsSection() {
  const t = useT().chrome.settingsModal.domains;
  const params = useParams<{ workspaceId?: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [r, pages, emailProbe] = await Promise.all([
        listWorkspaceDomains(workspaceId),
        listViews({ workspaceId, state: "saved" }).catch(() => [] as ViewListRow[]),
        probeEmailInboxes(workspaceId).catch(() => ({ configured: false }) as const),
      ]);
      setState({
        kind: "ready",
        domains: r.domains,
        subdomainApex: r.subdomainApex,
        pages,
        emailDomains: emailProbe.configured ? emailProbe.domains : null,
      });
    } catch {
      setState({ kind: "error" });
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (state.kind === "loading") {
    return <div className="text-sm text-muted-foreground">...</div>;
  }
  if (state.kind === "error") {
    return <p className="text-sm text-destructive">{t.loadError}</p>;
  }

  const platform = state.domains.find((d) => d.provider === "platform") ?? null;
  const byo = state.domains.filter((d) => d.provider !== "platform");

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t.heading}</h2>

      <section className="border-t border-border pt-6 space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t.subdomainHeading}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t.subdomainHint}</p>
        </div>
        {platform ? (
          <SubdomainRow
            workspaceId={workspaceId}
            row={platform}
            pages={state.pages}
            onChanged={reload}
          />
        ) : state.subdomainApex ? (
          <SubdomainClaim workspaceId={workspaceId} apex={state.subdomainApex} onChanged={reload} />
        ) : (
          <p className="text-sm text-muted-foreground">{t.subdomainDark}</p>
        )}
      </section>

      <section className="border-t border-border pt-6 space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t.customHeading}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t.customHint}</p>
        </div>
        <ConnectDomainForm workspaceId={workspaceId} onChanged={reload} />
        {byo.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.customEmpty}</p>
        ) : (
          <div className="space-y-2">
            {byo.map((d) => (
              <CustomDomainRow
                key={d.id}
                workspaceId={workspaceId}
                row={d}
                pages={state.pages}
                onChanged={reload}
              />
            ))}
          </div>
        )}
      </section>

      {state.emailDomains ? (
        <EmailDomainsPanel
          workspaceId={workspaceId}
          domains={state.emailDomains}
          onChanged={reload}
        />
      ) : null}
    </div>
  );
}
