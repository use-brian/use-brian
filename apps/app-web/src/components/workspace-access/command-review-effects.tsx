"use client";
/** Canonical permission effects shared by every editor. [COMP:app-web/workspace-access] */
import type { DepartmentCommandReview } from '@use-brian/shared';
import { ArrowRight } from 'lucide-react';
import { useT } from '@/lib/i18n/client';

type Values=DepartmentCommandReview['changes'][number]['before'];
const isEmpty=(items:Values)=>!items.length||items.every(item=>item.kind==='code'&&item.value==='none');

export function CommandReviewEffects({review}:{review:DepartmentCommandReview}) {
  const dictionary=useT(),t=dictionary.workspaceAccess,scope=dictionary.scopeReview;
  const labels:Record<string,string>={name:t.reviewName,description:t.reviewDescription,color:t.reviewColor,status:t.reviewStatus,directory_visibility:t.reviewDirectory,requestable:t.requestable,read_all:t.reviewAll,classification_mode:scope.classificationMode,clearance:t.clearance,team_scope_mode:t.scopeMode,project_scope_mode:t.reviewProjectMode,member:t.reviewMembership,capabilities:t.reviewCapabilities,bundle:t.departments,assistant_ids:t.reviewAssistants,team_ids:t.departments,project_ids:t.reviewProjects,default_workspace_group_id:t.reviewDefaultDepartment,default_department_id:t.reviewDefaultDepartment,default_project_id:t.reviewDefaultProject,reviewer_id:t.reviewReviewer,reason:t.reason,starts_at:t.starts,expires_at:t.expires,revoked_at:t.revoked};
  const codes:Record<string,string>={none:t.reviewNone,enabled:t.enabled,disabled:t.disabled,legacy:scope.legacy,review:scope.review,strict:scope.strict,assigned:t.assignedMode,all:t.allDepartments,workspace:t.reviewWorkspace,members:t.reviewMembers,active:t.active,archived:t.reviewArchived,public:t.public,internal:t.internal,confidential:t.confidential,manage_members:t.manageMembers,approve_read_requests:t.approveRequests,pending:t.pending,approved:t.approved,rejected:t.rejected,cancelled:t.cancelled,revoked:t.revoked,unnamed:t.unnamed};
  const values=(items:Values)=>isEmpty(items)?t.reviewNone:items.map(item=>item.kind==='code'?(codes[item.value]??t.unnamed):item.value).join(', ');
  if(!review.changes.length)return <p className="text-sm">{review.alreadyApplied?t.reviewAlreadyApplied:t.reviewNoChanges}</p>;
  // Nothing existed before (a create, or a first assignment): list the
  // starting settings instead of a column of "Before: None" rows.
  const fresh=review.changes.every(change=>isEmpty(change.before));
  const rows=fresh?review.changes.filter(change=>!isEmpty(change.after)):review.changes;
  return <dl className="max-h-[50dvh] divide-y divide-border overflow-y-auto rounded-lg border border-border text-sm">
    {rows.map(change=><div key={change.field} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-3">
      <dt className="text-muted-foreground">{labels[change.field]??t.unnamed}</dt>
      <dd className="min-w-0 break-words font-medium">{fresh?values(change.after):<span className="flex flex-wrap items-center gap-x-1.5">
        <span className="sr-only">{t.reviewBefore}: </span><span className="font-normal text-muted-foreground line-through decoration-muted-foreground/50">{values(change.before)}</span>
        <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground"/>
        <span className="sr-only">{t.reviewAfter}: </span><span>{values(change.after)}</span>
      </span>}</dd>
    </div>)}
  </dl>;
}
