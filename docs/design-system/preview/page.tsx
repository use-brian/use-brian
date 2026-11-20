import { createRoot } from "react-dom/client";
import { BrowserRouter } from "../../../apps/app-web/node_modules/react-router-dom";
import WorkflowDetailPage from "@/app/w/[workspaceId]/workflow/[id]/page";
import { ShopifySurface } from "@/components/shopify/shopify-surface";
import { WorkspaceContextProvider } from "@/lib/workspace-context";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ThemeProvider } from "@/lib/theme";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { requests } from "./page-transport";
import "./preview.css";

const route = new URLSearchParams(location.search).get("page") ?? "workflow";
const value = { workspaceId: "fictional-workspace", id: "fictional-workflow" };
const params = Object.assign(Promise.resolve(value), { status: "fulfilled", value });
Object.assign(window, { auditRequests: requests });
createRoot(document.getElementById("root")!).render(
  <BrowserRouter><I18nProvider locale="en" dict={en}><ThemeProvider>
    <WorkspaceContextProvider value={{ workspaceId: value.workspaceId, name: "Fixture workspace", role: "owner", clearance: "internal", me: { id: "fictional-user" } }}>
      <div className="audit-page">
        <aside className="audit-page-label">PRODUCTION ROUTE BODY · SYNTHETIC READ-ONLY DATA · WORKSPACE SIDEBAR / SESSION NOT MOUNTED</aside>
        <main className="min-h-0 flex-1 bg-background text-foreground">
          {route === "shopify" ? <ShopifySurface workspaceId={value.workspaceId} /> : <WorkflowDetailPage params={params} />}
        </main>
      </div>
      <ConfirmDialogProvider />
    </WorkspaceContextProvider>
  </ThemeProvider></I18nProvider></BrowserRouter>,
);
