"use client";
/** Department adapter over shared saved-review mechanics. [COMP:app-web/workspace-access] */
import type {DepartmentAccessCommand,DepartmentCommandReview,WorkspaceAccessOverview} from '@use-brian/shared';
import {useT} from '@/lib/i18n/client';
import {Button} from '@/components/ui/button';
import {fetchWorkspaceAccess,prepareWorkspaceAccessCommand,saveWorkspaceAccessCommand} from '@/lib/api/workspace-access';
import {CommandReviewEffects} from './command-review-effects';
import {useReviewedCommand} from './use-reviewed-command';

export function useDepartmentChange(workspaceId:string,onApplied?:(result:WorkspaceAccessOverview,isCurrent:()=>boolean)=>void|Promise<void>,contextKey='') {
  return useReviewedCommand<DepartmentAccessCommand,DepartmentCommandReview,WorkspaceAccessOverview>({workspaceId,contextKey,cachePrefix:'workspace-access',onApplied,
    async prepare(command,version,signal){
      const revision=version??(await fetchWorkspaceAccess(workspaceId)).policyRevision;
      return signal.aborted?null:prepareWorkspaceAccessCommand(workspaceId,command,revision,crypto.randomUUID());
    },
    apply:review=>saveWorkspaceAccessCommand(workspaceId,{type:'access.command.apply',reviewId:review.id,payloadHash:review.payloadHash}),
    renderReview:review=><CommandReviewEffects review={review}/>,
  });
}

export function DepartmentChangeFeedback({ change }: { change: {error:string;busy:boolean;retryAvailable:boolean;retry:()=>Promise<unknown>} }) {
  const t = useT().workspaceAccess;
  return <>
    {change.error ? <p role="alert" className="text-sm text-destructive">{change.error}</p> : null}
    {change.retryAvailable ? <Button type="button" variant="outline" className="max-sm:min-h-11" disabled={change.busy} onClick={() => void change.retry()}>{t.retryChange}</Button> : null}
  </>;
}
