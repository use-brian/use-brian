/**
 * Department management (permission model v2, D25): the same commands Brian's
 * `manageDepartments` tool runs. Spec: docs/architecture/features/workspace-access.md
 * -> "Department management and home departments (v2, migration 651)".
 */
import { authFetch } from '@/lib/auth-fetch';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';

export const DEPARTMENTS_CHANGED_EVENT = 'brian:departments-changed';

export type DepartmentClearance = 'public' | 'internal' | 'confidential';
export type DepartmentPrincipal = { kind: 'user' | 'assistant'; id: string };
export type DepartmentDirectoryEntry = {
  departmentId: string;
  name: string;
  status: 'active' | 'archived';
  revision: number;
  myClearance: DepartmentClearance | null;
  isOwner: boolean;
  ownerIds: string[];
};
export type DepartmentHome = { principal: DepartmentPrincipal; departmentId: string | null };
export type DepartmentEdge = {
  departmentId: string;
  principal: DepartmentPrincipal;
  clearance: DepartmentClearance;
  expiresAt: string | null;
  origin: string;
};

export class DepartmentRequestError extends Error {
  constructor(readonly code: string) { super(code); }
}

async function call<T>(workspaceId: string, path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const root = publicRuntimeConfig().apiUrl ?? 'http://localhost:4000';
  const response = await authFetch(`${root}/api/workspaces/${encodeURIComponent(workspaceId)}/departments${path}`, {
    cache: 'no-store',
    ...(init ? { method: init.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body ?? {}) } : {}),
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new DepartmentRequestError(body.error ?? 'department_unavailable');
  if (init && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DEPARTMENTS_CHANGED_EVENT, { detail: { workspaceId } }));
  return body;
}

export const fetchDepartments = (workspaceId: string) =>
  call<{ departments: DepartmentDirectoryEntry[]; homes: DepartmentHome[] }>(workspaceId, '');
export const fetchDepartmentEdges = (workspaceId: string, departmentId: string) =>
  call<{ edges: DepartmentEdge[] }>(workspaceId, `/${encodeURIComponent(departmentId)}`);
export const setDepartmentEdge = (workspaceId: string, departmentId: string, input: { principal: DepartmentPrincipal; clearance: DepartmentClearance; expiresAt?: string | null; expectedRevision?: number }) =>
  call<{ revision: number }>(workspaceId, `/${encodeURIComponent(departmentId)}/edges`, { method: 'PUT', body: input });
export const removeDepartmentEdge = (workspaceId: string, departmentId: string, input: { principal: DepartmentPrincipal; expectedRevision?: number }) =>
  call<{ revision: number }>(workspaceId, `/${encodeURIComponent(departmentId)}/edges`, { method: 'DELETE', body: input });
export const addDepartmentOwner = (workspaceId: string, departmentId: string, userId: string, expectedRevision?: number) =>
  call<{ revision: number }>(workspaceId, `/${encodeURIComponent(departmentId)}/owners`, { method: 'POST', body: { userId, expectedRevision } });
export const removeDepartmentOwner = (workspaceId: string, departmentId: string, userId: string, expectedRevision?: number) =>
  call<{ revision: number }>(workspaceId, `/${encodeURIComponent(departmentId)}/owners`, { method: 'DELETE', body: { userId, expectedRevision } });
export const breakGlassDepartment = (workspaceId: string, departmentId: string, reason: string) =>
  call<{ revision: number }>(workspaceId, `/${encodeURIComponent(departmentId)}/break-glass`, { method: 'POST', body: { reason } });
export const setHomeDepartment = (workspaceId: string, principal: DepartmentPrincipal, departmentId: string | null) =>
  call<{ ok: true }>(workspaceId, '/home', { method: 'PUT', body: { principal, departmentId } });
