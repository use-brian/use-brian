// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("../../../../desktop/shims/next-navigation"));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => ({ crmPage: { r2: {
  recordNotFound: "Record unavailable", recordNotFoundDescription: "Check the address", returnToCrm: "Return to CRM",
} } }) }));

const lifecycle = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock("../crm-surface", () => ({
  CrmSurface: ({ routeRecord }: { routeRecord: { kind: string; id: string } | null }) => {
    const [selected, setSelected] = useState(false);
    useEffect(() => { lifecycle.mount(); return () => { lifecycle.unmount(); }; }, []);
    return <div>
      <button onClick={() => setSelected(!selected)} aria-pressed={selected}>Select row</button>
      <div data-record>{routeRecord ? `${routeRecord.kind}:${routeRecord.id}` : "collection"}</div>
    </div>;
  },
}));

import { CrmWorkspace } from "../crm-workspace";
import CrmPage from "@/app/w/[workspaceId]/crm/page";
import CrmRecordPage from "@/app/w/[workspaceId]/crm/[kind]/[recordId]/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let navigate: ReturnType<typeof useNavigate>;
let currentUrl: string;
function Navigation() {
  navigate = useNavigate();
  const location = useLocation();
  currentUrl = location.pathname + location.search;
  return null;
}
async function mount(url = "/w/workspace-one/crm?section=contacts&q=example") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[url]}>
    <Navigation />
    <Routes>
      <Route path="/w/:workspaceId/crm" element={<CrmWorkspace />}>
        <Route index element={<CrmPage />} />
        <Route path=":kind/:recordId" element={<CrmRecordPage />} />
      </Route>
    </Routes>
  </MemoryRouter>));
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("[COMP:app-web/crm-record-route] persistent CRM workspace", () => {
  it("keeps collection state and DOM through open, switch, close, Back and Forward", async () => {
    await mount();
    const collectionUrl = currentUrl;
    const row = container.querySelector("button")!;
    await act(async () => row.click());
    const first = "/w/workspace-one/crm/contact/person-one?section=contacts&q=example";
    const second = "/w/workspace-one/crm/company/company-one?section=contacts&q=example";
    for (const [url, detail] of [[first, "contact:person-one"], [second, "company:company-one"], [collectionUrl, "collection"]]) {
      await act(async () => navigate(url));
      expect(container.querySelector("[data-record]")?.textContent).toBe(detail);
      expect(container.querySelector("button")).toBe(row);
      expect(row.getAttribute("aria-pressed")).toBe("true");
    }
    await act(async () => navigate(-1));
    expect(currentUrl).toBe(second);
    expect(container.querySelector("[data-record]")?.textContent).toBe("company:company-one");
    await act(async () => navigate(1));
    expect(currentUrl).toBe(collectionUrl);
    expect(container.querySelector("button")).toBe(row);
    expect(lifecycle.mount).toHaveBeenCalledTimes(1);
    expect(lifecycle.unmount).not.toHaveBeenCalled();
  });

  it("cold-loads a canonical record without a collection visit", async () => {
    await mount("/w/workspace-one/crm/deal/deal-one");
    expect(container.querySelector("[data-record]")?.textContent).toBe("deal:deal-one");
  });

  it("does not mount record content for an invalid kind", async () => {
    await mount("/w/workspace-one/crm/unknown/record-one");
    expect(container.textContent).toContain("Record unavailable");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/w/workspace-one/crm");
    expect(lifecycle.mount).not.toHaveBeenCalled();
  });
});
