import { authFetch } from '@/lib/auth-fetch';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
import { SurfaceCacheEvictionError } from '@/lib/surface-cache';

export type PublicExternalApprovalSource = {
  id: string; name: string; workspaceId: string; assistantId: string; approverUserId: string | null;
  audience?: 'conversation_members'; destinationSessionId?: string; threadRef?: string;
  channelType: string; channelId: string; channelIntegrationId?: string | null;
  prefix: string; createdAt: string; revokedAt: string | null;
};
export type ExternalApprovalSourceInput = {
  name: string; assistantId: string; destinationId: string;
};
export class ExternalApprovalSourceError extends Error {
  constructor(readonly status: number) { super('external_approval_source_failed'); }
}
const base = (workspaceId: string) => `${publicRuntimeConfig().apiUrl ?? 'http://localhost:4000'}/api/workspaces/${encodeURIComponent(workspaceId)}/external-approval-sources`;
// Explicit projection: credentials and unexpected server fields cannot enter the surface cache.
function publicSource(s: PublicExternalApprovalSource): PublicExternalApprovalSource {
  const { id, name, workspaceId, assistantId, approverUserId, channelType, channelId, channelIntegrationId, prefix, createdAt, revokedAt, audience, destinationSessionId, threadRef } = s;
  return { id, name, workspaceId, assistantId, approverUserId, channelType, channelId, channelIntegrationId, prefix, createdAt, revokedAt, ...(audience ? {audience} : {}), ...(destinationSessionId ? {destinationSessionId} : {}), ...(threadRef ? {threadRef} : {}) };
}
async function check(res: Response, listing = false) {
  if (res.ok) return;
  const error = new ExternalApprovalSourceError(res.status);
  if (listing && [401,403,404].includes(res.status)) throw new SurfaceCacheEvictionError(error);
  throw error;
}
export async function listExternalApprovalSources(workspaceId: string): Promise<PublicExternalApprovalSource[]> {
  const res = await authFetch(base(workspaceId), { cache: 'no-store' });
  await check(res, true);
  const data = await res.json() as {sources: PublicExternalApprovalSource[]};
  return data.sources.map(publicSource);
}
async function issue(url: string, body: object): Promise<{source: PublicExternalApprovalSource; token: string}> {
  const res = await authFetch(url, {method: 'POST', cache: 'no-store', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)});
  await check(res);
  const data = await res.json();
  return {source: publicSource(data.source), token: data.token};
}
export function createExternalApprovalSource(workspaceId: string, input: ExternalApprovalSourceInput) {
  const {name, assistantId, destinationId} = input;
  return issue(base(workspaceId), {name, assistantId, destinationId});
}
export function rotateExternalApprovalSource(workspaceId: string, sourceId: string) {
  return issue(`${base(workspaceId)}/${encodeURIComponent(sourceId)}/rotate`, {});
}
export async function revokeExternalApprovalSource(workspaceId: string, sourceId: string) {
  const res = await authFetch(`${base(workspaceId)}/${encodeURIComponent(sourceId)}`, {method:'DELETE', cache:'no-store'});
  await check(res);
}

export type ExternalApprovalDestination = {
  id: string; sessionId: string; assistantId: string; channelType: string;
  channelId: string; channelIntegrationId?: string; threadRef?: string; label: string;
};
export type ExternalApprovalConnection = {
  id: string; channelType: string; label: string; available: boolean;
  reason?: 'no_conversation' | 'unsupported_transport';
};
export async function listExternalApprovalDestinations(workspaceId: string, assistantId: string): Promise<{
  destinations: ExternalApprovalDestination[]; connections: ExternalApprovalConnection[];
}> {
  const res = await authFetch(`${base(workspaceId)}/destinations?assistantId=${encodeURIComponent(assistantId)}`, {cache: 'no-store'});
  await check(res, true);
  const data = await res.json() as {destinations: ExternalApprovalDestination[]; connections: ExternalApprovalConnection[]};
  return {
    destinations: data.destinations.map(({id, sessionId, assistantId, channelType, channelId, channelIntegrationId, threadRef, label}) =>
      ({id, sessionId, assistantId, channelType, channelId, ...(channelIntegrationId ? {channelIntegrationId} : {}), ...(threadRef ? {threadRef} : {}), label})),
    connections: data.connections.map(({id, channelType, label, available, reason}) =>
      ({id, channelType, label, available, ...(reason ? {reason} : {})})),
  };
}
