import {crmImportJobFloor,crmKeyBindingScope} from './retention-authority.js'
import { assertCrmDeliveryScope } from './delivery-source-authority.js'
/** Shared contact and Association privacy authority. [COMP:crm/privacy-previews] */
import type {PoolClient} from 'pg'
import {deriveResourceScope,resourceScopeKey,CrmOperationsError,type ResourceScope,type ScopeSource,type CrmOperationsContext,type AssociationActor} from '@use-brian/core'
import {assertAssociationOrderAuthority,assertAssociationSourceAuthority,loadAssociationOrderScope} from '../association/source-scope.js'
import {CRM_PRIVACY_COVERAGE} from './privacy-coverage.js'
import {prepareCrmPrivacyCopies} from './privacy-copy-resolver.js'
const conflict=(reason:string)=>new CrmOperationsError('conflict','Review a current CRM erasure preview before proceeding.',{reason})
const associationRecords=[
  ['association_notification_outbox','notification'],
  ['association_integration_events','provider_receipt'],
  ['association_enquiries','submission'],
  ['association_consent_events','consent'],['crm_suppression_events','suppression'],
  ['association_orders','order'],['association_memberships','membership'],['association_membership_checkouts','checkout'],
  ['association_sponsorship_allocations','allocation'],['association_sponsorship_invitations','invitation'],
  ['association_membership_offline_rescues','rescue'],['association_registrations','registration'],
] as const

/** Source admission retains the credential identity; callers separately require the operation. */
export function crmPrivacySourceActor(context:CrmOperationsContext):AssociationActor {
  if(context.actor.kind==='user')return {credentialKind:'user',credentialId:context.actor.userId,actingUserId:context.actor.userId}
  if(context.actor.kind==='integration_key'&&context.authority.integration?.credentialId===context.actor.credentialId)
    return {credentialKind:'integration_key',credentialId:context.actor.credentialId,integration:context.authority.integration}
  throw new CrmOperationsError('not_authorized','A current department-bound principal is required.')
}

/** Activities keep immutable historical protection independently of their CRM root. */
async function activityAuthority(client:PoolClient,context:CrmOperationsContext,id:string) {
  const row=(await client.query<{entityId:string;origin:string;held:boolean;scope:ResourceScope}>(`
    SELECT entity_id AS "entityId",scope_origin AS origin,scope_held AS held,
      jsonb_build_object('workspaceId',workspace_id,'userId',user_id,'assistantId',assistant_id,
        'sensitivity',sensitivity,'compartments',compartments,'projectIds',project_ids) AS scope
    FROM crm_activities WHERE workspace_id=$1 AND id=$2 FOR SHARE`,[context.workspaceId,id])).rows[0]
  if(!row||row.origin!=='captured'||row.held)throw new CrmOperationsError('not_authorized','The activity scope is unavailable.')
  const source=await loadAssociationOrderScope(client,context.workspaceId,[row.entityId])
  await assertAssociationSourceAuthority(client,context.workspaceId,
    crmPrivacySourceActor(context),
    {scope:row.scope,sources:source.sources})
  return {scope:row.scope,sources:source.sources}
}

/** Retired event receipts retain only their saved audience, never a deleted source id. */
export async function assertCrmEventPrivacyAuthority(client:PoolClient,context:CrmOperationsContext,id:string) {
  const row=(await client.query<{scope:ResourceScope|null;status:string;minimized:boolean}>(`
    SELECT privacy_scope AS scope,status,(subject_id='00000000-0000-0000-0000-000000000000'::uuid
      AND payload=jsonb_build_object('erased',true,'eventType',event_type) AND scope_source IS NULL) AS minimized
    FROM crm_domain_event_outbox WHERE workspace_id=$1 AND id=$2 FOR SHARE`,[context.workspaceId,id])).rows[0]
  if(!row?.scope||(row.status==='retired'&&!row.minimized))throw new CrmOperationsError('not_authorized','The event scope is unavailable.')
  let sources:ScopeSource[]=[]
  if(row.status!=='retired') {
    const source=(await client.query<{snapshot:(ScopeSource&{causalEntityId:string;held:boolean})|null}>("SELECT read_scope_source($1,'crm_event',$2) AS snapshot",[context.workspaceId,id])).rows[0]?.snapshot
    if(!source||source.workspaceId!==context.workspaceId||source.resourceId!==id||source.held!==false||!source.causalEntityId)throw new CrmOperationsError('not_authorized','The event source is unavailable.')
    sources=(await loadAssociationOrderScope(client,context.workspaceId,[source.causalEntityId])).sources
  }
  await assertAssociationSourceAuthority(client,context.workspaceId,
    crmPrivacySourceActor(context),{scope:row.scope,sources})
  return {scope:row.scope,sources}
}

/** Canonical copy sets can carry independently protected sources outside direct attribution. */
async function* copyAuthorities(client:PoolClient,context:CrmOperationsContext,contactId:string|null) {
  await prepareCrmPrivacyCopies(client,context.workspaceId,contactId)
  let after:string|null=null
  for(;;) {
    const page:{rows:Array<{id:string}>}=await client.query(`WITH RECURSIVE lineage(id) AS (
      SELECT id FROM pg_temp.crm_privacy_copy_workflows
      UNION
      SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id WHERE s.workspace_id=$1
    ), events(id) AS (
      SELECT r.crm_event_id FROM workflow_runs r JOIN lineage l ON l.id=r.id WHERE r.workspace_id=$1 AND r.crm_event_id IS NOT NULL
      UNION
      SELECT g.event_id FROM workflow_runs r JOIN lineage l ON l.id=r.id
        JOIN goal_crm_event_sources g ON g.workspace_id=r.workspace_id AND g.goal_id=r.source_goal_id WHERE r.workspace_id=$1
    ) SELECT id FROM events WHERE ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 256`,[context.workspaceId,after])
    for(const {id} of page.rows)yield await assertCrmEventPrivacyAuthority(client,context,id)
    if(page.rows.length<256)break
    after=page.rows.at(-1)!.id
  }
  yield* workflowArtifactAuthorities(client,context)
  yield* inventoryAuthorities(client,context,contactId)
}

/** Saved run context and typed artifacts are independent of CRM event audiences. */
async function* workflowArtifactAuthorities(client:PoolClient,context:CrmOperationsContext) {
  const actor=crmPrivacySourceActor(context)
  const unavailable=()=>new CrmOperationsError('not_authorized','The workflow source scope is unavailable.')
  type Blueprint=ScopeSource&{held:boolean;validTo:string|null;retractedAt:string|null}
  const blueprint=async(id:string)=>{
    const source=(await client.query<{source:Blueprint|null}>("SELECT read_scope_source($1,'blueprint_record',$2) AS source",[context.workspaceId,id])).rows[0]?.source
    if(!source||source.held!==false||source.validTo!==null||source.retractedAt!==null)throw unavailable()
    await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope:source,sources:[]})
    return source
  }
  let after:string|null=null
  for(;;) {
    const page:{rows:Array<{id:string;scope:ResourceScope;valid:boolean}>}=await client.query(`WITH RECURSIVE lineage(id) AS (
      SELECT id FROM pg_temp.crm_privacy_copy_workflows
      UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id WHERE s.workspace_id=$1
    ) SELECT r.id,
      (r.context_group_id IS NULL OR ('team:'||r.context_group_id::text)=ANY(r.context_compartments))
        AND (w.context_group_id IS NULL OR g.compartment_key IS NOT NULL) AS valid,
      jsonb_build_object('workspaceId',r.workspace_id,'userId',NULL,'assistantId',NULL,'sensitivity','public',
        'compartments',r.context_compartments||CASE WHEN g.compartment_key IS NULL THEN ARRAY[]::text[] ELSE ARRAY[g.compartment_key] END,
        'projectIds',r.context_project_ids||CASE WHEN w.context_project_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[w.context_project_id] END) AS scope
      FROM lineage l JOIN workflow_runs r ON r.id=l.id JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
      LEFT JOIN workspace_groups g ON g.id=w.context_group_id AND g.workspace_id=w.workspace_id AND g.kind='team'
      WHERE r.workspace_id=$1 AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT 256 FOR SHARE OF r,w`,[context.workspaceId,after])
    for(const run of page.rows) {
      if(!run.valid)throw unavailable()
      await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope:run.scope,sources:[]})
      yield {scope:run.scope,sources:[] as ScopeSource[]}
      let artifactAfter:string|null=null
      for(;;) {
        const artifacts:{rows:Array<{id:string}>}=await client.query(`SELECT id FROM blueprint_records
          WHERE workspace_id=$1 AND source_kind IN('workflow','research') AND source_id=$2
          AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 256`,[context.workspaceId,run.id,artifactAfter])
        for(const {id} of artifacts.rows)yield {scope:await blueprint(id),sources:[] as ScopeSource[]}
        if(artifacts.rows.length<256)break
        artifactAfter=artifacts.rows.at(-1)!.id
      }
      let copyAfter:string|null=null
      for(;;) {
        const copies:{rows:Array<{id:string;captured:boolean;source:Blueprint|null}>}=await client.query(`SELECT source_run_id AS id,blueprint_source IS NOT NULL AS captured,blueprint_source AS source
          FROM workflow_run_copy_sources WHERE workspace_id=$1 AND run_id=$2 AND ($3::uuid IS NULL OR source_run_id>$3)
          ORDER BY source_run_id LIMIT 256 FOR SHARE`,[context.workspaceId,run.id,copyAfter])
        for(const copy of copies.rows) {
          if(!copy.captured)throw unavailable()
          if(copy.source) {
            if(copy.source.resourceKind!=='blueprint_record'||copy.source.workspaceId!==context.workspaceId)throw unavailable()
            const live=await blueprint(copy.source.resourceId)
            await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope:copy.source,sources:[live]})
            yield {scope:copy.source,sources:[live]}
          }
        }
        if(copies.rows.length<256)break
        copyAfter=copies.rows.at(-1)!.id
      }
    }
    if(page.rows.length<256)break
    after=page.rows.at(-1)!.id
  }
}

/** Redacted inventory still requires each selected canonical resource's authority. */
async function* inventoryAuthorities(client:PoolClient,context:CrmOperationsContext,contactId:string|null) {
  const actor=crmPrivacySourceActor(context)
  for(const [table,kind] of [['tasks','task'],['entity_links','entity_link'],['workspace_files','workspace_file']] as const) {
    const coverage=CRM_PRIVACY_COVERAGE.find(entry=>entry.domain===table)
    const predicate=contactId?coverage?.subjectWhere:coverage?.workspaceWhere
    if(!predicate)throw new Error('Missing privacy inventory coverage predicate')
    let after:string|null=null
    for(;;) {
      const page:{rows:Array<{id:string}>}=await client.query(`WITH privacy_args AS (SELECT $1::uuid workspace_id,$2::uuid contact_id)
        SELECT t.id FROM ${table} t WHERE t.workspace_id=$1 AND (${predicate})
        AND ($3::uuid IS NULL OR t.id>$3) ORDER BY t.id LIMIT 256`,[context.workspaceId,contactId,after])
      for(const {id} of page.rows) {
        const source=(await client.query<{source:(ScopeSource&{held:boolean})|null}>(
          'SELECT read_scope_review_source($1,$2,$3) AS source',[context.workspaceId,kind,id])).rows[0]?.source
        if(!source||source.workspaceId!==context.workspaceId||source.resourceKind!==kind||source.resourceId!==id||source.held!==false)
          throw new CrmOperationsError('not_authorized','The copy inventory scope is unavailable.')
        await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope:source,sources:[]})
        yield {scope:source,sources:[] as ScopeSource[]}
      }
      if(page.rows.length<256)break
      after=page.rows.at(-1)!.id
    }
  }
}

/** Full workspace bundles cannot silently omit an inaccessible root or receipt. */
export async function assertCrmPrivacyWorkspaceAuthority(client:PoolClient,context:CrmOperationsContext):Promise<ResourceScope|null> {
  const workspace=(await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[context.workspaceId])).rows[0]
  if(!workspace)throw new CrmOperationsError('not_authorized','The workspace is unavailable.')
  if(workspace.department_read_v2===false)return null
  const actor=crmPrivacySourceActor(context)
  let floor:ResourceScope|null=null
  const accumulate=(scope:ResourceScope,sources:ScopeSource[]=[])=>{
    floor=deriveResourceScope({producer:'crm.privacy-export',sources:[...sources,
      {...scope,resourceKind:'privacy-export-source-floor',resourceId:context.workspaceId,version:'current'},
      ...(floor?[{...floor,resourceKind:'privacy-export-floor',resourceId:context.workspaceId,version:'accumulated'}]:[]),
    ]})
  }
  for(const table of ['entities','crm_activities','crm_domain_event_outbox',...associationRecords.map(([table])=>table),'crm_privacy_previews','crm_import_file_cleanups','crm_retention_runs']) {
    const coverage=CRM_PRIVACY_COVERAGE.find(entry=>entry.domain===table)
    if(!coverage)throw new Error('Missing privacy coverage predicate')
    let after:string|null=null
    for(;;) {
      const page:{rows:Array<{id:string}>}=await client.query(`SELECT t.id FROM ${table} t WHERE t.workspace_id=$1 AND (${coverage.workspaceWhere}) AND ($2::uuid IS NULL OR t.id>$2::uuid) ORDER BY t.id LIMIT 256`,[context.workspaceId,after])
      for(const {id} of page.rows) {
        if(table==='entities') {
          const source=(await client.query<{snapshot:(ScopeSource&{held:boolean;validTo:string|null;retractedAt:string|null})|null}>("SELECT read_scope_source($1,'entity',$2) AS snapshot",[context.workspaceId,id])).rows[0]?.snapshot
          if(!source||source.workspaceId!==context.workspaceId||source.resourceKind!=='entity'||source.resourceId!==id||source.held!==false)throw new CrmOperationsError('not_authorized','The CRM scope is unavailable.')
          const {held:_held,validTo:_validTo,retractedAt:_retractedAt,...scope}=source
          await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope,sources:[]})
          accumulate(scope)
        }else if(table==='crm_activities'||table==='crm_domain_event_outbox') {
          const evidence=await (table==='crm_activities'?activityAuthority:assertCrmEventPrivacyAuthority)(client,context,id)
          accumulate(evidence.scope,evidence.sources)
        }else if(table==='crm_privacy_previews'||table==='crm_import_file_cleanups'||table==='crm_retention_runs') {
          const saved=(await client.query<{scope:ResourceScope|null}>(`SELECT scope_snapshot AS scope FROM ${table} WHERE workspace_id=$1 AND id=$2 FOR SHARE`,[context.workspaceId,id])).rows[0]?.scope
          if(!saved)throw new CrmOperationsError('not_authorized','The saved review scope is unavailable.')
          await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope:saved,sources:[]})
          accumulate(saved)
        }else {
          const kind=associationRecords.find(([candidate])=>candidate===table)![1]
          const evidence=await assertAssociationOrderAuthority(client,context.workspaceId,id,actor,kind)
          if(!evidence)throw new CrmOperationsError('not_authorized','The operational scope is unavailable.')
          accumulate(evidence.scope,evidence.sources)
        }
      }
      if(page.rows.length<256)break
      after=page.rows.at(-1)!.id
    }
  }
  for await(const evidence of promotionUsageAuthorities(client,context,null))accumulate(evidence.scope,evidence.sources)
  for await(const evidence of deliveryAuthorities(client,context,null))accumulate(evidence.scope,evidence.sources)
  for await(const evidence of copyAuthorities(client,context,null))accumulate(evidence.scope,evidence.sources)
  // Families that carry personal content without a CRM root of their own: each needs its own floor.
  const unavailable=()=>new CrmOperationsError('not_authorized','The export source scope is unavailable.')
  const families:Array<[string,(id:string)=>Promise<{scope:ResourceScope;sources:ScopeSource[]}|null>]>=[
    ['crm_import_jobs',async id=>{const scope=await crmImportJobFloor(client,context.workspaceId,id);if(!scope)throw unavailable();return {scope,sources:[]}}],
    ['crm_import_sources',async id=>{
      const row=(await client.query<{binding:unknown;keyed:boolean}>(`SELECT k.department_binding AS binding,s.credential_id IS NOT NULL AS keyed
        FROM crm_import_sources s LEFT JOIN crm_integration_credentials k ON k.workspace_id=s.workspace_id AND k.id=s.credential_id
        WHERE s.workspace_id=$1 AND s.id=$2 FOR SHARE OF s`,[context.workspaceId,id])).rows[0]
      if(!row?.keyed)throw unavailable()
      return {scope:crmKeyBindingScope(context.workspaceId,row.binding as never),sources:[]}
    }],
    ['crm_intake_idempotency',async id=>{
      const row=(await client.query<{submission:string|null;binding:unknown;keyed:boolean}>(`SELECT
          (SELECT q.id FROM association_enquiries q WHERE q.workspace_id=i.workspace_id AND q.id=i.submission_id) AS submission,
          k.department_binding AS binding,i.credential_id IS NOT NULL AS keyed
        FROM crm_intake_idempotency i LEFT JOIN crm_intake_credentials k ON k.workspace_id=i.workspace_id AND k.id=i.credential_id
        WHERE i.workspace_id=$1 AND i.id=$2 FOR SHARE OF i`,[context.workspaceId,id])).rows[0]
      if(!row)throw unavailable()
      if(row.submission)return assertAssociationOrderAuthority(client,context.workspaceId,row.submission,actor,'submission')
      if(!row.keyed)throw unavailable()
      return {scope:crmKeyBindingScope(context.workspaceId,row.binding as never),sources:[]}
    }],
    // Audit rows use the canonical audit visibility predicate (captured, legacy, erased and strict-mode rules).
    ...(['association_audit_log','workspace_audit_log'] as const).map(table=>[table,async (id:string)=>{
      // A key is evaluated as its issuer narrowed by the key's department binding and cap.
      const principal=actor.actingUserId ? {user:actor.actingUserId,binding:'',cap:''}
        : (await client.query<{user:string;binding:string;cap:string}>(`SELECT created_by_user_id::text AS user,
            coalesce(department_binding->'binding','[]'::jsonb)::text AS binding,coalesce(department_binding->>'cap','') AS cap
            FROM crm_integration_credentials WHERE workspace_id=$1 AND id=$2 AND department_binding IS NOT NULL`,
          [context.workspaceId,actor.integration?.credentialId ?? null])).rows[0]
      if(!principal?.user)throw unavailable()
      await client.query(`SELECT set_config('app.current_user_id',$1,true),set_config('app.v2_binding',$2,true),set_config('app.v2_cap',$3,true)`,
        [principal.user,principal.binding,principal.cap])
      const row=(await client.query<{visible:boolean}>(`SELECT audit_scope_visible(to_jsonb(t)) AS visible FROM ${table} t
        WHERE t.workspace_id=$1 AND t.id=$2`,[context.workspaceId,id])).rows[0]
      if(!row?.visible)throw unavailable()
      return null
    }] as [string,(id:string)=>Promise<{scope:ResourceScope;sources:ScopeSource[]}|null>]),
    ['campaign_email_recipients',async id=>{
      const row=(await client.query<{scope:ResourceScope|null;sources:ScopeSource[]|null;live:boolean}>(`SELECT r.scope_snapshot AS scope,r.scope_sources AS sources,
          EXISTS(SELECT 1 FROM entities e WHERE e.workspace_id=r.workspace_id AND e.id=r.contact_id) AS live
        FROM campaign_email_recipients r WHERE r.workspace_id=$1 AND r.id=$2 FOR SHARE OF r`,[context.workspaceId,id])).rows[0]
      if(!row)throw unavailable()
      if(row.scope)return {scope:row.scope,sources:row.sources ?? []}
      // A historical recipient is covered by its live contact's root check above; without one it refuses.
      if(!row.live)throw unavailable()
      return null
    }],
  ]
  for(const [table,authority] of families) {
    let after:string|null=null
    for(;;) {
      const page:{rows:Array<{id:string}>}=await client.query(`SELECT t.id::text AS id FROM ${table} t WHERE t.workspace_id=$1 AND ($2::text IS NULL OR t.id::text>$2::text) ORDER BY t.id::text LIMIT 256`,[context.workspaceId,after])
      for(const {id} of page.rows) {
        const evidence=await authority(id)
        if(!evidence)continue
        await assertAssociationSourceAuthority(client,context.workspaceId,actor,evidence)
        accumulate(evidence.scope,evidence.sources)
      }
      if(page.rows.length<256)break
      after=page.rows.at(-1)!.id
    }
  }
  return floor
}

/** The saved subject floor survives erasure; a live source may only restrict it further. */
export async function assertCrmPrivacySubjectAuthority(client:PoolClient,context:CrmOperationsContext,contactId:string,saved?:ResourceScope|null,consumed=false):Promise<ResourceScope|null> {
  const actor=crmPrivacySourceActor(context)
  if(saved===null) {
    const v2=(await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[context.workspaceId])).rows[0]?.department_read_v2
    if(v2!==false)throw new CrmOperationsError('not_authorized','The erasure review requires protected scope evidence.')
  }
  if(saved)await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope:saved,sources:[]})
  if(consumed)return saved ?? null
  const evidence=await loadAssociationOrderScope(client,context.workspaceId,[contactId])
  await assertAssociationSourceAuthority(client,context.workspaceId,actor,evidence)
  const sources=[...evidence.sources,{...evidence.scope,resourceKind:'privacy-subject-floor',resourceId:contactId,version:'current'}]
  if(saved)sources.push({...saved,resourceKind:'privacy-preview',resourceId:contactId,version:'saved'})
  let scope=deriveResourceScope({producer:'crm.erasure-preview',sources})
  // Use the same reviewed attribution predicates as counts and erasure; never a second roster.
  for(const [table,kind] of associationRecords) {
    const coverage=CRM_PRIVACY_COVERAGE.find(entry=>entry.domain===table)
    if(!coverage?.subjectWhere)throw new Error('Missing erasure attribution predicate')
    let after:string|null=null
    for(;;) {
      const page:{rows:Array<{id:string}>}=await client.query<{id:string}>(`WITH privacy_args AS (SELECT $1::uuid workspace_id,$2::uuid contact_id) SELECT t.id FROM ${table} t WHERE t.workspace_id=$1 AND (${coverage.subjectWhere}) AND ($3::uuid IS NULL OR t.id>$3::uuid) ORDER BY t.id LIMIT 256`,[context.workspaceId,contactId,after])
      for(const {id} of page.rows) {
        const linked=await assertAssociationOrderAuthority(client,context.workspaceId,id,actor,kind)
        if(linked)scope=deriveResourceScope({producer:'crm.erasure-preview',sources:[
          {...scope,resourceKind:'privacy-review-floor',resourceId:contactId,version:'accumulated'},
          ...linked.sources,{...linked.scope,resourceKind:table,resourceId:id,version:'saved'},
        ]})
      }
      if(page.rows.length<256)break
      after=page.rows.at(-1)!.id
    }
  }
  const v2=(await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[context.workspaceId])).rows[0]?.department_read_v2
  if(v2!==false) {
    for(const table of ['crm_activities','crm_domain_event_outbox']) {
      const coverage=CRM_PRIVACY_COVERAGE.find(entry=>entry.domain===table)!
      let after:string|null=null
      for(;;) {
        const page:{rows:Array<{id:string}>}=await client.query(`WITH privacy_args AS (SELECT $1::uuid workspace_id,$2::uuid contact_id) SELECT t.id FROM ${table} t WHERE t.workspace_id=$1 AND (${coverage.subjectWhere}) AND ($3::uuid IS NULL OR t.id>$3::uuid) ORDER BY t.id LIMIT 256`,[context.workspaceId,contactId,after])
        for(const {id} of page.rows) {
          const activity=await (table==='crm_activities'?activityAuthority:assertCrmEventPrivacyAuthority)(client,context,id)
          scope=deriveResourceScope({producer:'crm.erasure-preview',sources:[
            {...scope,resourceKind:'privacy-review-floor',resourceId:contactId,version:'accumulated'},
            ...activity.sources,{...activity.scope,resourceKind:table,resourceId:id,version:'saved'},
          ]})
        }
        if(page.rows.length<256)break
        after=page.rows.at(-1)!.id
      }
    }
  }
  if(v2!==false)for await(const linked of copyAuthorities(client,context,contactId)) {
    scope=deriveResourceScope({producer:'crm.erasure-preview',sources:[
      {...scope,resourceKind:'privacy-review-floor',resourceId:contactId,version:'accumulated'},
      ...linked.sources,{...linked.scope,resourceKind:'workflow-source-floor',resourceId:contactId,version:'saved'},
    ]})
  }
  if(v2!==false)for await(const linked of promotionUsageAuthorities(client,context,contactId))scope=deriveResourceScope({producer:'crm.promotion-privacy',sources:[
    {...scope,resourceKind:'privacy-review-floor',resourceId:contactId,version:'accumulated'},
    ...linked.sources,{...linked.scope,resourceKind:'promotion-usage-floor',resourceId:contactId,version:'saved'},
  ]})
  if(v2!==false)for await(const linked of deliveryAuthorities(client,context,contactId))scope=deriveResourceScope({producer:'crm.delivery-privacy',sources:[
    {...scope,resourceKind:'privacy-review-floor',resourceId:contactId,version:'accumulated'},
    ...linked.sources,{...linked.scope,resourceKind:'delivery-floor',resourceId:contactId,version:'saved'}]})
  if(saved&&resourceScopeKey(scope)!==resourceScopeKey(saved))throw conflict('privacy_preview_stale')
  await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope,sources:[]})
  return scope
}


async function* deliveryAuthorities(client:PoolClient,context:CrmOperationsContext,contactId:string|null) {
  const coverage=CRM_PRIVACY_COVERAGE.find(entry=>entry.domain==='crm_delivery_receipts')!
  const actor=crmPrivacySourceActor(context)
  let after:string|null=null
  for(;;) {
    const page:{rows:Array<{id:string}>}=await client.query(`SELECT t.delivery_id AS id FROM crm_delivery_receipts t
      WHERE t.workspace_id=$1 AND ($2::uuid IS NULL OR (${coverage.subjectWhere}))
        AND ($3::uuid IS NULL OR t.delivery_id>$3) ORDER BY t.delivery_id LIMIT 256`,[context.workspaceId,contactId,after])
    for(const {id} of page.rows) {
      const evidence=await assertCrmDeliveryScope(client,context.workspaceId,id,actor)
      if(evidence)yield evidence
    }
    if(page.rows.length<256)break
    after=page.rows.at(-1)!.id
  }
}

async function* promotionUsageAuthorities(client:PoolClient,context:CrmOperationsContext,contactId:string|null) {
  const actor=crmPrivacySourceActor(context)
  let after:string|null=null
  for(;;) {
    const page:{rows:Array<{id:string}>}=await client.query(`SELECT p.id FROM association_promotions p
      WHERE p.workspace_id=$1 AND p.source_redeemed_uses>0 AND ($2::uuid IS NULL OR EXISTS(
        SELECT 1 FROM association_promotion_source_contact_uses u WHERE u.workspace_id=p.workspace_id AND u.promotion_id=p.id AND u.contact_id=$2))
        AND ($3::uuid IS NULL OR p.id>$3) ORDER BY p.id LIMIT 256`,[context.workspaceId,contactId,after])
    for(const {id} of page.rows) {
      const evidence=await assertAssociationOrderAuthority(client,context.workspaceId,id,actor,'promotion_usage')
      if(evidence)yield evidence
    }
    if(page.rows.length<256)break
    after=page.rows.at(-1)!.id
  }
}
