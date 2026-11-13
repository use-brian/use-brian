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
beforeEach(()=>{
  resetSurfaceCache();vi.resetAllMocks();host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);
  api.module.mockResolvedValue({module:{workspaceId:"w",state:"enabled",version:1},canManage:true});
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();});
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><AssociationOverview workspaceId="w"/></I18nProvider>));}
const destinations=()=>[...host.querySelectorAll("a")].map(link=>link.getAttribute("href"));
describe("[COMP:app-web/association] Staff landing page",()=>{
  it("opens the four staff destinations without fetching technical operational queues",async()=>{
    await render();
    expect(destinations()).toEqual(["events&new=1","events&filter=drafts","contacts&status=new","events","plans","memberships","contacts"].map(section=>`/w/w/association?section=${section}`));
    expect(api.orders).not.toHaveBeenCalled();
    expect(api.list).not.toHaveBeenCalled();
  });
  it("keeps the read-only destinations available without the new event shortcut",async()=>{
    api.module.mockResolvedValue({module:{workspaceId:"w",state:"enabled",version:1},canManage:false});
    await render();
    expect(destinations()).toHaveLength(5);
    expect(host.textContent).toContain(u.members);
    expect(host.textContent).not.toContain(en.associationPage.manage.newEvent);
  });
});
