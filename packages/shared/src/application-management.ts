/** Native management wire metadata; never a data-authority grant. [COMP:api/application-management] */
import type { ApplicationClientInput, ApplicationGrantInput } from './application-platform.js'
export type ManagedApplication = { id:string;workspaceId:string;moduleKey:string;name:string;mode:'home_app'|'external_frontend'|'api_client';origins:string[];redirectUris:string[];homeAppId:string|null;executingAssistantId:string|null;status:'active'|'suspended'|'revoked';revision:string;qualified?:boolean };
export type ManagedGrant = {id:string;principalKind:string;principalUserId:string;origin:unknown;typeKey:string;actions:string[];readFields:string[];writeFields:string[];selector:unknown;status:string;version:string;startsAt:string;expiresAt:string|null;parentGrantId:string|null;compartments:string[];projectIds:string[];clearance:string};
export type ManagedCredential = {id:string;name:string;kind:string;serviceUserId:string;status:string;expiresAt:string|null;lastUsedAt:string|null;version:string};
export type ManagedSchema = {id:string;name:string;schemaVersion:number;properties:unknown[]};
export type ManagedSource = {id:string;connectorInstanceId:string;status:string;revision:string;mappingStatus:'unavailable';keyStatus:'deployment_managed';retentionStatus:'unavailable'};
export interface ApplicationManagementOverview {
 workspaceId:string;actor:{userId:string;assistantId:string};validForMs:number;
 readiness:{qualified:false;reason:'consumer_qualification_incomplete';canActivate:false};
 modules:string[];clients:ManagedApplication[];selectedAppId:string|null;grants:ManagedGrant[];credentials:ManagedCredential[];
 schemas:{state:'available'|'unavailable';items:ManagedSchema[]};sources:{state:'available'|'unavailable';items:ManagedSource[]};
 governance?:{state:'available'|'unavailable';moduleKey:string|null;catalog:ManagementGovernanceCatalog|null};
 links:{miniApps:string;connectors:string;programmaticAccess:string;access:string};
}
export type ApplicationManagementCommand =
 | {kind:'legacy.view';reviewId:string;assistantId?:string}
 | {kind:'legacy.apply'|'legacy.cancel';reviewId:string;expectedVersion:string;payloadHash:string;assistantId?:string}
 | {kind:'register';input:Omit<ApplicationClientInput,'workspaceId'>}
 | {kind:'activation.review';appId:string;profile?:'canonical_app_delegation_v1'}
 | {kind:'activation.apply';appId:string;reviewId:string}
 | {kind:'activation.revoke';appId:string}
 | {kind:'status';appId:string;status:'active'|'suspended'|'revoked'}
 | {kind:'grant.review';appId:string;input:ApplicationGrantInput}
 | {kind:'grant.apply';appId:string;reviewId:string}
 | {kind:'grant.revoke';appId:string;grantId:string}
 | {kind:'service.prepare';appId:string;input:{name:string;idempotencyKey:string}}
 | {kind:'credential.review';appId:string;input:{name:string;kind:'service'|'delegated';serviceUserId:string;grantIds:string[];expiresAt:string}}
 | {kind:'credential.deliver';appId:string;reviewId:string}
 | {kind:'credential.revoke';appId:string;credentialId:string}
 | {kind:'schema.preview';schemaId:string;input:{expectedVersion:number;properties:unknown[];assistantId?:string}}
 | {kind:'schema.apply';reviewId:string;input:{assistantId?:string}}
 | {kind:'governance.catalog';input:{moduleKey:string;afterId?:string;assistantId?:string}}
 | {kind:'governance.preview';input:{moduleKey:string;expectedRevision:string;operation:unknown;assistantId?:string}}
 | {kind:'governance.apply';reviewId:string;input:{assistantId?:string}};
export type ManagementReview = {id:string;proposal?:unknown;proposed?:unknown;before?:unknown;expiresAt?:string;canIssue?:boolean;canApply?:boolean;invalidRecords?:number;affectedRecords?:number};
export type ManagementGovernanceCatalog = {moduleKey:string;revision:string;roleKeys:string[];operations:string[];nativeResourceTypes:string[];ownedNativeResourceTypes:string[];configurationRevision:string|null;configurationOperations:Array<{operationKey:string;inputFields:Array<{key:string;kind:string;required:boolean;values?:string[];maxLength?:number}>;requiredRoleKeys:string[]}>;roleAssignments:Array<{id:string;userId:string;roleKey:string;status:string;startsAt:string;expiresAt:string|null;version:string}>;nextCursor:string|null};
export type ApplicationManagementResult = Record<string,unknown>;
