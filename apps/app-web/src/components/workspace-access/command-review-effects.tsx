"use client";
/** Canonical permission effects shared by every editor. [COMP:app-web/workspace-access] */
import type { DepartmentCommandReview } from '@use-brian/shared';
import { useT } from '@/lib/i18n/client';

export function CommandReviewEffects({review}:{review:DepartmentCommandReview}) {
  const dictionary=useT(),t=dictionary.workspaceAccess,scope=dictionary.scopeReview;
  const labels:Record<string,string>={name:t.reviewName,description:t.reviewDescription,color:t.reviewColor,status:t.reviewStatus,directory_visibility:t.reviewDirectory,requestable:t.requestable,read_all:t.reviewAll,classification_mode:scope.classificationMode,clearance:t.clearance,team_scope_mode:t.scopeMode,project_scope_mode:t.reviewProjectMode,member:t.reviewMembership,capabilities:t.reviewCapabilities,bundle:t.departments,assistant_ids:t.reviewAssistants,team_ids:t.departments,project_ids:t.reviewProjects,default_workspace_group_id:t.reviewDefaultDepartment,default_department_id:t.reviewDefaultDepartment,default_project_id:t.reviewDefaultProject,reviewer_id:t.reviewReviewer,reason:t.reason,starts_at:t.starts,expires_at:t.expires,revoked_at:t.revoked};
  const codes:Record<string,string>={none:t.reviewNone,enabled:t.enabled,disabled:t.disabled,legacy:scope.legacy,review:scope.review,strict:scope.strict,assigned:t.assignedMode,all:t.allDepartments,workspace:t.reviewWorkspace,members:t.reviewMembers,active:t.active,archived:t.reviewArchived,public:t.public,internal:t.internal,confidential:t.confidential,manage_members:t.manageMembers,approve_read_requests:t.approveRequests,pending:t.pending,approved:t.approved,rejected:t.rejected,cancelled:t.cancelled,revoked:t.revoked,unnamed:t.unnamed};
  const values=(items:DepartmentCommandReview['changes'][number]['before'])=>items.map(item=>item.kind==='code'?(codes[item.value]??t.unnamed):item.value).join(', ');
  return <div className="max-h-[40dvh] space-y-3 overflow-y-auto text-sm">
    {!review.changes.length?<p>{review.alreadyApplied?t.reviewAlreadyApplied:t.reviewNoChanges}</p>:review.changes.map(change=><div key={change.field} className="space-y-1 break-words"><p className="font-medium">{labels[change.field]??t.unnamed}</p><p>{t.reviewBefore}: {values(change.before)}</p><p>{t.reviewAfter}: {values(change.after)}</p></div>)}
    <p className="text-muted-foreground">{t.expires}: {new Date(review.expiresAt).toLocaleString()}</p>
  </div>;
}
