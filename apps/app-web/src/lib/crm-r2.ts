/**
 * Pure CRM R2 client logic: CSV preview/mapping and record-scoped email
 * approval matching. No React and no IO.
 *
 * [COMP:app-web/crm-r2]
 */

import type { PendingApprovalRow } from "@/lib/api/approvals";
import { isReviewedWorkflowEmailApproval } from "@/lib/approval-previews";
import type {
  CrmCompanyRow,
  CrmContactRow,
  CrmData,
  CrmDealRow,
} from "@/lib/api/crm";

export type CsvPreview = {
  headers: string[];
  rows: string[][];
  truncated: boolean;
};

export function parseCrmCsv(source: string, limit = 500): CsvPreview {
  const text = source.replace(/^\uFEFF/, "");
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) quoted = true;
    else if (char === ",") {
      row.push(field.trim());
      field = "";
    } else if (char === "\n") {
      row.push(field.trim());
      table.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    table.push(row);
  }
  const nonEmpty = table.filter((cells) => cells.some((cell) => cell.length > 0));
  const headers = nonEmpty[0] ?? [];
  const data = nonEmpty.slice(1);
  return {
    headers,
    rows: data.slice(0, limit),
    truncated: data.length > limit,
  };
}

export type CrmImportKind = "contact" | "company" | "deal";

export const CRM_IMPORT_FIELDS: Record<CrmImportKind, string[]> = {
  contact: ["name", "email", "phone", "companyId", "tags"],
  company: ["name", "domain", "tags"],
  deal: [
    "name",
    "stage",
    "amount",
    "currencyCode",
    "closeDate",
    "contactId",
    "companyId",
    "source",
  ],
};

function autoField(header: string, kind: CrmImportKind): string | null {
  const normalized = header.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const aliases: Record<string, string> = {
    fullname: "name",
    contactname: "name",
    companyname: "name",
    dealname: "name",
    emailaddress: "email",
    phonenumber: "phone",
    companyid: "companyId",
    contactid: "contactId",
    closedate: "closeDate",
    currency: "currencyCode",
    currencycode: "currencyCode",
  };
  const candidate = aliases[normalized]
    ?? CRM_IMPORT_FIELDS[kind].find(
      (field) => field.toLowerCase() === normalized,
    );
  return candidate ?? null;
}

export function suggestedCrmCsvMapping(
  headers: readonly string[],
  kind: CrmImportKind,
): Record<number, string | null> {
  return Object.fromEntries(headers.map((header, index) => [index, autoField(header, kind)]));
}

export function mapCrmCsvRows(
  preview: CsvPreview,
  kind: CrmImportKind,
  mapping: Record<number, string | null>,
): Record<string, unknown>[] {
  return preview.rows.map((cells) => {
    const record: Record<string, unknown> = { kind };
    for (const [indexText, target] of Object.entries(mapping)) {
      if (!target) continue;
      const raw = cells[Number(indexText)] ?? "";
      if (!raw) continue;
      if (target === "tags") record.tags = raw.split(/[|;]/).map((v) => v.trim()).filter(Boolean);
      else if (target === "amount") {
        const amount = Number(raw.replace(/[^0-9.-]/g, ""));
        if (Number.isFinite(amount)) record.amount = amount;
      } else record[target] = raw;
    }
    return record;
  });
}

function bareAddress(value: string): string {
  const angle = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

function approvalRecipients(row: PendingApprovalRow): string[] {
  const raw = row.arguments.to;
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return values.filter((v): v is string => typeof v === "string").map(bareAddress);
}

export type CrmApprovalRecord =
  | { kind: "deal"; row: CrmDealRow }
  | { kind: "contact"; row: CrmContactRow }
  | { kind: "company"; row: CrmCompanyRow };

function recordContactEmails(record: CrmApprovalRecord, data: CrmData): string[] {
  const emails: string[] = [];
  if (record.kind === "contact" && record.row.email) emails.push(record.row.email);
  if (record.kind === "deal" && record.row.contactId) {
    const contact = data.contacts.find((row) => row.id === record.row.contactId);
    if (contact?.email) emails.push(contact.email);
  }
  if (record.kind === "company") {
    for (const contact of data.contacts) {
      if (contact.companyId === record.row.id && contact.email) emails.push(contact.email);
    }
  }
  return [...new Set(emails.map(bareAddress))];
}

export function matchingEmailApprovals(
  record: CrmApprovalRecord,
  data: CrmData,
  approvals: readonly PendingApprovalRow[],
  linkedEmails: readonly string[] = [],
): PendingApprovalRow[] {
  const emails = new Set([
    ...recordContactEmails(record, data),
    ...linkedEmails.map(bareAddress),
  ]);
  if (emails.size === 0) return [];
  return approvals.filter((row) =>
    isReviewedWorkflowEmailApproval(row)
    && approvalRecipients(row).some((address) => emails.has(address)),
  );
}

export { formatCurrencyTotals } from "@/lib/crm-view";
