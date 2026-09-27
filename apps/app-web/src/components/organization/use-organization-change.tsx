"use client";
/** Saved directory reviews with the shared confirmation lifecycle. [COMP:app-web/organization-chart] */
import type {OrganizationChart,OrganizationCommand,OrganizationCommandReview} from '@use-brian/shared';
import {useT} from '@/lib/i18n/client';
import {fetchOrganizationChart,prepareOrganizationCommand,saveOrganizationCommand} from '@/lib/api/workspace-access';
import {useReviewedCommand} from '@/components/workspace-access/use-reviewed-command';

export function useOrganizationChange(workspaceId:string,onApplied:()=>void) {
  const t=useT().organization;
  return useReviewedCommand<OrganizationCommand,OrganizationCommandReview,OrganizationChart>({workspaceId,cachePrefix:'organization',onApplied,labels:{loadError:t.loadError,saveError:t.saveError,stale:t.conflict,confirmTitle:t.confirmTitle},
    async prepare(command,_version,signal){
      const chart=await fetchOrganizationChart(workspaceId);
      if(signal.aborted)return null;
      if(!chart.canManage||!chart.initialization)throw new Error('admin_required');
      return prepareOrganizationCommand(workspaceId,{command,expectedRevision:chart.revision,expectedPolicyRevision:chart.initialization.policyRevision,idempotencyKey:crypto.randomUUID()});
    },
    apply:review=>saveOrganizationCommand(workspaceId,{type:'org.command.apply',reviewId:review.id,payloadHash:review.payloadHash}),
    renderReview:review=><OrganizationReviewEffects review={review}/>,
  });
}
function OrganizationReviewEffects({review}:{review:OrganizationCommandReview}) {
  const dictionary=useT(),t=dictionary.organization,a=dictionary.workspaceAccess;
  const fields:Record<string,string>={exists:t.reviewPresent,name:t.unitName,parentId:t.parent,teamId:t.linkedDepartment,directoryVisibility:t.directory,position:t.reviewPosition,unitId:t.unit,userId:t.person,assistantId:t.assistant,isPrimary:t.primary,reportsToUserId:t.reportsTo,accountableUserId:t.accountable};
  const codes:Record<string,string>={none:t.none,unnamed:a.unnamed,enabled:a.enabled,disabled:a.disabled,members:t.restricted,workspace:t.published};
  const values=(items:OrganizationCommandReview['effects'][number]['changes'][number]['before'])=>items.map(item=>item.kind==='code'?codes[item.value]??a.unnamed:item.value).join(', ');
  return <div className="max-h-[40dvh] space-y-4 overflow-y-auto text-sm">
    {!review.effects.length?<p>{review.alreadyApplied?a.reviewAlreadyApplied:a.reviewNoChanges}</p>:review.effects.map((effect,index)=><section key={index} className="space-y-2 break-words">
      <h3 className="font-semibold">{effect.kind==='unit'?t.unit:t.reviewPlacement}: {effect.name||a.unnamed}</h3>
      {effect.changes.map(change=><div key={change.field}><p className="font-medium">{fields[change.field]??a.unnamed}</p><p>{a.reviewBefore}: {values(change.before)}</p><p>{a.reviewAfter}: {values(change.after)}</p></div>)}
    </section>)}
    <p>{t.permissionHint}</p><p>{a.expires}: {new Date(review.expiresAt).toLocaleString()}</p>
  </div>;
}
