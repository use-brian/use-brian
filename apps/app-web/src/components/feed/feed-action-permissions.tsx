"use client";

/** Canonical action policies, reachable without leaving Feed. [COMP:app-web/feed-action-permissions] */
import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Settings2, X } from "lucide-react";
import { useFeedWorkspace, useFeedWorkspaceState } from "@/contexts/feed-profiles-context";
import { ConnectorToolGovernance } from "@/components/connectors/connector-tool-governance";
import type { ConnectorToolListItem, ToolPolicy } from "@/components/connectors/connector-tool-list";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/skeleton";
import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { useT } from "@/lib/i18n/client";
import { useCachedResource, SurfaceCacheEvictionError } from "@/lib/surface-cache";
import { feedPermissionsCacheKey } from "@/lib/surface-prefetch";
import { APPROVALS_REFRESH_EVENT } from "@/lib/approvals-events";

const API_URL = publicRuntimeConfig().apiUrl ?? "";
type Connector = { id: string; providerId?: string; name: string; connected: boolean; enabled: boolean; scope?: string; instanceId?: string };
type Tool = Omit<ConnectorToolListItem, "currentPolicy"> & { effectivePolicy: ToolPolicy; appPolicy: ToolPolicy };
type ToolResponse = { tools: Tool[]; serverName: string };

async function read<T>(path: string): Promise<T> {
  const response = await authFetch(`${API_URL}${path}`);
  if ([401, 403, 404].includes(response.status)) throw new SurfaceCacheEvictionError(response.status);
  if (!response.ok) throw new Error("Permission read failed");
  return response.json() as Promise<T>;
}

function usePermissionRefresh(refresh: () => Promise<unknown>) {
  useEffect(() => {
    const update = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", update);
    window.addEventListener(APPROVALS_REFRESH_EVENT, update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener(APPROVALS_REFRESH_EVENT, update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh]);
}

export function FeedActionPermissions() {
  const team = useFeedWorkspace();
  const t = useT();
  const [selected, setSelected] = useState("");
  const assistants = [...new Map([
    ...team.profiles.map(profile => [profile.assistant.id, profile.assistant] as const),
    ...team.assistants.map(assistant => [assistant.id, assistant] as const),
  ]).values()];
  const assistant = assistants.find(item => item.id === selected) ?? assistants[0];
  return <section className="space-y-4">
    <div className="space-y-1">
      <h2 className="text-sm font-semibold">{t.feedPage.actionPermissions.title}</h2>
      <p className="text-sm text-muted-foreground">{t.feedPage.actionPermissions.description}</p>
    </div>
    {assistant ? <>
      <Select value={assistant.id} onValueChange={value => value && setSelected(value)}>
        <SelectTrigger className="max-sm:min-h-11 w-full" aria-label={t.feedPage.connection.assistantLabel}>
          <SelectValue>{assistant.name}</SelectValue>
        </SelectTrigger>
        <SelectContent>{assistants.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
      </Select>
      <AssistantPermissions key={assistant.id} assistantId={assistant.id} />
    </> : <p className="text-sm text-muted-foreground">{t.feedPage.actionPermissions.empty}</p>}
  </section>;
}

function PermissionError({ retry }: { retry: () => void }) {
  const t = useT();
  return <div role="alert" className="space-y-2 text-sm text-destructive">
    <p>{t.feedPage.actionPermissions.loadError}</p>
    <Button variant="outline" onClick={retry}>{t.feedPage.tuningChat.retry}</Button>
  </div>;
}

function AssistantPermissions({ assistantId }: { assistantId: string }) {
  const team = useFeedWorkspace();
  const t = useT();
  const resource = useCachedResource(feedPermissionsCacheKey(team.workspaceId, assistantId),
    () => read<{ connectors: Connector[] }>(`/api/assistants/${encodeURIComponent(assistantId)}/connectors`));
  usePermissionRefresh(resource.refresh);
  if (resource.error) return <PermissionError retry={() => void resource.refresh()} />;
  if (!resource.data) return <Skeleton className="h-28 w-full" />;
  const connectors = resource.data.connectors.filter(connector => connector.connected && connector.enabled);
  return <div className="space-y-3">
    {connectors.length ? connectors.map(connector => <details key={connector.id} className="rounded-xl border border-border p-3">
      <summary className="min-h-8 max-sm:min-h-11 cursor-pointer content-center text-sm font-medium">{connector.name}</summary>
      <ConnectorPermissions assistantId={assistantId} connector={connector} />
    </details>) : <p className="text-sm text-muted-foreground">{t.feedPage.actionPermissions.empty}</p>}
  </div>;
}

function ConnectorPermissions({ assistantId, connector }: { assistantId: string; connector: Connector }) {
  const team = useFeedWorkspace();
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const path = `/api/assistants/${encodeURIComponent(assistantId)}/connectors/${encodeURIComponent(connector.id)}/tools`;
  const resource = useCachedResource(feedPermissionsCacheKey(team.workspaceId, assistantId, connector.id), () => read<ToolResponse>(path));
  usePermissionRefresh(resource.refresh);
  async function save(toolName: string, policy: ToolPolicy) {
    if (!resource.data || saving) return;
    setSaving(true); setSaveError(false);
    try {
      const response = await authFetch(`${API_URL}${path}/policy`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverName: resource.data.serverName, toolName, policy }),
      });
      if (!response.ok) throw new Error("Permission save failed");
      await resource.refresh();
    } catch { setSaveError(true); }
    finally { setSaving(false); }
  }
  if (resource.error) return <PermissionError retry={() => void resource.refresh()} />;
  if (!resource.data) return <Skeleton className="h-28 w-full" />;
  return <div className="space-y-2" aria-busy={saving}>
    {saveError ? <p role="alert" className="text-sm text-destructive">{t.feedPage.actionPermissions.saveError}</p> : null}
    <ConnectorToolGovernance
      key={resource.updatedAt}
      onPolicyError={() => setSaveError(true)}
      onPolicySaved={() => setSaveError(false)}
      assistantId={assistantId} connectorId={connector.providerId ?? connector.id}
      governanceId={connector.id} scope={connector.scope}
      workspaceId={team.workspaceId} instanceId={connector.instanceId}
      tools={resource.data.tools.map(tool => ({ ...tool, currentPolicy: tool.effectivePolicy, minStrictness: tool.appPolicy }))}
      onPolicyChange={(name, policy) => void save(name, policy)}
    />
  </div>;
}

/** Also available for OSS users with no provider account connected. */
export function FeedActionPermissionsButton() {
  const state = useFeedWorkspaceState();
  const t = useT();
  if (state.status !== "ready") return null;
  return <Dialog.Root>
    <Dialog.Trigger render={<Button variant="ghost" size="icon" className="size-11 md:size-8" aria-label={t.feedPage.actionPermissions.title} />}>
      <Settings2 className="size-4" />
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50" />
      <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100vw-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-4 shadow-xl md:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Dialog.Title className="font-semibold">{t.feedPage.actionPermissions.title}</Dialog.Title>
          <Dialog.Close render={<Button variant="ghost" size="icon" className="max-sm:size-11" aria-label={t.feedPage.inspiration.closeAria} />}><X className="size-4" /></Dialog.Close>
        </div>
        <FeedActionPermissions />
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
