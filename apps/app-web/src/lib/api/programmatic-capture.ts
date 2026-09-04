import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type CapturePartition = "connection" | "user" | "session" | "subject";
export type CaptureRoutingMode = "realtime" | "scheduled" | "drop";
export type CaptureFilterType =
  | "always"
  | "keyword_match"
  | "actor_match"
  | "role_match"
  | "metadata_match";

export type CaptureRule = {
  id: string;
  profileId: string;
  ruleOrder: number;
  filterType: CaptureFilterType;
  filterParams: Record<string, unknown>;
  routingMode: CaptureRoutingMode;
  routingSchedule: string | null;
  routingTimezone: string;
  episodeSensitivity: "public" | "internal" | "confidential" | null;
  compartments: string[];
  projectIds: string[];
};

export type CaptureProfile = {
  id: string;
  workspaceId: string;
  name: string;
  partitionBy: CapturePartition;
  enabled: boolean;
  assistantIds: string[];
  rules: CaptureRule[];
  createdAt: string;
  updatedAt: string;
};

export type CaptureRuleInput = Omit<CaptureRule, "id" | "profileId">;

function base(workspaceId: string): string {
  return `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/programmatic-capture-profiles`;
}

async function expectJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listCaptureProfiles(workspaceId: string): Promise<CaptureProfile[]> {
  const data = await expectJson<{ profiles?: CaptureProfile[] }>(await authFetch(base(workspaceId)));
  return Array.isArray(data.profiles) ? data.profiles : [];
}

export async function createCaptureProfile(
  workspaceId: string,
  input: { name: string; partitionBy: CapturePartition; enabled: boolean },
): Promise<CaptureProfile> {
  const data = await expectJson<{ profile: CaptureProfile }>(await authFetch(base(workspaceId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
  return data.profile;
}

export async function updateCaptureProfile(
  workspaceId: string,
  profile: Pick<CaptureProfile, "id" | "name" | "partitionBy" | "enabled">,
): Promise<CaptureProfile> {
  const data = await expectJson<{ profile: CaptureProfile }>(await authFetch(
    `${base(workspaceId)}/${encodeURIComponent(profile.id)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: profile.name,
        partitionBy: profile.partitionBy,
        enabled: profile.enabled,
      }),
    },
  ));
  return data.profile;
}

export async function deleteCaptureProfile(workspaceId: string, profileId: string): Promise<void> {
  const res = await authFetch(`${base(workspaceId)}/${encodeURIComponent(profileId)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
}

export async function addCaptureRule(
  workspaceId: string,
  profileId: string,
  rule: CaptureRuleInput,
): Promise<CaptureRule> {
  const data = await expectJson<{ rule: CaptureRule }>(await authFetch(
    `${base(workspaceId)}/${encodeURIComponent(profileId)}/rules`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rule),
    },
  ));
  return data.rule;
}

export async function deleteCaptureRule(
  workspaceId: string,
  profileId: string,
  ruleId: string,
): Promise<void> {
  const res = await authFetch(
    `${base(workspaceId)}/${encodeURIComponent(profileId)}/rules/${encodeURIComponent(ruleId)}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
}

export async function setAssistantCaptureProfile(
  workspaceId: string,
  assistantId: string,
  profileId: string | null,
): Promise<void> {
  const res = await authFetch(
    `${base(workspaceId)}/assistants/${encodeURIComponent(assistantId)}/default`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}
