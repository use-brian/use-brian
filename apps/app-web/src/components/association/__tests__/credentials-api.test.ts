import {beforeEach,describe,it,expect,vi} from "vitest";
const api=vi.hoisted(()=>({fetch:vi.fn(),definitions:vi.fn(),purposes:vi.fn(),plans:vi.fn(),events:vi.fn()}));
vi.mock("@/lib/auth-fetch",()=>({authFetch:api.fetch}));
vi.mock("@/lib/api/crm",()=>({listCrmIntakeDefinitions:api.definitions,listCrmConsentPurposes:api.purposes,listCrmEntitlementPlans:api.plans,listCrmEvents:api.events}));
import {createCrmCredential,getCrmCredentialBindingOptions,revokeCrmCredential,getCrmCredentialCatalog,getCrmScopeResources} from "@/lib/api/crm-administration";
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
beforeEach(()=>vi.resetAllMocks());
describe("[COMP:app-web/association] Credential catalog and member API",()=>{
  it("reads the actual server catalog and refuses unknown selector dimensions",async()=>{
    const catalog={operations:["crm.entitlements.read"],selectors:{"crm.entitlements.read":["planIds"]}};
    api.fetch.mockResolvedValueOnce(response(catalog));expect(await getCrmCredentialCatalog("w")).toEqual(catalog);
    api.fetch.mockResolvedValueOnce(response({...catalog,selectors:{"crm.entitlements.read":["unrecognized"]}}));await expect(getCrmCredentialCatalog("w")).rejects.toMatchObject({code:"invalid_response"});
  });
  it("keeps owner denial explicit rather than returning an empty permission catalog",async()=>{
    api.fetch.mockResolvedValue(response({error:"not_authorized"},403));await expect(getCrmCredentialCatalog("w")).rejects.toMatchObject({status:403,code:"not_authorized"});
  });
  it("issues and revokes only via authenticated member routes, preserving explicit rotation",async()=>{
    api.fetch.mockImplementation(async()=>response({oneTimeSecret:"fictional-secret"}));const input={label:"Fictional integration",expiresAt:"2028-01-01T00:00:00Z",grants:[{operation:"crm.records.read",selectors:{}}],revokeCredentialId:"old-id"};
    expect(await createCrmCredential("w",input)).toEqual({oneTimeSecret:"fictional-secret"});await revokeCrmCredential("w","credential/id");
    expect(new URL(api.fetch.mock.calls[0][0], "https://app.example").pathname).toBe("/api/crm/w/operations/integration-credentials");expect(JSON.parse(api.fetch.mock.calls[0][1].body)).toEqual(input);
    expect(new URL(api.fetch.mock.calls[1][0], "https://app.example").pathname).toBe("/api/crm/w/operations/integration-credentials/credential%2Fid/revoke");expect(api.fetch.mock.calls[0][1].headers).toEqual({"Content-Type":"application/json"});
  });
  it("requests the selected assistant and cap through the authenticated preview adapter",async()=>{
    const result={mode:"department-v2",choices:[],assistants:[],validForMs:30000};api.fetch.mockResolvedValue(response(result));
    expect(await getCrmCredentialBindingOptions("w",{assistantId:"assistant/id",cap:"confidential"})).toEqual(result);
    const url=new URL(api.fetch.mock.calls[0][0],"https://app.example");
    expect(url.pathname).toBe("/api/crm/w/operations/integration-credentials/binding-options");
    expect(url.searchParams.get("assistantId")).toBe("assistant/id");expect(url.searchParams.get("cap")).toBe("confidential");
  });
  it("uses complete CRM catalog readers and exposes no definition or consent payloads",async()=>{
    api.definitions.mockResolvedValue(Array.from({length:103},(_,i)=>({id:`definition-${i}`,label:`Definition ${i}`,fields:["private-schema"]})));
    api.purposes.mockResolvedValue([{purposeKey:"updates",label:"Updates",defaultWording:"private-wording"}]);api.plans.mockResolvedValue([{id:"plan",name:"Plan"}]);api.events.mockResolvedValue([{id:"event",title:"Event"}]);
    const result=await getCrmScopeResources("w");expect(result.definitionIds).toHaveLength(103);expect(result.definitionIds[102]).toEqual({id:"definition-102",label:"Definition 102"});expect(result.purposeKeys).toEqual([{id:"updates",label:"Updates"}]);
    for(const call of [api.definitions,api.purposes,api.plans,api.events])expect(call).toHaveBeenCalledExactlyOnceWith("w");
  });
});

describe("[COMP:app-web/association] Managed-mailbox member API",()=>{
  it("lists only concrete supported mailbox instances without copying credential material",async()=>{
    const {listCrmMailboxes}=await import("@/lib/api/crm-administration");
    api.fetch.mockResolvedValue(response({connectors:[{id:"gmail",name:"Mail",connectorInstanceId:"gmail-one",connectedEmail:"mail@example.com",secret:"never-copy"},{id:"imap",name:"Second",connectorInstanceId:"imap-one"},{id:"agentmail",name:"Agent",connectorInstanceId:"agent-one"},{id:"gmail",name:"Placeholder"},{id:"gdrive",name:"Drive",connectorInstanceId:"drive-one"}]}));
    expect(await listCrmMailboxes("w")).toEqual([{id:"gmail-one",provider:"gmail",label:"mail@example.com"},{id:"imap-one",provider:"imap",label:"Second"},{id:"agent-one",provider:"agentmail",label:"Agent"}]);
  });
  it("keeps mailbox policy and credential binding versions independent",async()=>{
    const {getCrmMailboxPolicy,saveCrmMailboxPolicy,getCrmMailboxGrant,saveCrmMailboxGrant}=await import("@/lib/api/crm-administration");api.fetch.mockImplementation(async()=>response({}));
    await getCrmMailboxPolicy("w","mailbox");await saveCrmMailboxPolicy("w","mailbox",{expectedVersion:4,confirmed:true,providerKey:"outreach",managed:true,purposeKeys:["updates"],templatePurposes:{}});await getCrmMailboxGrant("w","mailbox","key");await saveCrmMailboxGrant("w","mailbox","key",{expectedVersion:2,confirmed:true,enabled:false});
    expect(api.fetch.mock.calls.map(c=>new URL(c[0], "https://app.example").pathname)).toEqual(["/api/crm/w/operations/mailbox-policies/mailbox","/api/crm/w/operations/mailbox-policies/mailbox","/api/crm/w/operations/mailbox-policies/mailbox/integration-grants/key","/api/crm/w/operations/mailbox-policies/mailbox/integration-grants/key"]);expect(JSON.parse(api.fetch.mock.calls[1][1].body).expectedVersion).toBe(4);expect(JSON.parse(api.fetch.mock.calls[3][1].body)).toEqual({expectedVersion:2,confirmed:true,enabled:false});
  });
});
