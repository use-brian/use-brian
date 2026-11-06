import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";

export type WorkflowPublicationConsents = {
  canManage: boolean;
  workflowUpdatedAt: string;
  consentVersion: string;
  eligibleStepIds: string[];
  consents: Array<{
    stepId: string;
    channelType: "telegram";
    channelId: string;
    channelIntegrationId: string;
    approvedAt: string;
    expiresAt: string;
    active: boolean;
  }>;
};

/** Deliberately separate from workflow definition writes. Never expose server diagnostics. */
async function request(path: string, init?: RequestInit): Promise<WorkflowPublicationConsents> {
  try {
    const response = await authFetch(`${publicRuntimeConfig().apiUrl ?? "http://localhost:4000"}/api/workflows/${path}`, init);
    if (!response.ok) throw new Error("publication_consent_failed");
    const body = await response.json() as WorkflowPublicationConsents;
    // Fail closed on an unavailable/older endpoint or malformed permission envelope.
    if (typeof body.canManage !== "boolean" || typeof body.workflowUpdatedAt !== "string" ||
        typeof body.consentVersion !== "string" || (body.consentVersion.length === 0 || /[^0-9]/.test(body.consentVersion)) ||
        !Array.isArray(body.eligibleStepIds) || !Array.isArray(body.consents)) {
      throw new Error("publication_consent_failed");
    }
    if (!body.eligibleStepIds.every(id => typeof id === "string") || !body.consents.every(row =>
      row && typeof row.stepId === "string" && row.channelType === "telegram" &&
      typeof row.channelId === "string" && typeof row.channelIntegrationId === "string" &&
      typeof row.approvedAt === "string" && typeof row.expiresAt === "string" && typeof row.active === "boolean")) {
      throw new Error("publication_consent_failed");
    }
    // Whitelist metadata so even unexpected response fields never enter the surface cache.
    return {
      canManage: body.canManage,
      workflowUpdatedAt: body.workflowUpdatedAt,
      consentVersion: body.consentVersion,
      eligibleStepIds: body.eligibleStepIds,
      consents: body.consents.map(({ stepId, channelType, channelId, channelIntegrationId, approvedAt, expiresAt, active }) =>
        ({ stepId, channelType, channelId, channelIntegrationId, approvedAt, expiresAt, active })),
    };
  } catch {
    throw new Error("publication_consent_failed");
  }
}

export async function getWorkflowPublicationConsents(workflowId: string) {
  // Bound the complete read, including an auth refresh or a stalled response body.
  // A rejected read releases the shared cache's in-flight slot so Retry can work.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(`${encodeURIComponent(workflowId)}/publication-consents`, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("publication_consent_failed"));
        }, 12_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function approveWorkflowPublicationConsent(workflowId: string, stepId: string, workflowUpdatedAt: string, consentVersion: string) {
  return request(`${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepId)}/publication-consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ acknowledged: true, workflowUpdatedAt, consentVersion }),
  });
}

export function revokeWorkflowPublicationConsent(workflowId: string, stepId: string) {
  return request(`${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepId)}/publication-consent`, { method: "DELETE" });
}
