// @vitest-environment jsdom
import {act,type ReactNode} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
const api=vi.hoisted(()=>({renewReview:vi.fn(),save:vi.fn(),renew:vi.fn(),preview:vi.fn(),execute:vi.fn(),receipt:vi.fn(),record:vi.fn(),lookup:vi.fn(),confirm:vi.fn()}));
vi.mock("@/lib/api/crm-administration",()=>({saveCrmFullPrivacyPolicy:api.save,getCrmErasureReview:api.renew,previewCrmPrivacy:api.preview,executeCrmPrivacy:api.execute,getCrmFileCleanupReceipt:api.receipt,renewCrmPrivacyReview:api.renewReview}));
vi.mock("@/lib/api/crm",()=>({fetchCrmRecord:api.record,fetchCrmLookup:api.lookup}));
vi.mock("@/components/ui/confirm-dialog",()=>({confirmDialog:api.confirm}));
vi.mock("@/lib/surface-prefetch",()=>({associationPageCacheKey:(w:string,r:string,q={})=>`crm:${w}:viewer:${r}:${JSON.stringify(q)}`}));
import {AssociationPrivacyPolicyForm} from "../privacy-policy-form";
import {AssociationPrivacyReview} from "../privacy-panel";
import {I18nProvider} from "@/lib/i18n/client";
import {en} from "@/lib/i18n/dictionaries/en";
import {resetSurfaceCache} from "@/lib/surface-cache";
import type {CrmPrivacyPolicySnapshot} from "@/lib/api/crm-administration";
const t=en.associationPage,p=t.privacy;
const contact={id:"contact-one",name:"Fictional Person",hint:"person@example.com"};
const snapshot:CrmPrivacyPolicySnapshot={version:4,approvedByUserId:"owner",createdAt:"2026-01-01T00:00:00Z",policy:{intakeReplay:{retentionSeconds:10},addressSuppression:{retentionSeconds:20},importSourceErasure:{receiptRetentionSeconds:30,heldSourceIds:["source-one"]},retention:{scheduled:true,intervalSeconds:60,resolvedSubmissionsSeconds:40,openSubmissions:{afterSeconds:50,fields:["message","metadata"]},importReceiptsSeconds:60,deliveryReceiptsSeconds:70,auditSeconds:80,financialRecordsSeconds:90,holds:[{domain:"contact",id:"contact-held"},{domain:"file",id:"file-held"}]}}};
const review={id:"preview-one",previewHash:"a".repeat(64),expiresAt:"2099-01-01T00:00:00Z",policyVersion:4,status:"ready",contactId:contact.id,domains:[{domain:"crm.contacts",action:"redact",count:1}],blockers:[],scopeLimits:["CRM slice only"]};
let host:HTMLDivElement,root:Root;
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
async function render(node:ReactNode){await act(async()=>root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>));}
async function click(label:string){const b=[...host.querySelectorAll("button")].find(b=>b.textContent===label);expect(b,`Missing ${label}`).toBeTruthy();await act(async()=>b!.click());}
async function field(label:string,value:string){const el=[...host.querySelectorAll("label")].find(l=>l.firstChild?.textContent===label)?.querySelector("input,textarea")!;expect(el,`Missing field ${label}`).toBeTruthy();await act(async()=>{Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value")!.set!.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));});}
async function submit(){await act(async()=>{host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});}
async function contactPreview(){await render(<AssociationPrivacyReview workspaceId="w" kind="erasure" disabled={false}/>);await click(contact.name+contact.hint);await submit();}
beforeEach(()=>{resetSurfaceCache();vi.resetAllMocks();api.lookup.mockResolvedValue([contact]);api.record.mockImplementation(async(_w,id)=>({record:{id,kind:"contact",name:contact.name,email:contact.hint,phone:null,archivedAt:null}}));api.confirm.mockResolvedValue(true);api.save.mockResolvedValue({record:snapshot});api.preview.mockResolvedValue(review);api.renew.mockImplementation(async()=>({preview:await api.preview.mock.results.at(-1)!.value,receipt:null}));api.execute.mockImplementation(async()=>{const receipt={previewId:review.id,status:"crm_contact_purged"};api.renew.mockResolvedValue({preview:null,receipt});return receipt;});api.receipt.mockResolvedValue({id:review.id,status:"completed"});api.renewReview.mockImplementation(async(_w,kind)=>kind==="retention"?{review}:{receipt:{id:review.id,status:"ready"}});host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers();});
describe("[COMP:app-web/association] Full owner privacy policy",()=>{
  it("saves every explicit domain and preserves holds and open-submission fields",async()=>{await render(<AssociationPrivacyPolicyForm workspaceId="w" snapshot={snapshot} disabled={false} onSaved={()=>{}}/>);await field(p.auditSeconds,"100");await submit();expect(api.save).toHaveBeenCalledWith("w",{...snapshot.policy,retention:{...snapshot.policy.retention,auditSeconds:100},expectedVersion:4,confirmed:true});});
  it("starts unconfigured and never invents periods, scheduling or redaction fields",async()=>{await render(<AssociationPrivacyPolicyForm workspaceId="w" snapshot={{...snapshot,version:0,policy:{intakeReplay:null}}} disabled={false} onSaved={()=>{}}/>);await submit();expect(api.save).toHaveBeenCalledWith("w",{intakeReplay:null,addressSuppression:null,retention:null,importSourceErasure:null,expectedVersion:0,confirmed:true});});
  it("refuses owner denial and preserves an uncertain stale save for review",async()=>{await render(<AssociationPrivacyPolicyForm workspaceId="w" snapshot={snapshot} disabled onSaved={()=>{}}/>);await submit();expect(api.save).not.toHaveBeenCalled();await render(<AssociationPrivacyPolicyForm workspaceId="w" snapshot={snapshot} disabled={false} onSaved={()=>{}}/>);api.save.mockRejectedValue(new Error("stale version"));await submit();expect(api.save).toHaveBeenCalledTimes(1);expect(host.textContent).toContain(t.manage.failed);expect(host.textContent).toContain(`${t.admin.readVersion}: 4`);});
});
describe("[COMP:app-web/association] Reviewed privacy execution",()=>{
  it("requires a preview and confirms displayed affected domains before exact execution",async()=>{await contactPreview();expect(api.confirm).not.toHaveBeenCalled();expect(api.execute).not.toHaveBeenCalled();expect(host.textContent).toContain("crm.contacts");expect(host.textContent).toContain("CRM slice only");await click(p.execute);expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({description:p.executeConfirm}));expect(api.execute).toHaveBeenCalledExactlyOnceWith("w",{kind:"erasure",contactId:contact.id},review);expect(host.textContent).toContain("crm_contact_purged");});
  it("does not execute a blocked or expired preview",async()=>{api.preview.mockResolvedValueOnce({...review,status:"blocked",blockers:[{domain:"crm.orders",reason:"financial_hold",count:2}]}).mockResolvedValueOnce({...review,id:"expired-preview",expiresAt:"2020-01-01T00:00:00Z"});await contactPreview();await click(p.execute);expect(api.execute).not.toHaveBeenCalled();expect(host.textContent).toContain("financial_hold");await submit();expect(host.textContent).toContain(p.expired);await click(p.execute);expect(api.execute).not.toHaveBeenCalled();});
  it("clears a preview when its selected person changes",async()=>{api.lookup.mockResolvedValue([contact,{id:"contact-two",name:"Second Person",hint:"second@example.com"}]);await contactPreview();await click("Second Personsecond@example.com");expect([...host.querySelectorAll("button")].some(b=>b.textContent===p.execute)).toBe(false);await submit();expect(api.preview).toHaveBeenLastCalledWith("w",{kind:"erasure",contactId:"contact-two"});expect(api.execute).not.toHaveBeenCalled();});
  it("keeps the same preview after lost execution response and honours cancelled confirmation",async()=>{await contactPreview();api.confirm.mockResolvedValueOnce(false);await click(p.execute);expect(api.execute).not.toHaveBeenCalled();api.execute.mockRejectedValueOnce(new Error("response lost"));await click(p.execute);expect(host.textContent).toContain(p.executeFailed);expect(api.preview).toHaveBeenCalledTimes(1);await click(p.execute);expect(api.execute.mock.calls[1]).toEqual(api.execute.mock.calls[0]);expect(api.preview).toHaveBeenCalledTimes(1);});
  it("builds retention cutoff explicitly and discards its preview when the cutoff changes",async()=>{await render(<AssociationPrivacyReview workspaceId="w" kind="retention" disabled={false}/>);await field(p.before,"2026-01-01T12:00");await submit();expect(api.preview).toHaveBeenCalledWith("w",{kind:"retention",before:new Date("2026-01-01T12:00").toISOString()});await field(p.before,"2026-02-01T12:00");expect([...host.querySelectorAll("button")].some(b=>b.textContent===p.execute)).toBe(false);expect(api.execute).not.toHaveBeenCalled();});
  it("shows queued physical cleanup honestly and refreshes its exact receipt",async()=>{api.execute.mockResolvedValue({id:review.id,status:"queued"});await render(<AssociationPrivacyReview workspaceId="w" kind="fileCleanup" disabled={false}/>);await field(p.fileId,"10000000-0000-4000-8000-000000000001");await field(p.before,"2026-01-01T00:00");await submit();await click(p.execute);expect(host.textContent).toContain('"status": "queued"');expect(host.textContent).toContain(p.receiptHelp);await click(t.refresh);expect(api.receipt).toHaveBeenCalledExactlyOnceWith("w",review.id);expect(host.textContent).toContain('"status": "completed"');});
  it("keeps owner denial and preview failures free of execution requests",async()=>{await render(<AssociationPrivacyReview workspaceId="w" kind="retention" disabled/>);await submit();expect(api.preview).not.toHaveBeenCalled();await render(<AssociationPrivacyReview workspaceId="w" kind="retention" disabled={false}/>);await field(p.before,"2026-01-01T00:00");api.preview.mockRejectedValue(new Error("not_authorized"));await submit();expect(host.textContent).toContain(p.previewFailed);expect(api.execute).not.toHaveBeenCalled();});
});


describe("[COMP:app-web/association] Retention and cleanup review lifetime",()=>{
  it.each(["retention","fileCleanup"] as const)("hides an open %s review when renewal is denied and recovers it on refresh",async kind=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
    await render(<AssociationPrivacyReview workspaceId="w" kind={kind} disabled={false}/>);
    if(kind==="fileCleanup")await field(p.fileId,"10000000-0000-4000-8000-000000000001");
    await field(p.before,"2026-01-01T00:00");await submit();
    expect([...host.querySelectorAll("button")].some(b=>b.textContent===p.execute)).toBe(true);
    api.renewReview.mockRejectedValue({status:403});
    await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);});
    expect([...host.querySelectorAll("button")].some(b=>b.textContent===p.execute)).toBe(false);
    expect(host.textContent).toContain(p.reviewUnavailable);expect(api.execute).not.toHaveBeenCalled();
    api.renewReview.mockImplementation(async(_w,k)=>k==="retention"?{review}:{receipt:{id:review.id,status:"ready"}});
    await click(t.refresh);
    expect([...host.querySelectorAll("button")].some(b=>b.textContent===p.execute)).toBe(true);
    expect(api.preview).toHaveBeenCalledTimes(1);
  });
});

describe("[COMP:app-web/association] Privacy contact revocation",()=>{
  it("removes an existing erasure preview after the selected contact becomes unavailable",async()=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
    await contactPreview();expect(host.textContent).toContain("CRM slice only");
    api.record.mockRejectedValue({status:403});api.lookup.mockRejectedValue({status:403});
    await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);});
    expect(host.textContent).not.toContain(contact.name);expect(host.textContent).not.toContain("CRM slice only");
    expect([...host.querySelectorAll("button")].some(b=>b.textContent===p.execute)).toBe(false);expect(api.execute).not.toHaveBeenCalled();
  });
  it("evicts linked-record denial even while the selected contact stays readable and recovers the exact review",async()=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
    await contactPreview();expect(host.textContent).toContain("CRM slice only");
    api.renew.mockRejectedValue({status:403});
    await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);});
    expect(host.textContent).toContain(contact.name);expect(host.textContent).not.toContain("CRM slice only");
    expect(host.textContent).toContain(p.reviewUnavailable);expect(api.execute).not.toHaveBeenCalled();
    api.renew.mockResolvedValue({preview:review,receipt:null});await click(t.refresh);
    expect(host.textContent).toContain("CRM slice only");expect(api.preview).toHaveBeenCalledTimes(1);
  });
  it("expires a stalled renewal and rejects its late response",async()=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
    await contactPreview();let resolve!:(value:unknown)=>void;
    api.renew.mockImplementation(()=>new Promise(r=>{resolve??=r;}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(60_001);});
    expect(host.textContent).not.toContain("CRM slice only");
    await act(async()=>{resolve({preview:review,receipt:null});});
    expect(host.textContent).not.toContain("CRM slice only");expect(api.execute).not.toHaveBeenCalled();
  });
  it("renews a consumed receipt without its deleted contact and hides it when its saved floor is denied",async()=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
    await contactPreview();await click(p.execute);expect(host.textContent).toContain("crm_contact_purged");
    api.record.mockRejectedValue({status:404});api.lookup.mockResolvedValue([]);
    await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);});
    expect(host.textContent).not.toContain(contact.name);expect(host.textContent).toContain("crm_contact_purged");
    api.renew.mockRejectedValue({status:403});
    await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);});
    expect(host.textContent).not.toContain("crm_contact_purged");expect(api.execute).toHaveBeenCalledTimes(1);
  });
  it("hides protected output immediately when management becomes unavailable",async()=>{
    await contactPreview();await render(<AssociationPrivacyReview workspaceId="w" kind="erasure" disabled/>);
    expect(host.textContent).not.toContain("CRM slice only");expect(api.execute).not.toHaveBeenCalled();
  });

});
