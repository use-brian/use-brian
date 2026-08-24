/** Feishu/Lark observed-group passive-ingest controls. */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type FeishuIngestGroup = {
  chatId: string;
  title: string | null;
  lastSeenAt: string;
  enabled: boolean;
};

export type FeishuIngestGroups = {
  groups: FeishuIngestGroup[];
  canManage: boolean;
  permissionScope: string;
};

export async function getFeishuIngestGroups(
  instanceId: string,
): Promise<FeishuIngestGroups> {
  const res = await authFetch(
    `${API_URL}/api/ingest/sources/${encodeURIComponent(instanceId)}/feishu/groups`,
  );
  if (!res.ok) throw new Error(`Failed to load Feishu groups (${res.status})`);
  return res.json() as Promise<FeishuIngestGroups>;
}

async function setFeishuGroupIngest(
  instanceId: string,
  chatId: string,
  action: "enable" | "disable",
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/ingest/sources/${encodeURIComponent(instanceId)}/feishu/groups/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
    },
  );
  if (!res.ok) throw new Error(`Failed to ${action} Feishu group (${res.status})`);
}

export function enableFeishuGroup(instanceId: string, chatId: string): Promise<void> {
  return setFeishuGroupIngest(instanceId, chatId, "enable");
}

export function disableFeishuGroup(instanceId: string, chatId: string): Promise<void> {
  return setFeishuGroupIngest(instanceId, chatId, "disable");
}
