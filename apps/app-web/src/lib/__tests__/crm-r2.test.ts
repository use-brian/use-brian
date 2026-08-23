import { describe, expect, it } from "vitest";
import {
  mapCrmCsvRows,
  crmEmailApprovalQueue,
  crmFieldKeyFromLabel,
  linkedContactsForEmailApproval,
  matchingEmailApprovals,
  parseCrmCsv,
  suggestedCrmCsvMapping,
} from "@/lib/crm-r2";
import type { CrmFieldDefinition } from "@/lib/api/crm";

describe("[COMP:app-web/crm-r2] CRM R2 pure client logic", () => {
  it("parses quoted CSV and previews no more than the cap", () => {
    const preview = parseCrmCsv('Name,Email\n"Doe, Jane",jane@example.test\nSam,sam@example.test', 1);
    expect(preview.headers).toEqual(["Name", "Email"]);
    expect(preview.rows).toEqual([["Doe, Jane", "jane@example.test"]]);
    expect(preview.truncated).toBe(true);
  });

  it("maps explicitly selected columns into normalized import records", () => {
    const preview = parseCrmCsv("Full name,Tags,Value\nJane,lead|vip,$1,250".replace("$1,250", '"1,250"'));
    const mapping = suggestedCrmCsvMapping(preview.headers, "contact");
    mapping[2] = null;
    expect(mapCrmCsvRows(preview, "contact", mapping)).toEqual([
      { kind: "contact", name: "Jane", tags: ["lead", "vip"] },
    ]);
  });

  it("auto-maps and converts typed custom fields, including visible references", () => {
    const preview = parseCrmCsv("Name,Work type,Active,Referral source\nDeal one,SaaS,yes,Partner Co");
    const fields: CrmFieldDefinition[] = [
      { id: "f1", entityKind: "deal", fieldKey: "work_type", label: "Work type", fieldType: "single_select", options: ["SaaS", "Services"], isRequired: false, position: 0 },
      { id: "f2", entityKind: "deal", fieldKey: "active", label: "Active", fieldType: "boolean", options: [], isRequired: false, position: 1 },
      { id: "f3", entityKind: "deal", fieldKey: "referral_source", label: "Referral source", fieldType: "entity_reference", options: ["company"], isRequired: false, position: 2 },
    ];
    const mapping = suggestedCrmCsvMapping(preview.headers, "deal", fields);
    const records = mapCrmCsvRows(preview, "deal", mapping, fields, {
      contacts: [], deals: [], companies: [{ id: "d126f352-7f5c-48b2-88d0-66694be0c93d", name: "Partner Co", domain: null, tags: [], updatedAt: "2026-08-20T00:00:00Z" }],
    });
    expect(records).toEqual([{
      kind: "deal",
      name: "Deal one",
      customFields: {
        work_type: "SaaS",
        active: true,
        referral_source: "d126f352-7f5c-48b2-88d0-66694be0c93d",
      },
    }]);
  });

  it("only auto-maps non-Latin custom labels on an exact label match", () => {
    const fields: CrmFieldDefinition[] = [
      { id: "f1", entityKind: "company", fieldKey: "account_tier", label: "客戶級別", fieldType: "text", options: [], isRequired: false, position: 0 },
    ];
    expect(suggestedCrmCsvMapping(["客戶級別", "其他欄位"], "company", fields)).toEqual({
      0: "custom:account_tier",
      1: null,
    });
    expect(crmFieldKeyFromLabel("客戶級別")).toMatch(/^field_[a-z0-9]+$/);
    expect(crmFieldKeyFromLabel("2027 segment")).toBe("field_2027_segment");
  });

  it("matches reviewed IMAP sends by exact normalized recipient", () => {
    const contact = {
      id: "c1", name: "Jane", email: "Jane <jane@example.test>", phone: null,
      companyId: null, tags: [], updatedAt: new Date().toISOString(),
    };
    const approvals = [
      { id: "a1", kind: "workflow_step", toolName: "imapSendMessage__sales_1a2b3c4d", arguments: { to: ["jane@example.test"], subject: "Re: Hello", body: "Draft", inReplyTo: "INBOX:42" } },
      { id: "a2", kind: "workflow_step", toolName: "gmailSendMessage", arguments: { to: ["jane@example.test"], subject: "Re: Hello", body: "Draft", inReplyTo: "thread-1" } },
      { id: "a3", kind: "workflow_step", toolName: "imapSendMessage", arguments: { to: ["not-jane@example.test"], subject: "Re: Hello", body: "Draft", inReplyTo: "INBOX:43" } },
      { id: "a4", kind: "tool_invocation", toolName: "imapSendMessage", arguments: { to: ["jane@example.test"], subject: "Hello", body: "Draft" } },
    ] as never;
    expect(matchingEmailApprovals(
      { kind: "contact", row: contact },
      { contacts: [contact], companies: [], deals: [] },
      approvals,
    ).map((row) => row.id)).toEqual(["a1"]);
    expect(matchingEmailApprovals(
      { kind: "deal", row: { id: "d1", name: "Renewal", stage: "lead", amount: null, closeDate: null, contactId: null, companyId: null, updatedAt: new Date().toISOString() } },
      { contacts: [contact], companies: [], deals: [] },
      approvals,
      ["Jane <jane@example.test>"],
    ).map((row) => row.id)).toEqual(["a1"]);
    expect(linkedContactsForEmailApproval(
      approvals[0],
      { kind: "deal", row: { id: "d1", name: "Renewal", stage: "lead", amount: null, closeDate: null, contactId: null, companyId: null, updatedAt: new Date().toISOString() } },
      { contacts: [contact], companies: [], deals: [] },
      ["c1"],
    )).toEqual([contact]);
    expect(crmEmailApprovalQueue(
      { contacts: [contact], companies: [], deals: [] },
      approvals,
    ).map((item) => ({ id: item.approval.id, contacts: item.contacts.map((row) => row.id) })))
      .toEqual([{ id: "a1", contacts: ["c1"] }]);
  });
});
