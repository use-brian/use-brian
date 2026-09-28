// @vitest-environment jsdom
/** Protected exact-page PDF signature approval card.
 * [COMP:app-web/pdf-signature-approval] */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

const api = vi.hoisted(() => ({ fetchPdfSignaturePreview: vi.fn() }));
vi.mock("@/lib/api/approvals", () => ({
  fetchPdfSignaturePreview: (...args: unknown[]) => api.fetchPdfSignaturePreview(...args),
}));

import { ToolPreview } from "../approval-tool-previews";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const dict = en as unknown as Dictionary;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
let host: HTMLElement;
let root: Root;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={dict}>
        <ToolPreview
          preview={{ kind: "pdf_signature" }}
          attachmentLines={[]}
          approvalId="approval-1"
          displayLines={["Page 2; rectangle x=12, y=34, width=150, height=42"]}
        />
      </I18nProvider>,
    );
    await settle();
  });
}

beforeEach(() => {
  api.fetchPdfSignaturePreview.mockReset();
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:pdf-signature-preview");
    static revokeObjectURL = vi.fn();
  });
});

afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe("[COMP:app-web/pdf-signature-approval] protected preview card", () => {
  it("fetches by approval id and renders the server-composited page plus exact target copy", async () => {
    api.fetchPdfSignaturePreview.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    await mount();
    expect(api.fetchPdfSignaturePreview).toHaveBeenCalledWith("approval-1");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:pdf-signature-preview");
    expect(host.textContent).toContain("Page 2; rectangle x=12, y=34, width=150, height=42");
    expect(host.textContent).toContain(en.approvalsPage.pdfSignaturePreview.notice);
  });

  it("shows a stale state without exposing frozen arguments when the protected preview is denied", async () => {
    api.fetchPdfSignaturePreview.mockRejectedValue(new Error("pdf_signature_approval_stale"));
    await mount();
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain(en.approvalsPage.pdfSignaturePreview.stale);
    expect(host.textContent).not.toContain("signatureResourceId");
  });
});
