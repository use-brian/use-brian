/**
 * Assistant email inbox API client (`/api/email-inboxes`).
 *
 * The hosted-managed provisioning surface for assistant-owned email
 * (docs/architecture/integrations/agentmail.md). The whole surface is dark
 * when no email provider is configured server-side: every endpoint returns
 * 503 `email_provider_not_configured`, which `probeEmailInboxes` maps to
 * `{ configured: false }` so the Channels page hides the inbox affordances.
 *
 * [COMP:app-web/studio-channels]
 */

import { authFetch } from "@/lib/auth-fetch";
import { API_URL } from "@/lib/api/channels";

export type EmailInbox = {
  channelId: string;
  address: string;
  displayName: string;
  status: string;
  assistantId: string | null;
  allowlist: string[];
  connectorInstanceId: string | null;
  lastEventAt: string | null;
  createdAt: string;
};

export type EmailDomainSummary = {
  id: string;
  domain: string;
  status: "pending" | "verified" | "failed";
  records: Array<{ type: string; name: string; value: string; status: string | null; priority: number | null }>;
};

export type EmailInboxesProbe =
  | { configured: false }
  | { configured: true; inboxes: EmailInbox[]; domains: EmailDomainSummary[] };

/** List inboxes; a 503 means the provider is not configured (hide the UI). */
export async function probeEmailInboxes(workspaceId: string): Promise<EmailInboxesProbe> {
  const res = await authFetch(
    `${API_URL}/api/email-inboxes?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (res.status === 503) return { configured: false };
  if (!res.ok) throw new Error(`Failed to load inboxes (${res.status})`);
  const data = (await res.json()) as { inboxes?: EmailInbox[]; domains?: EmailDomainSummary[] };
  return {
    configured: true,
    inboxes: Array.isArray(data.inboxes) ? data.inboxes : [],
    domains: Array.isArray(data.domains) ? data.domains : [],
  };
}

export async function createEmailInbox(params: {
  workspaceId: string;
  username: string;
  domainId?: string | null;
  assistantId: string;
  displayName?: string;
}): Promise<{ channelId: string; address: string }> {
  const res = await authFetch(`${API_URL}/api/email-inboxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await res.json().catch(() => ({}))) as {
    channelId?: string;
    address?: string;
    error?: string;
  };
  if (!res.ok || !data.channelId || !data.address) {
    throw new Error(data.error ?? `Failed to create inbox (${res.status})`);
  }
  return { channelId: data.channelId, address: data.address };
}

export async function updateEmailInbox(params: {
  workspaceId: string;
  channelId: string;
  assistantId?: string;
  allowlist?: string[];
  displayName?: string;
}): Promise<void> {
  const { channelId, ...body } = params;
  const res = await authFetch(
    `${API_URL}/api/email-inboxes/${encodeURIComponent(channelId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to update inbox (${res.status})`);
  }
}

export async function deleteEmailInbox(params: {
  workspaceId: string;
  channelId: string;
}): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/email-inboxes/${encodeURIComponent(params.channelId)}?workspaceId=${encodeURIComponent(params.workspaceId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to delete inbox (${res.status})`);
  }
}
