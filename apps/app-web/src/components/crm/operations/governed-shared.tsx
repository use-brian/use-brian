"use client";

/**
 * Shared pieces of the governed-records UI: localized refusals, value
 * formatting for change-request diffs (catalog labels, member names, "not
 * set" for an explicit absence), and the small state badges.
 *
 * Work status is delivery progress and is always labelled apart from the
 * sales pipeline stage. A won deal is not finished work, an issued invoice,
 * or a payment.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Governed engagement and billing".
 * [COMP:app-web/crm-commercial-operations]
 */

import type { CrmBillingRequestState, CrmCatalogKind, CrmChangeRequestState, CrmGovernance } from "@/lib/api/crm-governed";
import type { CrmReferenceRequestError } from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { describeCommercialRefusal, type CommercialCopy } from "./commercial-shared";

export type GovernedCopy = Dictionary["crmPage"]["governed"];
export type GovernedMember = { userId: string; name: string };

/** A truthful sentence for a definite refusal on a governed command. */
export function describeGovernedRefusal(error: CrmReferenceRequestError, g: GovernedCopy, commercial: CommercialCopy): string {
  const reason = error.reason;
  if (reason && reason in g.refusals) return g.refusals[reason as keyof GovernedCopy["refusals"]];
  if (error.code === "catalog_key_invalid") return g.refusals.catalog_key_invalid;
  if (error.code === "invalid_transition") return g.refusals.invalid_transition;
  return describeCommercialRefusal(error, commercial);
}

/** The label of a catalog key; an unknown key is shown as itself. */
export function catalogLabel(governance: CrmGovernance | null, catalog: CrmCatalogKind, key: string | null | undefined): string | null {
  if (!key) return null;
  const entry = governance?.catalogs.find((item) => item.catalog === catalog)?.entries.find((item) => item.key === key);
  return entry?.label ?? key;
}

export function memberLabel(members: readonly GovernedMember[], userId: string | null | undefined): string | null {
  if (!userId) return null;
  return members.find((member) => member.userId === userId)?.name ?? userId;
}

type ValueContext = { g: GovernedCopy; members: readonly GovernedMember[]; governance: CrmGovernance | null };

/**
 * One field value in a diff or summary. `null` is a recorded "not set";
 * `undefined` means the field has no value to show (for example the current
 * value of a record that does not exist yet).
 */
export function formatGovernedValue(field: string, value: unknown, context: ValueContext): string {
  const { g, members, governance } = context;
  if (value === undefined) return g.noValue;
  if (value === null || value === "") return g.notSet;
  const key = field.startsWith("engagement.") ? field.slice("engagement.".length) : field;
  if (key === "serviceCategory" && typeof value === "string") return catalogLabel(governance, "service_category", value) ?? value;
  if (key === "workStatus" && typeof value === "string") return catalogLabel(governance, "work_status", value) ?? value;
  if (key === "ownerUserId" && typeof value === "string") return memberLabel(members, value) ?? value;
  if (key === "participantIds" && Array.isArray(value)) {
    return value.length ? value.map((id) => memberLabel(members, String(id)) ?? String(id)).join(", ") : g.notSet;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The localized label of a change-set field (`name`, `engagement.deadline`, ...). */
export function governedFieldLabel(field: string, g: GovernedCopy): string {
  const key = field.startsWith("engagement.") ? field.slice("engagement.".length) : field;
  return key in g.fields ? g.fields[key as keyof GovernedCopy["fields"]] : key;
}

const CHANGE_TONE: Record<CrmChangeRequestState, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  returned: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
  approved: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
  rejected: "bg-destructive/10 text-destructive",
  withdrawn: "bg-muted text-muted-foreground line-through",
};

export function ChangeRequestStateBadge({ state }: { state: CrmChangeRequestState }) {
  const g = useT().crmPage.governed;
  return (
    <span data-change-request-state={state} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${CHANGE_TONE[state]}`}>
      {g.changeStates[state]}
    </span>
  );
}

const BILLING_TONE: Record<CrmBillingRequestState, string> = {
  draft: "bg-muted text-muted-foreground",
  review: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  ready_to_bill: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
  invoiced: "bg-muted text-foreground/80",
  returned: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
  cancelled: "bg-muted text-muted-foreground line-through",
};

export function BillingStateBadge({ state, step }: { state: CrmBillingRequestState; step: "reviewer" | "finance" | null }) {
  const g = useT().crmPage.governed;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span data-billing-state={state} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${BILLING_TONE[state]}`}>
        {g.billingStates[state]}
      </span>
      {state === "review" && step && (
        <span data-billing-step={step} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          {g.reviewSteps[step]}
        </span>
      )}
    </span>
  );
}

/** A section heading inside a record panel. */
export function GovernedHeading({ title, help }: { title: string; help?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium">{title}</div>
      {help && <p className="text-[11px] text-muted-foreground">{help}</p>}
    </div>
  );
}
