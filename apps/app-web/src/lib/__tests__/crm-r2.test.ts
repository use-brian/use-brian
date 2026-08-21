import { describe, expect, it } from "vitest";
import {
  mapCrmCsvRows,
  matchingEmailApprovals,
  parseCrmCsv,
  suggestedCrmCsvMapping,
} from "@/lib/crm-r2";

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
  });
});
