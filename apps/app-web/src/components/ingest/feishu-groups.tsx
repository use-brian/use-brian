/**
 * Feishu/Lark per-observed-group consent controls.
 *
 * [COMP:app-web/studio-feishu-ingest]
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  disableFeishuGroup,
  enableFeishuGroup,
  getFeishuIngestGroups,
  type FeishuIngestGroup,
} from "@/lib/api/feishu-ingest";
import { useT } from "@/lib/i18n/client";

export function FeishuGroupManager({
  instanceId,
  onChange,
}: {
  instanceId: string;
  onChange: () => void;
}) {
  const copy = useT().studioPage.ingestRules.feishu;
  const [groups, setGroups] = useState<FeishuIngestGroup[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(() => {
    setLoadError(false);
    getFeishuIngestGroups(instanceId)
      .then((result) => {
        setGroups(result.groups);
        setCanManage(result.canManage);
      })
      .catch(() => {
        setGroups([]);
        setLoadError(true);
      });
  }, [instanceId]);

  useEffect(() => load(), [load]);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
        {copy.permissionNote}
        <code className="ml-1 font-mono">im:message.group_msg</code>
      </div>
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {copy.groupsTitle}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {copy.groupsHelp}
        </p>
      </div>
      {groups === null ? (
        <p className="text-xs text-muted-foreground">{copy.working}</p>
      ) : loadError ? (
        <p className="text-xs text-destructive">{copy.loadError}</p>
      ) : groups.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {copy.groupsEmpty}
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => (
            <FeishuGroupRow
              key={group.chatId}
              group={group}
              instanceId={instanceId}
              canManage={canManage}
              onChange={() => {
                load();
                onChange();
              }}
            />
          ))}
        </ul>
      )}
      {!canManage && groups !== null && !loadError && (
        <p className="text-xs text-muted-foreground">{copy.adminOnly}</p>
      )}
    </div>
  );
}

function FeishuGroupRow({
  group,
  instanceId,
  canManage,
  onChange,
}: {
  group: FeishuIngestGroup;
  instanceId: string;
  canManage: boolean;
  onChange: () => void;
}) {
  const copy = useT().studioPage.ingestRules.feishu;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function toggle() {
    setBusy(true);
    setFailed(false);
    try {
      if (group.enabled) await disableFeishuGroup(instanceId, group.chatId);
      else await enableFeishuGroup(instanceId, group.chatId);
      onChange();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${group.enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {group.title ?? copy.observedGroup}
          </span>
          <span className="block truncate font-mono text-[10px] text-muted-foreground">
            {group.chatId}
          </span>
        </span>
        {group.enabled && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {copy.dailyDigest}
          </span>
        )}
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy || !canManage}
          className={
            "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 " +
            (group.enabled
              ? "border border-border text-muted-foreground hover:text-destructive"
              : "bg-action text-action-foreground hover:bg-action/90")
          }
        >
          {busy ? copy.working : group.enabled ? copy.disableAction : copy.enableAction}
        </button>
      </div>
      {failed && <p className="mt-1 text-[11px] text-destructive">{copy.updateError}</p>}
    </li>
  );
}
