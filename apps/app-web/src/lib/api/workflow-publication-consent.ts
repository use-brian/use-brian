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

export function getWorkflowPublicationConsents(workflowId: string) {
  return request(`${encodeURIComponent(workflowId)}/publication-consents`);
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
