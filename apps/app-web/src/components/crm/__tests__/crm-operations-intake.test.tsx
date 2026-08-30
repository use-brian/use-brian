// @vitest-environment jsdom

/** [COMP:app-web/crm-operations] Intake definitions and credential controls. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createCrmIntakeCredential: vi.fn(),
  listCrmIntakeCredentials: vi.fn(),
  listCrmIntakeDefinitions: vi.fn(),
  revokeCrmIntakeCredential: vi.fn(),
  saveCrmIntakeDefinition: vi.fn(),
}));

vi.mock("@/lib/api/crm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm")>(),
  ...api,
}));

import { CrmIntakeSettings } from "../operations/intake-settings";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const definition = {
  id: "00000000-0000-4000-8000-000000000010",
  definitionKey: "website_contact",
  label: "Website contact",
  active: true,
  currentVersion: 2,
  fields: [],
  identityPolicy: "trusted_verified_email" as const,
  consentMappings: [],
  queueKey: "general",
  maxPayloadBytes: 65_536,
  schemaHash: "schema-hash",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const credential = {
  id: "00000000-0000-4000-8000-000000000020",
  label: "Production form",
  prefix: "sk_intake_demo",
  definitionIds: [definition.id],
  revokedAt: null,
  lastUsedAt: null,
  createdAt: "2026-08-30T00:00:00.000Z",
};

let host: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  api.listCrmIntakeDefinitions.mockResolvedValue([definition]);
  api.listCrmIntakeCredentials.mockResolvedValue([credential]);
  api.saveCrmIntakeDefinition.mockResolvedValue({ record: definition, created: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={en}>
        <CrmIntakeSettings workspaceId="workspace-1" />
      </I18nProvider>,
    );
  });
  await settle();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
});

describe("[COMP:app-web/crm-operations] CRM intake settings", () => {
  it("shows definitions and credential metadata without exposing a stored secret", () => {
    expect(host.textContent).toContain("Website contact");
    expect(host.textContent).toContain("website_contact · v2");
    expect(host.textContent).toContain("Production form");
    expect(host.textContent).toContain("sk_intake_demo · Active");
    expect(host.textContent).not.toContain("secret_hash");
  });

  it("submits a bounded starter definition through the canonical settings API", async () => {
    const inputs = host.querySelectorAll<HTMLInputElement>("input");
    await act(async () => {
      setInput(inputs[0], "Partner form");
      setInput(inputs[1], "partner_form");
    });

    const create = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === en.crmPage.operations.createDefinition,
    );
    expect(create?.disabled).toBe(false);
    await act(async () => { create?.click(); });
    await settle();

    expect(api.saveCrmIntakeDefinition).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        definitionKey: "partner_form",
        label: "Partner form",
        definition: expect.objectContaining({
          identityPolicy: "trusted_verified_email",
          maxPayloadBytes: 65_536,
        }),
      }),
    );
  });
});
