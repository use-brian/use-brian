/** Native owner administration; never uses a machine credential. [COMP:app-web/association] */
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { SurfaceCacheEvictionError } from "@/lib/surface-cache";
import { authFetch } from "@/lib/auth-fetch";
import { listCrmIntakeDefinitions,listCrmConsentPurposes,listCrmEntitlementPlans,listCrmEvents } from "./crm";
import { AssociationApiError } from "./association";
const API_URL=publicRuntimeConfig().apiUrl ?? "http://localhost:4000";
async function request<T>(workspaceId:string,path:string,input?:unknown):Promise<T>{
  const response=await authFetch(`${API_URL}/api/crm/${encodeURIComponent(workspaceId)}/operations/${path}`,input===undefined?undefined:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
  const body=await response.json();if(!response.ok)throw new AssociationApiError(typeof body?.error==="string"?body.error:"unavailable",response.status);return body as T;
}
export type CrmScopeDimension="definitionIds"|"purposeKeys"|"planIds"|"eventIds"|"providerKeys";
export type CrmCredentialGrant={operation:string;selectors:Partial<Record<CrmScopeDimension,"all"|string[]>>};
export type CrmManagedCredential={id:string;label:string;prefix:string;expiresAt:string;revokedAt:string|null;createdAt:string;lastUsedAt:string|null;grants:CrmCredentialGrant[];departmentBinding?:{binding:string[];cap:string;assistantId:string|null}|null};
export type CrmCredentialBindingSelection={departmentIds?:string[];assistantId?:string|null;cap:"public"|"internal"|"confidential"};
export type CrmCredentialBindingOptions={mode:"legacy"|"department-v2";validForMs:number;assistants:Array<{id:string;name:string}>;choices:Array<{selection:CrmCredentialBindingSelection;binding:string[];departments:Array<{id:string;name:string}>}>};
export function getCrmCredentialBindingOptions(workspaceId:string,selection:Omit<CrmCredentialBindingSelection,"departmentIds">){
  const query=new URLSearchParams({cap:selection.cap,...(selection.assistantId?{assistantId:selection.assistantId}:{})});
  return request<CrmCredentialBindingOptions>(workspaceId,`integration-credentials/binding-options?${query}`);
}
export type CrmCredentialCatalog={operations:string[];selectors:Record<string,CrmScopeDimension[]>};
export async function getCrmCredentialCatalog(workspaceId:string):Promise<CrmCredentialCatalog>{
  const catalog=await request<CrmCredentialCatalog>(workspaceId,"integration-credentials/catalog");
  const dimensions=new Set(["definitionIds","purposeKeys","planIds","eventIds","providerKeys"]);
  if(!Array.isArray(catalog.operations)||!catalog.operations.length||!catalog.selectors||catalog.operations.some(op=>typeof op!=="string"||!Array.isArray(catalog.selectors[op])||catalog.selectors[op].some(d=>!dimensions.has(d))))throw new AssociationApiError("invalid_response",502);
  return catalog;
}
export function createCrmCredential(workspaceId:string,input:{requestId?:string;label:string;expiresAt:string;grants:CrmCredentialGrant[];revokeCredentialId?:string;departmentBinding?:CrmCredentialBindingSelection}){
  return request<CrmManagedCredential&{oneTimeSecret:string}>(workspaceId,"integration-credentials",input);
}
export function revokeCrmCredential(workspaceId:string,credentialId:string){return request<{revoked:boolean}>(workspaceId,`integration-credentials/${encodeURIComponent(credentialId)}/revoke`,{});}
export async function getCrmScopeResources(workspaceId:string){
  const [definitions,purposes,plans,events]=await Promise.all([listCrmIntakeDefinitions(workspaceId),listCrmConsentPurposes(workspaceId),listCrmEntitlementPlans(workspaceId),listCrmEvents(workspaceId)]);
  return {definitionIds:definitions.map(r=>({id:r.id,label:r.label})),purposeKeys:purposes.map(r=>({id:r.purposeKey,label:r.label})),planIds:plans.map(r=>({id:r.id,label:r.name})),eventIds:events.map(r=>({id:r.id,label:r.title}))};
}

export type CrmManagedMailboxPolicy={connectorInstanceId:string;providerKey:string;version:number;managed:boolean;purposeKeys:string[];templatePurposes:Record<string,string>};
export type CrmMailboxIntegrationGrant={credentialId:string;connectorInstanceId:string;version:number;enabled:boolean};
export async function listCrmMailboxes(workspaceId:string):Promise<Array<{id:string;label:string;provider:string}>>{
  const response=await authFetch(`${API_URL}/api/connectors?workspaceId=${encodeURIComponent(workspaceId)}`);
  if(!response.ok)throw new AssociationApiError("mailboxes_unavailable",response.status);
  const body=await response.json();if(!Array.isArray(body?.connectors))throw new AssociationApiError("invalid_response",502);
  // Intentionally only the three prepared transports, not every built-in connector.
  return body.connectors.filter((row:{id?:unknown;connectorInstanceId?:unknown})=>["gmail","imap","agentmail"].includes(String(row.id))&&typeof row.connectorInstanceId==="string") // drift-sweep: intentionally-narrow: managed CRM mail transports
    .map((row:{id:string;connectorInstanceId:string;label?:string;name:string;connectedEmail?:string})=>({id:row.connectorInstanceId,provider:row.id,label:row.label||row.connectedEmail||row.name}));
}
export function getCrmMailboxPolicy(workspaceId:string,instanceId:string){return request<{policy:CrmManagedMailboxPolicy|null}>(workspaceId,`mailbox-policies/${encodeURIComponent(instanceId)}`);}
export function saveCrmMailboxPolicy(workspaceId:string,instanceId:string,input:Omit<CrmManagedMailboxPolicy,"connectorInstanceId"|"version">&{expectedVersion:number;confirmed:true}){return request<{record:CrmManagedMailboxPolicy}>(workspaceId,`mailbox-policies/${encodeURIComponent(instanceId)}`,input);}
export function getCrmMailboxGrant(workspaceId:string,instanceId:string,credentialId:string){return request<{grant:CrmMailboxIntegrationGrant|null}>(workspaceId,`mailbox-policies/${encodeURIComponent(instanceId)}/integration-grants/${encodeURIComponent(credentialId)}`);}
export function saveCrmMailboxGrant(workspaceId:string,instanceId:string,credentialId:string,input:{expectedVersion:number;confirmed:true;enabled:boolean}){return request<{record:CrmMailboxIntegrationGrant}>(workspaceId,`mailbox-policies/${encodeURIComponent(instanceId)}/integration-grants/${encodeURIComponent(credentialId)}`,input);}

export type CrmRetentionSettings={scheduled:boolean;intervalSeconds:number;resolvedSubmissionsSeconds:number|null;openSubmissions:{afterSeconds:number;fields:Array<"subject"|"message"|"metadata"|"notes">}|null;importReceiptsSeconds:number|null;deliveryReceiptsSeconds:number|null;auditSeconds:number|null;financialRecordsSeconds:number|null;holds:Array<{domain:"contact"|"submission"|"order"|"file";id:string}>};
export type CrmPrivacySettings={intakeReplay:{retentionSeconds:number}|null;addressSuppression?:{retentionSeconds:number}|null;retention?:CrmRetentionSettings|null;importSourceErasure?:{receiptRetentionSeconds:number;heldSourceIds:string[]}|null};
export type CrmPrivacyPolicySnapshot={version:number;policy:CrmPrivacySettings;approvedByUserId:string|null;createdAt:string|null};
export async function getCrmFullPrivacyPolicy(workspaceId:string){const value=await request<CrmPrivacyPolicySnapshot>(workspaceId,"privacy-policy");if(!Number.isInteger(value?.version)||value.version<0||!value.policy||!Object.hasOwn(value.policy,"intakeReplay"))throw new AssociationApiError("invalid_response",502);return value;}
export function saveCrmFullPrivacyPolicy(workspaceId:string,input:CrmPrivacySettings&{expectedVersion:number;confirmed:true}){return request<{record:CrmPrivacyPolicySnapshot}>(workspaceId,"privacy-policy",input);}
export type CrmPrivacyPreview={id:string;previewHash:string;expiresAt:string;policyVersion:number;status:"ready"|"blocked";domains:Array<{domain:string;action:"delete"|"redact"|"retire"|"retain"|"blocked";count:number}>;blockers:Array<{domain:string;reason:string;count:number}>;scopeLimits?:string[];retainedCopies?:string[];cutoffs?:Record<string,string|null>;hasMore?:boolean;contactId?:string;fileId?:string};
export type CrmPrivacyPreviewRequest={kind:"erasure";contactId:string}|{kind:"retention";before:string}|{kind:"fileCleanup";fileId:string;before:string};
export async function previewCrmPrivacy(workspaceId:string,input:CrmPrivacyPreviewRequest):Promise<CrmPrivacyPreview>{
  const {kind,...body}=input;
  const preview=await request<CrmPrivacyPreview>(workspaceId,kind==="erasure"?"privacy/erasure-preview":kind==="retention"?"retention/dry-run":"privacy/file-cleanup-preview",body);
  if(!preview?.id||!/^[a-f0-9]{64}$/.test(preview.previewHash)||!Number.isFinite(Date.parse(preview.expiresAt))||!["ready","blocked"].includes(preview.status)||!Array.isArray(preview.domains)||!Array.isArray(preview.blockers))throw new AssociationApiError("invalid_response",502);
  if(input.kind==="erasure"&&preview.contactId!==input.contactId || input.kind==="fileCleanup"&&preview.fileId!==input.fileId)throw new AssociationApiError("invalid_response",502);
  return preview;
}
export type CrmErasureReviewRead={preview:CrmPrivacyPreview|null;receipt:Record<string,unknown>|null};
export async function getCrmErasureReview(workspaceId:string,previewId:string):Promise<CrmErasureReviewRead>{
  try {
    const value=await request<CrmErasureReviewRead>(workspaceId,`privacy/erasure-previews/${encodeURIComponent(previewId)}`);
    const review=value?.preview,receipt=value?.receipt;
    if(review ? receipt!==null||review.id!==previewId||!review.contactId||!/^[a-f0-9]{64}$/.test(review.previewHash)||!Number.isFinite(Date.parse(review.expiresAt))||!["ready","blocked"].includes(review.status)||!Array.isArray(review.domains)||!Array.isArray(review.blockers)
      : review!==null||!receipt||receipt.previewId!==previewId||receipt.status!=="crm_contact_purged")throw new AssociationApiError("invalid_response",502);
    return value;
  }catch(error){if(error instanceof AssociationApiError&&[401,403,404,409].includes(error.status))throw new SurfaceCacheEvictionError(error);throw error;}
}
export function executeCrmPrivacy(workspaceId:string,input:CrmPrivacyPreviewRequest,preview:CrmPrivacyPreview){
  const body={previewId:preview.id,previewHash:preview.previewHash,confirmed:true,...(input.kind==="erasure"?{contactId:input.contactId}:{})};
  return request<Record<string,unknown>>(workspaceId,input.kind==="erasure"?"privacy/erase":input.kind==="retention"?"retention/execute":"privacy/file-cleanup-execute",body);
}
export function getCrmFileCleanupReceipt(workspaceId:string,previewId:string){return request<Record<string,unknown>>(workspaceId,`privacy/file-cleanups/${encodeURIComponent(previewId)}`);}
/** Renew an open retention or file-cleanup review under current authority; a denial evicts it. */
export async function renewCrmPrivacyReview(workspaceId:string,kind:"retention"|"fileCleanup",previewId:string):Promise<{review?:CrmPrivacyPreview;receipt?:Record<string,unknown>}>{
  try {
    if(kind==="retention"){
      const review=await request<CrmPrivacyPreview>(workspaceId,`retention/reviews/${encodeURIComponent(previewId)}`);
      if(review?.id!==previewId||!/^[a-f0-9]{64}$/.test(review.previewHash)||!["ready","blocked"].includes(review.status)||!Array.isArray(review.domains)||!Array.isArray(review.blockers))throw new AssociationApiError("invalid_response",502);
      return {review};
    }
    return {receipt:await getCrmFileCleanupReceipt(workspaceId,previewId)};
  }catch(error){if(error instanceof AssociationApiError&&[401,403,404,409].includes(error.status))throw new SurfaceCacheEvictionError(error);throw error;}
}
export async function downloadCrmFullPrivacy(workspaceId:string,contactId?:string):Promise<Blob>{
  const path=contactId?`contacts/${encodeURIComponent(contactId)}/privacy-export`:"privacy-export";
  const response=await authFetch(`${API_URL}/api/crm/${encodeURIComponent(workspaceId)}/operations/${path}?format=crm-privacy-v2`);
  if(!response.ok)throw new AssociationApiError("privacy_export_failed",response.status);
  const text=await response.text();const lines=text.split("\n");if(lines.at(-1)==="")lines.pop();
  if(lines.length<2)throw new AssociationApiError("privacy_export_incomplete",502);
  const header=JSON.parse(lines[0]!),manifest=JSON.parse(lines.at(-1)!);const records=lines.slice(1,-1);
  if(header.type!=="header"||header.schema!=="crm-privacy-v2"||header.workspaceId!==workspaceId||header.scope!==(contactId?"contact":"workspace")||(header.contactId ?? null)!==(contactId ?? null)||manifest.type!=="manifest"||manifest.schema!=="crm-privacy-v2"||manifest.exportId!==header.exportId||manifest.complete!==true||manifest.totalRecords!==records.length||records.some(line=>JSON.parse(line).type!=="record"))throw new AssociationApiError("privacy_export_incomplete",502);
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(records.length?records.join("\n")+"\n":""));
  const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
  if(hash!==manifest.sha256)throw new AssociationApiError("privacy_export_checksum",502);
  return new Blob([text],{type:"application/x-ndjson"});
}
