// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api=vi.hoisted(()=>({module:vi.fn(),list:vi.fn(),orders:vi.fn()}));
vi.mock("@/lib/api/association",async original=>({...await original<typeof import("@/lib/api/association")>(),getAssociationModuleSnapshot:api.module,listAssociationPage:api.list,listAssociationOrders:api.orders}));
vi.mock("@/lib/surface-prefetch",()=>({associationModuleCacheKey:(w:string)=>`association-module:${w}:viewer`,associationPageCacheKey:(w:string,r:string,q={})=>`crm:${w}:viewer:${r}:${JSON.stringify(q)}`,associationOrdersCacheKey:(w:string,cursor:string|null,filters="")=>`association-orders:${w}:viewer:${filters}:${cursor ?? "first"}`}));
import { AssociationOverview } from "../overview";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { resetSurfaceCache } from "@/lib/surface-cache";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const u=en.associationPage.ux;
let host:HTMLDivElement,root:Root;
const future=new Date(Date.now()+86_400_000).toISOString(),past=new Date(Date.now()-86_400_000).toISOString();
beforeEach(()=>{resetSurfaceCache();vi.resetAllMocks();host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);
  api.module.mockResolvedValue({module:{workspaceId:"w",state:"enabled",version:1},canManage:true});
  api.list.mockImplementation(async(_w,r)=>({items:r==="events"?[{id:"a",status:"published",startsAt:future,endsAt:future},{id:"b",status:"draft",startsAt:future,endsAt:future}]
    :r==="waitlist"?[{id:"s",waitlistState:"waiting"},{id:"t",waitlistState:"offered"}]:r==="rescues"?[{id:"r",status:"outstanding",overdue:true}]:r==="receipts"?[{id:"p",state:"needs_reconciliation"}]:[],nextCursor:r==="events"?"more":null}));
  api.orders.mockResolvedValue({orders:[{id:"o",status:"pending",reservationExpiresAt:past}],nextCursor:null});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();});
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><AssociationOverview workspaceId="w"/></I18nProvider>));}
const tiles=()=>[...host.querySelectorAll("[data-stat-tile]")].map(tile=>tile.textContent ?? "");
describe("[COMP:app-web/association] Home overview",()=>{
  it("counts only what the first page shows and marks a further page with a plus",async()=>{
    await render();
    expect(tiles().find(text=>text.startsWith(u.upcomingEvents))).toContain("1+");
    expect(tiles().find(text=>text.startsWith(u.pendingOrdersTile))).toContain("1");
    expect(tiles().find(text=>text.startsWith(u.waitingTile))).toContain("1");
    expect(tiles().find(text=>text.startsWith(u.outstandingPayments))).toContain("1");
    expect(api.orders).toHaveBeenCalledWith("w",undefined,{status:"pending"});
    expect(host.textContent).toContain(u.overdueRow.replace("{count}","1"));
    expect(host.textContent).toContain(u.expiredHoldsRow.replace("{count}","1"));
    expect(host.textContent).toContain(u.syncIssuesRow.replace("{count}","1"));
    expect(host.textContent).not.toContain(u.nothingAttention);
  });
  it("hides owner-only tiles and actions from members and reports a quiet day honestly",async()=>{
    api.module.mockResolvedValue({module:{workspaceId:"w",state:"enabled",version:1},canManage:false});
    api.list.mockResolvedValue({items:[],nextCursor:null});api.orders.mockResolvedValue({orders:[],nextCursor:null});
    await render();
    expect(tiles().some(text=>text.startsWith(u.outstandingPayments))).toBe(false);
    expect(tiles().some(text=>text.startsWith(u.syncIssues))).toBe(false);
    expect([...host.querySelectorAll("a")].some(link=>link.textContent===u.recordOfflinePayment)).toBe(false);
    expect(api.list).not.toHaveBeenCalledWith("w","rescues",expect.anything());
    expect(host.textContent).toContain(u.nothingAttention);
  });
  it("points owners at Admin when new reservations are switched off",async()=>{
    api.module.mockResolvedValue({module:{workspaceId:"w",state:"disabled",version:1},canManage:true});
    await render();
    expect(host.textContent).toContain(u.moduleOffRow);
    expect([...host.querySelectorAll("a")].find(link=>link.getAttribute("href")==="/w/w/association?section=admin&tab=general")?.textContent).toBe(u.admin);
  });
});
