"use client";

/** Owner/admin Office grant and workspace-default management. [COMP:app-web/office-history-sharing] */
import { useEffect, useMemo, useState } from "react";
import { getOfficeSharing, revokeOfficeGrant, setOfficeDefaultRole, setOfficeGrant, type OfficeSharing as SharingState } from "@/lib/office/api";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";

const ROLES = ["view", "comment", "edit"] as const;
type Role = typeof ROLES[number];

export function OfficeSharing({ artifactId }: { artifactId: string }) {
  const t = useT().office;
  const [sharing, setSharing] = useState<SharingState | null>(null);
  const reload = () => getOfficeSharing(artifactId).then(setSharing).catch(() => setSharing(null));
  useEffect(() => { void reload(); }, [artifactId]);
  const roleItems = useMemo(() => ROLES.map((role) => ({ value: role, label: roleLabel(role, t) })), [t]);

  async function changeDefault(role: Role) {
    if (!sharing || role === sharing.defaultWorkspaceRole) return;
    const confirmed = await confirmDialog({ title: t.changeDefaultRole, description: t.changeDefaultRoleDescription.replace("{role}", roleLabel(role, t)), confirmLabel: t.changeRole, cancelLabel: t.cancel });
    if (!confirmed) return;
    await setOfficeDefaultRole(artifactId, role); await reload();
  }

  async function changeMember(userId: string, role: Role) {
    const confirmed = await confirmDialog({ title: t.changeMemberRole, description: t.changeMemberRoleDescription.replace("{role}", roleLabel(role, t)), confirmLabel: t.changeRole, cancelLabel: t.cancel });
    if (!confirmed) return;
    await setOfficeGrant(artifactId, userId, role); await reload();
  }

  async function inheritDefault(userId: string) {
    const confirmed = await confirmDialog({ title: t.removeSpecificAccess, description: t.removeSpecificAccessDescription, confirmLabel: t.removeSpecificAccess, cancelLabel: t.cancel });
    if (!confirmed) return;
    await revokeOfficeGrant(artifactId, userId); await reload();
  }

  if (!sharing) return <p className="text-xs text-muted-foreground">{t.sharingLoading}</p>;
  const liveGrants = new Map(sharing.grants.filter((grant) => !grant.revokedAt && grant.role !== "deny").map((grant) => [grant.userId, grant.role as Role]));
  return <section aria-label={t.sharing} className="space-y-3"><h2 className="text-sm font-semibold">{t.sharing}</h2><div className="rounded-lg border p-3"><p className="text-xs font-medium">{t.workspaceDefault}</p><p className="mb-2 text-xs text-muted-foreground">{t.workspaceDefaultDescription}</p><SearchableSelect value={sharing.defaultWorkspaceRole} onValueChange={(value) => void changeDefault(value as Role)} items={roleItems} disabled={!sharing.canManage} aria-label={t.workspaceDefault} searchPlaceholder={t.searchRoles} emptyMessage={t.noRoles} /></div><div className="space-y-2">{sharing.members.map((member) => { const explicit = liveGrants.get(member.userId); const effective = member.isOwner ? "edit" : explicit ?? sharing.defaultWorkspaceRole; return <article key={member.userId} className="rounded-lg border p-3"><p className="truncate text-xs font-medium">{member.userName || member.email || t.member}</p>{member.email ? <p className="truncate text-[11px] text-muted-foreground">{member.email}</p> : null}<div className="mt-2"><SearchableSelect value={effective} onValueChange={(value) => void changeMember(member.userId, value as Role)} items={roleItems} disabled={!sharing.canManage || member.isOwner} aria-label={t.memberRole.replace("{member}", member.userName || member.email || t.member)} searchPlaceholder={t.searchRoles} emptyMessage={t.noRoles} /></div>{member.isOwner ? <p className="mt-1 text-[11px] text-muted-foreground">{t.ownerAlwaysEditor}</p> : explicit && sharing.canManage ? <button type="button" onClick={() => void inheritDefault(member.userId)} className="mt-1 text-[11px] text-muted-foreground hover:underline">{t.useWorkspaceDefault}</button> : null}</article>; })}</div></section>;
}

function roleLabel(role: Role, t: ReturnType<typeof useT>["office"]): string { return { view: t.viewer, comment: t.commenter, edit: t.editorRole }[role]; }
