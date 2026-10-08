// @vitest-environment jsdom
import {act,type ReactNode} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
const api=vi.hoisted(()=>({viewer:"viewer",binding:vi.fn(),catalog:vi.fn(),resources:vi.fn(),create:vi.fn(),revoke:vi.fn(),list:vi.fn(),confirm:vi.fn()}));
vi.mock("@/lib/api/crm-administration",()=>({getCrmCredentialBindingOptions:api.binding,getCrmCredentialCatalog:api.catalog,getCrmScopeResources:api.resources,createCrmCredential:api.create,revokeCrmCredential:api.revoke}));
vi.mock("@/lib/api/association",()=>({listAssociationPage:api.list}));
vi.mock("@/components/ui/confirm-dialog",()=>({confirmDialog:api.confirm}));
vi.mock("@/lib/surface-prefetch",()=>({associationPageCacheKey:(w:string,r:string,q={})=>`crm:${w}:${api.viewer}:${r}:${JSON.stringify(q)}`,associationIntentKey:(w:string,op:string,target:string)=>`request:${w}:${api.viewer}:${op}:${target}`}));
import {AssociationCredentialForm,AssociationCredentialsPanel} from "../credentials-panel";
import {I18nProvider} from "@/lib/i18n/client";
import {en} from "@/lib/i18n/dictionaries/en";
import {resetSurfaceCache} from "@/lib/surface-cache";
const t=en.associationPage,a=t.admin;
const credential={id:"credential-old",label:"Fictional integration",prefix:"sk_crm_safe_prefix",expiresAt:"2028-01-01T00:00:00Z",revokedAt:null,createdAt:"2026-01-01T00:00:00Z",lastUsedAt:null,grants:[{operation:"association.read",selectors:{eventIds:["event-one"]}}]};
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
async function render(node:ReactNode){await act(async()=>root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>));}
async function click(label:string){const b=[...host.querySelectorAll("button")].find(b=>b.textContent===label);expect(b,`Missing ${label}`).toBeTruthy();await act(async()=>b!.click());}
async function toggle(label:string){const l=[...host.querySelectorAll("label")].find(l=>l.textContent===label);const b=l?.querySelector('button,[role="checkbox"]');expect(b,`Missing toggle ${label}`).toBeTruthy();await act(async()=>{(b as HTMLElement).click();});}
async function field(label:string,value:string){const el=[...host.querySelectorAll("label")].find(l=>l.firstChild?.textContent===label)?.querySelector("input")!;expect(el).toBeTruthy();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));});}
async function submit(){await act(async()=>{host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});}
async function setupForm(rotate=false){await render(<AssociationCredentialForm workspaceId="w" disabled={false} rotate={rotate?credential:undefined} onSaved={()=>{}}/>);await field(a.label,"Backend access");await field(a.expiry,"2028-01-01T00:00");await toggle(a.operationLabels["association.read"]);}
beforeEach(()=>{api.viewer="viewer";resetSurfaceCache();sessionStorage.clear();vi.resetAllMocks();api.binding.mockResolvedValue({mode:"legacy",choices:[],assistants:[],validForMs:30000});api.catalog.mockResolvedValue({operations:["association.read","crm.records.read"],selectors:{"association.read":["eventIds"],"crm.records.read":[]}});api.resources.mockResolvedValue({eventIds:[{id:"event-one",label:"Workshop"}],planIds:[],definitionIds:[],purposeKeys:[]});api.confirm.mockResolvedValue(true);api.create.mockResolvedValue({...credential,oneTimeSecret:"fixture-secret-once"});api.list.mockResolvedValue({items:[credential],nextCursor:null});api.revoke.mockResolvedValue({revoked:true});host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers();});
describe("[COMP:app-web/association] Owner scoped-key administration",()=>{
  it("recovers an unsent draft after the management boundary unmounts without exposing it while denied",async()=>{
    await render(<AssociationCredentialsPanel workspaceId="w" disabled={false}/>);await click(a.createKey);
    await field(a.label,"Unsent fixture");await field(a.expiry,"2028-01-01T00:00");await toggle(a.operationLabels["association.read"]);await toggle("Workshop (event-one)");
    await render(<AssociationCredentialsPanel workspaceId="w" disabled/>);expect(host.querySelector("form")).toBeNull();expect(host.textContent).not.toContain("Unsent fixture");
    resetSurfaceCache();await render(<AssociationCredentialsPanel workspaceId="w" disabled={false}/>);
    expect(host.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value).toBe("Unsent fixture");
    await submit();expect(api.create.mock.calls[0][1]).toMatchObject({label:"Unsent fixture",grants:[{operation:"association.read",selectors:{eventIds:["event-one"]}}]});
    await render(null);await render(<AssociationCredentialsPanel workspaceId="w" disabled={false}/>);
    expect(host.querySelector('input[value="fixture-secret-once"]')).toBeNull();expect(JSON.stringify(sessionStorage)).not.toContain("fixture-secret-once");await submit();expect(api.create).toHaveBeenCalledTimes(1);
  });
  it("isolates drafts and editor targets by viewer, workspace and rotation target",async()=>{
    await setupForm();await field(a.label,"Original draft");
    for(const props of [{workspaceId:"other",disabled:false},{workspaceId:"w",disabled:false,rotate:credential}]){
      await render(<AssociationCredentialForm {...props} onSaved={()=>{}}/>);expect(host.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value).toBe("");
    }
    api.viewer="different-viewer";await render(<AssociationCredentialForm workspaceId="w" disabled={false} onSaved={()=>{}}/>);expect(host.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value).toBe("");
    api.viewer="viewer";await render(<AssociationCredentialForm workspaceId="w" disabled={false} onSaved={()=>{}}/>);expect(host.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value).toBe("Original draft");
  });
  it("does not reopen a rotation from a stale or unauthorized credential record",async()=>{
    await render(<AssociationCredentialsPanel workspaceId="w" disabled={false}/>);await click(a.rotateKey);await field(a.label,"Rotation draft");
    await render(null);resetSurfaceCache();api.list.mockResolvedValue({items:[],nextCursor:null});await render(<AssociationCredentialsPanel workspaceId="w" disabled={false}/>);
    expect(host.querySelector("form")).toBeNull();expect(host.textContent).not.toContain("Rotation draft");expect(api.create).not.toHaveBeenCalled();
  });
  it("resets malformed stored drafts without treating browser storage as authority",async()=>{
    await setupForm();await render(null);
    const key=Object.keys(sessionStorage).find(k=>k.includes("credential-draft"))!;sessionStorage.setItem(key,JSON.stringify({label:"bad",grants:[null]}));
    await render(<AssociationCredentialForm workspaceId="w" disabled={false} onSaved={()=>{}}/>);
    expect(host.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value).toBe("");await submit();expect(api.create).not.toHaveBeenCalled();
  });
  it("uses staff permission labels and keeps operation codes in closed technical details",async()=>{
    await setupForm();
    expect(host.querySelector('input[aria-label="association.read"]')).toBeNull();
    const code=[...host.querySelectorAll("code")].find(node=>node.textContent==="association.read");
    expect(code?.closest("details")?.open).toBe(false);
    expect(host.textContent).toContain(a.operationLabels["association.read"]);
    api.catalog.mockResolvedValue({operations:["future.operation"],selectors:{"future.operation":[]}});
    resetSurfaceCache();await render(null);await render(<AssociationCredentialForm workspaceId="other" disabled={false} onSaved={()=>{}}/>);
    expect(host.textContent).toContain(a.permissionUnknown);
    expect([...host.querySelectorAll("code")].find(node=>node.textContent==="future.operation")?.closest("details")?.open).toBe(false);
  });
  it("starts each permission without resource access and submits only explicitly selected ids",async()=>{await setupForm();expect(host.textContent).toContain(a.scopeHelp);await toggle("Workshop (event-one)");await submit();expect(api.create).toHaveBeenCalledWith("w",{requestId:expect.stringMatching(/^[a-f0-9-]{36}$/),label:"Backend access",expiresAt:new Date("2028-01-01T00:00").toISOString(),grants:[{operation:"association.read",selectors:{eventIds:["event-one"]}}]});});
  it("never infers all resources from an operation grant",async()=>{await setupForm();await submit();expect(api.create.mock.calls[0][1].grants).toEqual([{operation:"association.read",selectors:{}}]);});
  it("requires explicit all-resource selection and optional atomic rotation revocation",async()=>{await setupForm(true);await toggle(a.allResources);await toggle(a.revokeOld);await submit();expect(api.create.mock.calls[0][1]).toMatchObject({revokeCredentialId:credential.id,grants:[{operation:"association.read",selectors:{eventIds:"all"}}]});});
  it("never persists or restores the returned secret with the recoverable draft",async()=>{await setupForm();await submit();expect(host.querySelector(`input[value="fixture-secret-once"]`)).not.toBeNull();expect(sessionStorage.getItem("request:w:viewer:credential-create:new")).toMatch(/^[a-f0-9-]{36}$/);expect(JSON.stringify(sessionStorage)).not.toContain("fixture-secret-once");await click(a.dismissSecret);expect(host.querySelector(`input[value="fixture-secret-once"]`)).toBeNull();expect(host.textContent).not.toContain("fixture-secret-once");await submit();expect(api.create).toHaveBeenCalledTimes(1);});
  it("retains uncertain-create admission across remount and cancelled review",async()=>{api.create.mockRejectedValueOnce(new Error("lost response"));await setupForm();await submit();expect(host.textContent).toContain(a.uncertainKey);await render(null);await render(<AssociationCredentialForm workspaceId="w" disabled={false} onSaved={()=>{}}/>);await submit();expect(api.create).toHaveBeenCalledTimes(1);api.confirm.mockResolvedValueOnce(false);await click(a.reviewNewKey);await submit();expect(api.create).toHaveBeenCalledTimes(1);await click(a.reviewNewKey);expect([...host.querySelectorAll("label")].find(e=>e.textContent===a.operationLabels["association.read"])?.querySelector("input")?.checked).toBe(true);await submit();expect(api.create).toHaveBeenCalledTimes(2);});
  it("blocks on owner denial/catalog failure without dispatching or storing a secret",async()=>{await render(<AssociationCredentialForm workspaceId="w" disabled onSaved={()=>{}}/>);expect(host.querySelector("form")).toBeNull();expect(api.create).not.toHaveBeenCalled();await render(null);resetSurfaceCache();api.catalog.mockRejectedValue(new Error("403"));await render(<AssociationCredentialForm workspaceId="w" disabled={false} onSaved={()=>{}}/>);await submit();expect(api.create).not.toHaveBeenCalled();expect(host.textContent).toContain(t.manage.loadFailed);});
  it("evicts resource names immediately after authority denial and prevents dispatch",async()=>{
    await setupForm();await toggle("Workshop (event-one)");
    api.resources.mockRejectedValue({status:403});
    await act(async()=>{window.dispatchEvent(new Event("focus"));});
    expect(host.textContent).not.toContain("Workshop (event-one)");
    await submit();expect(api.create).not.toHaveBeenCalled();
  });
  it("expires offline resource choices instead of authorizing creation from stale choices",async()=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
    await setupForm();await toggle("Workshop (event-one)");
    api.resources.mockRejectedValue(new Error("offline"));
    await act(async()=>{await vi.advanceTimersByTimeAsync(30001);});
    expect(host.textContent).not.toContain("Workshop (event-one)");
    await submit();expect(api.create).not.toHaveBeenCalled();
  });
  it("issues an explicitly reviewed department binding and blocks a revoked selection",async()=>{
    api.binding.mockResolvedValue({mode:"department-v2",validForMs:30000,assistants:[],choices:[{selection:{cap:"internal",departmentIds:["cedar"]},binding:["cedar"],departments:[{id:"cedar",name:"Cedar"}]}]});
    await render(<AssociationCredentialForm workspaceId="w" disabled={false} onSaved={()=>{}}/>);
    await click(a.bindingDepartments);await toggle("Cedar");
    await field(a.label,"Backend access");await field(a.expiry,"2028-01-01T00:00");await toggle(a.operationLabels["association.read"]);
    api.binding.mockResolvedValue({mode:"department-v2",validForMs:30000,assistants:[],choices:[]});
    await act(async()=>window.dispatchEvent(new Event("focus")));
    expect(host.textContent).not.toContain("Cedar");await submit();expect(api.create).not.toHaveBeenCalled();
    api.binding.mockResolvedValue({mode:"department-v2",validForMs:30000,assistants:[],choices:[{selection:{cap:"internal",departmentIds:["cedar"]},binding:["cedar"],departments:[{id:"cedar",name:"Cedar"}]}]});
    await act(async()=>window.dispatchEvent(new Event("focus")));await submit();
    expect(api.create.mock.calls[0][1].departmentBinding).toEqual({assistantId:null,cap:"internal",departmentIds:["cedar"]});
  });
  it("renews assistant and cap choices and recovers explicitly from unavailable assistant authority",async()=>{
    const response={mode:"department-v2",validForMs:30000,assistants:[{id:"assistant-one",name:"Fictional assistant"}],choices:[{selection:{cap:"internal",departmentIds:[]},binding:[],departments:[]}]};
    api.binding.mockResolvedValue(response);
    await render(<AssociationCredentialForm workspaceId="w" disabled={false} rotate={credential} onSaved={()=>{}}/>);
    expect(host.textContent).toContain(a.bindingUnbound);
    await click(a.bindingConfidential);expect(api.binding).toHaveBeenLastCalledWith("w",{assistantId:null,cap:"confidential"});
    api.binding.mockRejectedValue({status:403});await click("Fictional assistant");
    expect(host.textContent).not.toContain("Fictional assistant");await submit();expect(api.create).not.toHaveBeenCalled();
    api.binding.mockResolvedValue(response);await click(a.bindingNoAssistant);await act(async()=>window.dispatchEvent(new Event("focus")));
    expect(api.binding).toHaveBeenLastCalledWith("w",{assistantId:null,cap:"confidential"});
    await click(t.ux.destinationGeneral);await field(a.label,"Reviewed replacement");await field(a.expiry,"2028-01-01T00:00");await toggle(a.operationLabels["association.read"]);await toggle(a.revokeOld);await submit();
    expect(api.create.mock.calls[0][1]).toMatchObject({revokeCredentialId:credential.id,departmentBinding:{departmentIds:[],assistantId:null,cap:"confidential"}});
  });
  it("revokes the exact selected credential after review and respects cancelled review",async()=>{await render(<AssociationCredentialsPanel workspaceId="w" disabled={false}/>);api.confirm.mockResolvedValueOnce(false);await click(a.revokeKey);expect(api.revoke).not.toHaveBeenCalled();await click(a.revokeKey);expect(api.revoke).toHaveBeenCalledExactlyOnceWith("w",credential.id);});
  it("follows all credential pages and keeps the last good page on failure",async()=>{api.list.mockImplementation(async(_w,_r,q)=>({items:[{...credential,id:q.cursor?"last-key":"first-key"}],nextCursor:q.cursor?null:"next-key"}));await render(<AssociationCredentialsPanel workspaceId="w" disabled={false}/>);await click(t.next);expect(api.list).toHaveBeenCalledWith("w","credentials",{cursor:"next-key"});expect(host.textContent).toContain("last-key");api.list.mockRejectedValue(new Error("offline"));await click(t.refresh);expect(host.textContent).toContain("last-key");expect(host.textContent).toContain(t.manage.loadFailed);});
});
