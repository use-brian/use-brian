import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/components/doc/doc-sidebar-data", () => ({ useSidebarData: () => ({ sidebarCollapsed: false, setSidebarCollapsed: vi.fn() }) }));
import { OfficeStartRecovery, OfficeGenerationPending } from "../office-start-recovery";

describe("[COMP:app-web/office-start-recovery] Office failed-start recovery", () => {
  it("explains the orphaned shell and exposes the normal trash action", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeStartRecovery workspaceId="11111111-1111-4111-8111-111111111111" title="Company introduction" family="presentation" canTrash state="idle" onTrash={vi.fn()} /></I18nProvider>);
    expect(html).toContain("This Office creation did not start");
    expect(html).toContain("Move to Trash");
    expect(html).toContain("/w/11111111-1111-4111-8111-111111111111/office");
    expect(html).not.toContain(">Working<");
  });
});

describe("[COMP:app-web/office-generation-pending] Office generation canvas status",()=>{
  it.each(["needs_input","failed","cancelled","completed"] as const)("never labels a %s job as Working",status=>{
    const html=renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeGenerationPending job={{id:"job",status,stage:status,errorCode:null}}/></I18nProvider>);
    expect(html).not.toContain(">Working<");
    if(status==="needs_input") {
      expect(html).toContain(en.office.eventNeedsInput);
      expect(html).toContain(en.office.generationWaitingForInput);
    }
  });
  const paint=(node:React.ReactNode)=>renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}>{node}</I18nProvider>);
  it("shows a running job's latest persisted stage from the stream",()=>{
    const html=paint(<OfficeGenerationPending job={{id:"job",status:"running",stage:"grounding",errorCode:null}} stream={{job:{id:"job",workspaceId:"w",artifactId:"a",status:"running",stage:"grounding",errorCode:null},events:[{id:"e",seq:2,code:"office.job.grounding_started",params:{},safeNarration:null,createdAt:"2026-10-10T00:00:00Z"}],connection:"live",ended:null}}/>);
    expect(html).toContain(en.office.eventGrounding);
  });
  it("falls back to the projected latest event, and to a skeleton rather than text when nothing is persisted",()=>{
    expect(paint(<OfficeGenerationPending job={{id:"job",status:"running",stage:"x",errorCode:null,latestEvent:{code:"office.job.started",safeNarration:"Started"}}}/>)).toContain(en.office.eventStarted);
    const bare=paint(<OfficeGenerationPending job={{id:"job",status:"running",stage:"x",errorCode:null}}/>);
    expect(bare).toContain('data-office-job-skeleton="true"');
  });
  it("names a dropped stream instead of presenting the last stage as live",()=>{
    const html=paint(<OfficeGenerationPending job={{id:"job",status:"running",stage:"x",errorCode:null}} stream={{job:{id:"job",workspaceId:"w",artifactId:"a",status:"running",stage:"x",errorCode:null},events:[],connection:"offline",ended:null}}/>);
    expect(html).toContain(en.office.jobOffline);
  });
  it("renders a snapshot read failure as an error with Retry, not a pending label",()=>{
    const html=paint(<OfficeGenerationPending job={{id:"job",status:"completed",stage:"completed",errorCode:null}} onRetry={vi.fn()}/>);
    expect(html).toContain(en.office.snapshotLoadFailed);
    expect(html).toContain(en.office.retryLoad);
    expect(html).toContain('role="alert"');
  });
});
