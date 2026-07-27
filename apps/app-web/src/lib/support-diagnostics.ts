"use client";

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export const SUPPORT_DIAGNOSTICS_CHANGED_EVENT =
  "brian:support-diagnostics-changed";

export type SupportDiagnosticStatus = {
  active: boolean;
  capture: {
    id: string;
    workspaceId: string;
    includeContent: boolean;
    startedAt: string;
    expiresAt: string;
    eventCount: number;
  } | null;
};

export type SupportDiagnosticPreview = {
  captureId: string;
  expiresAt: string;
  includeContent: boolean;
  selectedSessionId: string | null;
  categories: Array<{ name: string; count: number }>;
  warnings: string[];
};

async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `Request failed (${response.status})`);
}

function emitChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SUPPORT_DIAGNOSTICS_CHANGED_EVENT));
}

export async function getSupportDiagnosticStatus(
  workspaceId: string,
): Promise<SupportDiagnosticStatus> {
  const response = await authFetch(
    `${API_URL}/api/support-diagnostics/status?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return (await requireOk(response).then((result) => result.json())) as SupportDiagnosticStatus;
}

export async function startSupportDiagnosticCapture(params: {
  workspaceId: string;
  durationHours: 1 | 24 | 168;
  includeContent: boolean;
}): Promise<SupportDiagnosticStatus> {
  const response = await authFetch(`${API_URL}/api/support-diagnostics/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const status = (await requireOk(response).then((result) => result.json())) as SupportDiagnosticStatus;
  emitChanged();
  return status;
}

export async function stopSupportDiagnosticCapture(
  workspaceId: string,
): Promise<void> {
  const response = await authFetch(`${API_URL}/api/support-diagnostics/active`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  await requireOk(response);
  emitChanged();
}

export async function previewSupportDiagnosticCapsule(
  workspaceId: string,
): Promise<SupportDiagnosticPreview> {
  const response = await authFetch(
    `${API_URL}/api/support-diagnostics/capsule/preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    },
  );
  return (await requireOk(response).then((result) => result.json())) as SupportDiagnosticPreview;
}

export async function downloadSupportDiagnosticCapsule(
  workspaceId: string,
): Promise<void> {
  const response = await authFetch(`${API_URL}/api/support-diagnostics/capsule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  await requireOk(response);

  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename =
    disposition.match(/filename="([^"]+)"/)?.[1] ??
    `brian-support-capsule-${new Date().toISOString()}.json`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  emitChanged();
}
