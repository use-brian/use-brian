import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/components/doc/doc-sidebar-data", () => ({ useSidebarData: () => ({ sidebarCollapsed: false, setSidebarCollapsed: vi.fn() }) }));
import { OfficeStartRecovery } from "../office-start-recovery";

describe("[COMP:app-web/office-start-recovery] Office failed-start recovery", () => {
  it("explains the orphaned shell and exposes the normal trash action", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeStartRecovery workspaceId="11111111-1111-4111-8111-111111111111" title="Company introduction" family="presentation" canTrash state="idle" onTrash={vi.fn()} /></I18nProvider>);
    expect(html).toContain("This Office creation did not start");
    expect(html).toContain("Move to Trash");
    expect(html).toContain("/w/11111111-1111-4111-8111-111111111111/office");
    expect(html).not.toContain(">Working<");
  });
});
