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
  CrmEmailDraft,
  CrmFieldDefinition,
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

/** Derive a valid stable key without forcing operators to type an identifier. */
export function crmFieldKeyFromLabel(label: string): string {
  const slug = label.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 57);
  if (/^[a-z]/.test(slug)) return slug;
  if (slug) return `field_${slug}`;
  let hash = 2_166_136_261;
  for (const character of label.trim()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `field_${(hash >>> 0).toString(36)}`;
}

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

function autoField(
  header: string,
  kind: CrmImportKind,
  fields: readonly CrmFieldDefinition[] = [],
): string | null {
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
  if (candidate) return candidate;
  const entityKind = kind === "contact" ? "person" : kind;
  const exactLabel = header.trim().toLocaleLowerCase();
  const custom = fields.find((field) =>
    field.entityKind === entityKind
    && (
      field.label.trim().toLocaleLowerCase() === exactLabel
      || (normalized.length > 0
        && field.fieldKey.toLowerCase().replace(/[^a-z0-9]+/g, "") === normalized)
    ),
  );
  return custom ? `custom:${custom.fieldKey}` : null;
}

export function suggestedCrmCsvMapping(
  headers: readonly string[],
  kind: CrmImportKind,
  fields: readonly CrmFieldDefinition[] = [],
): Record<number, string | null> {
  return Object.fromEntries(headers.map((header, index) => [index, autoField(header, kind, fields)]));
}

function referenceValue(
  raw: string,
  field: CrmFieldDefinition,
  data?: CrmData | null,
): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    return raw;
  }
  if (!data) return raw;
  const candidates = [
    ...(field.options.includes("person") ? data.contacts : []),
    ...(field.options.includes("company") ? data.companies : []),
    ...(field.options.includes("deal") ? data.deals : []),
  ].filter((row) => row.name.trim().toLowerCase() === raw.trim().toLowerCase());
  return candidates.length === 1 ? candidates[0].id : raw;
}

function customValue(
  raw: string,
  field: CrmFieldDefinition,
  data?: CrmData | null,
): unknown {
  switch (field.fieldType) {
    case "number": {
      const value = Number(raw.replace(/,/g, ""));
      return Number.isFinite(value) ? value : raw;
    }
    case "boolean": {
      const normalized = raw.trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(normalized)) return true;
      if (["false", "no", "n", "0"].includes(normalized)) return false;
      return raw;
    }
    case "multi_select":
      return raw.split(/[|;]/).map((value) => value.trim()).filter(Boolean);
    case "entity_reference":
      return referenceValue(raw, field, data);
    default:
      return raw;
  }
}

export function mapCrmCsvRows(
  preview: CsvPreview,
  kind: CrmImportKind,
  mapping: Record<number, string | null>,
  fields: readonly CrmFieldDefinition[] = [],
  data?: CrmData | null,
): Record<string, unknown>[] {
  const fieldsByKey = new Map(fields.map((field) => [field.fieldKey, field]));
  return preview.rows.map((cells) => {
    const record: Record<string, unknown> = { kind };
    for (const [indexText, target] of Object.entries(mapping)) {
      if (!target) continue;
      const raw = cells[Number(indexText)] ?? "";
      if (!raw) continue;
      if (target.startsWith("custom:")) {
        const field = fieldsByKey.get(target.slice("custom:".length));
        if (!field) continue;
        const customFields = record.customFields && typeof record.customFields === "object"
          ? record.customFields as Record<string, unknown>
          : {};
        customFields[field.fieldKey] = customValue(raw, field, data);
        record.customFields = customFields;
      } else if (target === "tags") record.tags = raw.split(/[|;]/).map((v) => v.trim()).filter(Boolean);
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

export type CrmEmailApprovalQueueItem = {
  approval: PendingApprovalRow;
  contacts: CrmContactRow[];
};

/**
 * Project the workspace approval queue into the CRM email-review inbox.
 * Only the strict reviewed-workflow shape and an exact visible contact-email
 * match qualify. Unlinked outbound approvals remain in the global approval
 * queue instead of inventing a CRM relationship from a subject or name.
 */
export function crmEmailApprovalQueue(
  data: CrmData,
  approvals: readonly PendingApprovalRow[],
): CrmEmailApprovalQueueItem[] {
  return approvals.flatMap((approval) => {
    if (!isReviewedWorkflowEmailApproval(approval)) return [];
    const recipients = new Set(approvalRecipients(approval));
    const contacts = data.contacts.filter(
      (contact) => contact.email && recipients.has(bareAddress(contact.email)),
    );
    return contacts.length > 0 ? [{ approval, contacts }] : [];
  });
}

/** Exact-address relationship context for a canonical chat-authored draft. */
export function crmEmailDraftContacts(
  data: CrmData,
  draft: CrmEmailDraft,
): CrmContactRow[] {
  const recipients = new Set([...draft.to, ...draft.cc].map(bareAddress));
  return data.contacts.filter(
    (contact) => contact.email && recipients.has(bareAddress(contact.email)),
  );
}

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

/** Exact CRM people represented by one frozen reviewed-email recipient. */
export function linkedContactsForEmailApproval(
  row: PendingApprovalRow,
  record: CrmApprovalRecord,
  data: CrmData,
  participantContactIds: readonly string[] = [],
): CrmContactRow[] {
  const recipients = new Set(approvalRecipients(row));
  const candidateIds = new Set<string>();
  if (record.kind === "contact") candidateIds.add(record.row.id);
  if (record.kind === "company") {
    for (const contact of data.contacts) {
      if (contact.companyId === record.row.id) candidateIds.add(contact.id);
    }
  }
  if (record.kind === "deal") {
    if (record.row.contactId) candidateIds.add(record.row.contactId);
    for (const id of participantContactIds) candidateIds.add(id);
  }
  return data.contacts.filter((contact) =>
    candidateIds.has(contact.id)
    && Boolean(contact.email)
    && recipients.has(bareAddress(contact.email!)),
  );
}

export { formatCurrencyTotals } from "@/lib/crm-view";
