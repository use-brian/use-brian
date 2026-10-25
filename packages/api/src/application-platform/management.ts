import {applicationLegacyViewInput,applicationLegacyApplyInput,executeApplicationLegacyReview,type ApplicationLegacyCommand} from './legacy-review.js'
/** Native app preparation and recovery; registration confers no data rights. [COMP:api/application-auth] */
import type { Pool, PoolClient } from 'pg'
import type { ApplicationManagementOverview } from '@use-brian/shared'
import { projectionLifetime } from '../workspace-access/projection-lifetime.js'
import { createDbDocEntityStore } from '../db/doc-entity-store.js'
import { randomUUID } from 'node:crypto'
import { ApplicationPlatformError, applicationClientInputSchema, applicationCredentialInputSchema, applicationGrantInputSchema, type ApplicationGrantInput } from '@use-brian/shared'
import { z } from 'zod'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from '../db/client.js'
import { createDbOAuthClientStore } from '../db/oauth-client-store.js'
import { findAssistantById, findOrCreateUser } from '../db/users.js'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { resolveLiveAccessCeilingSystem } from '../context-scope/resolve-turn-scope.js'
import type { ApplicationPlatformService } from './service.js'
import { mintApplicationCredentialSecret } from './credentials.js'
import { resolveExecutionContextSystem } from '../context-scope/execution-context.js'
import { previewApplicationSchema,applyApplicationSchema,applicationSchemaPreviewInput } from './schema-changes.js'
import { readApplicationGovernanceCatalog,previewApplicationGovernance,applyApplicationGovernance,applicationGovernanceCatalogInput,applicationGovernanceModuleInput,applicationGovernancePreviewInput,applicationGovernanceApplyInput } from './governance.js'
import { buildNativeApplicationSchemaMcpTools,buildNativeApplicationGovernanceMcpTools,buildNativeApplicationManagementMcpTools } from './mcp.js'

const clientColumns = `id,workspace_id AS "workspaceId",module_key AS "moduleKey",name,client_mode AS mode,
  origins,redirect_uris AS "redirectUris",home_app_id AS "homeAppId",oauth_client_id AS "oauthClientId",executing_assistant_id AS "executingAssistantId",
  status,grant_revision::text AS revision,created_at AS "createdAt"`
const schemaAssistantInput = z.object({ assistantId: z.string().uuid().optional() }).strict()
const schemaPreviewBody = applicationSchemaPreviewInput.omit({ typeId: true }).extend(schemaAssistantInput.shape).strict()

/** One command vocabulary for the native human and Brian management adapters. */
export const applicationManagementCommandSchema = z.discriminatedUnion('kind', [
 z.object({kind:z.literal('legacy.view'),...applicationLegacyViewInput.shape,assistantId:z.string().uuid().optional()}).strict(),
 z.object({kind:z.literal('legacy.apply'),...applicationLegacyApplyInput.shape,assistantId:z.string().uuid().optional()}).strict(),
 z.object({kind:z.literal('legacy.cancel'),...applicationLegacyApplyInput.shape,assistantId:z.string().uuid().optional()}).strict(),
 z.object({kind:z.literal('register'),input:applicationClientInputSchema.innerType().omit({workspaceId:true})}).strict(),
 z.object({kind:z.literal('activation.review'),appId:z.string().uuid(),profile:z.literal('canonical_app_delegation_v1').optional()}).strict(),
 z.object({kind:z.literal('activation.apply'),appId:z.string().uuid(),reviewId:z.string().uuid()}).strict(),
 z.object({kind:z.literal('activation.revoke'),appId:z.string().uuid()}).strict(),
 z.object({kind:z.literal('status'),appId:z.string().uuid(),status:z.enum(['active','suspended','revoked'])}).strict(),
 z.object({kind:z.literal('grant.review'),appId:z.string().uuid(),input:applicationGrantInputSchema}).strict(),
 z.object({kind:z.literal('grant.apply'),appId:z.string().uuid(),reviewId:z.string().uuid()}).strict(),
 z.object({kind:z.literal('grant.revoke'),appId:z.string().uuid(),grantId:z.string().uuid()}).strict(),
 z.object({kind:z.literal('service.prepare'),appId:z.string().uuid(),input:z.object({name:z.string().min(1).max(128),idempotencyKey:z.string().uuid()}).strict()}).strict(),
 z.object({kind:z.literal('credential.review'),appId:z.string().uuid(),input:applicationCredentialInputSchema}).strict(),
 z.object({kind:z.literal('credential.deliver'),appId:z.string().uuid(),reviewId:z.string().uuid()}).strict(),
 z.object({kind:z.literal('credential.revoke'),appId:z.string().uuid(),credentialId:z.string().uuid()}).strict(),
 z.object({kind:z.literal('schema.preview'),schemaId:z.string().uuid(),input:schemaPreviewBody}).strict(),
 z.object({kind:z.literal('schema.apply'),reviewId:z.string().uuid(),input:schemaAssistantInput}).strict(),
 z.object({kind:z.literal('governance.catalog'),input:applicationGovernanceCatalogInput.extend(schemaAssistantInput.shape).strict()}).strict(),
 z.object({kind:z.literal('governance.preview'),input:applicationGovernancePreviewInput.extend(schemaAssistantInput.shape).strict()}).strict(),
 z.object({kind:z.literal('governance.apply'),reviewId:z.string().uuid(),input:schemaAssistantInput}).strict(),
])

export class ApplicationManagementService {
  /** Bounded metadata only. All record/field policy remains in the existing canonical readers. */
  async overview(actorId:string,workspaceId:string,rawSelection:unknown = {}):Promise<ApplicationManagementOverview> {
    const selection=z.object({appId:z.string().uuid().optional(),moduleKey:z.string().min(1).max(128).optional(),assistantId:z.string().uuid().optional()}).strict().safeParse(rawSelection)
    if(!selection.success)throw new ApplicationPlatformError('invalid_value','The management selection is invalid.')
    const execution=await this.nativeSchemaExecution(actorId,workspaceId,selection.data.assistantId)
    const clients=await this.list(actorId,workspaceId)
    const appId=selection.data.appId ?? clients[0]?.id ?? null
    if(appId&&!clients.some(app=>app.id===appId))throw new ApplicationPlatformError('access_unavailable','The application is unavailable.')
    const metadata=await this.transaction(actorId,workspaceId,async client=>{
      const validity=await projectionLifetime(client,workspaceId,actorId)
      const sources=(await client.query<{id:string;connectorInstanceId:string;status:string;revision:string}>(`SELECT id,original_connector_instance_id AS "connectorInstanceId",status,revision::text
        FROM connector_source_profiles WHERE workspace_id=$1 ORDER BY id LIMIT 100`,[workspaceId])).rows
      return {validForMs:validity,sources}
    })
    const grants=appId?await this.listGrants(actorId,workspaceId,appId):[]
    const credentials=appId?await this.listCredentials(actorId,workspaceId,appId):[]
    let schemas:ApplicationManagementOverview['schemas']={state:'unavailable',items:[]}
    try {
      const items=await this.transaction(actorId,workspaceId,client=>runWithAgentAccess(execution.security.access,async()=>{
        await applyRLSGucs(client,actorId)
        await client.query("SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)",[execution.assistant.id])
        return createDbDocEntityStore({actorUserId:actorId,transaction:client}).listEntityTypes(workspaceId)
      }))
      schemas={state:'available',items:items.map(({id,name,schemaVersion,properties})=>({id,name,schemaVersion,properties}))}
    } catch(error) { if(!(error instanceof ApplicationPlatformError)||error.code!=='access_unavailable')throw error }
    const modules=[...this.applications.registry.applications.keys()].sort()
    const moduleKey=selection.data.moduleKey ?? clients.find(app=>app.id===appId)?.moduleKey ?? modules[0] ?? null
    if(moduleKey&&!modules.includes(moduleKey))throw new ApplicationPlatformError('invalid_value','The management module is invalid.')
    let governance:NonNullable<ApplicationManagementOverview['governance']>={state:'unavailable',moduleKey,catalog:null}
    if(moduleKey)try {
      governance={state:'available',moduleKey,catalog:await readApplicationGovernanceCatalog(this.pool,execution,{moduleKey})}
    } catch(error) { if(!(error instanceof ApplicationPlatformError)||error.code!=='access_unavailable')throw error }
    await execution.security.authority.assertCurrent()
    // Revalidate native administration after all independently awaited readers.
    await this.transaction(actorId,workspaceId,async()=>undefined)
    const base=`/w/${encodeURIComponent(workspaceId)}`
    return {workspaceId,actor:{userId:actorId,assistantId:execution.assistant.id},validForMs:metadata.validForMs,
      readiness:{qualified:false,reason:'consumer_qualification_incomplete',canActivate:false},
      modules,governance,clients,selectedAppId:appId,grants,credentials,schemas,
      sources:{state:metadata.sources.length?'available':'unavailable',items:metadata.sources.map(source=>({...source,mappingStatus:'unavailable',keyStatus:'deployment_managed',retentionStatus:'unavailable'}))},
      links:{miniApps:`${base}/studio/mini-apps`,connectors:`${base}/studio/connectors`,programmaticAccess:`${base}/studio/programmatic-access`,access:`${base}/organization?section=access`}}
  }

  async executeCommand(actorId:string,workspaceId:string,raw:unknown,delivery:{audience:'human'|'brian';assistantId?:string}={audience:'human'}):Promise<unknown> {
    const parsed=applicationManagementCommandSchema.safeParse(raw)
    if(!parsed.success)throw new ApplicationPlatformError('invalid_value','The management command is invalid.')
    const command=parsed.data
    const assistant=delivery.assistantId?{assistantId:delivery.assistantId}:{}
    switch(command.kind) {
      case 'legacy.view':case 'legacy.apply':case 'legacy.cancel':return this.legacyReview(actorId,workspaceId,command,delivery.assistantId??command.assistantId)
      case 'register':return this.create(actorId,{...command.input,workspaceId})
      case 'activation.review':return this.transaction(actorId,workspaceId,async client=>{
        if(!(await client.query('SELECT id FROM application_clients WHERE id=$1 AND workspace_id=$2',[command.appId,workspaceId])).rows[0])throw new ApplicationPlatformError('access_unavailable','The application is unavailable.')
        const deployed=(await client.query('SELECT module_key AS module FROM application_clients WHERE id=$1 AND workspace_id=$2',[command.appId,workspaceId])).rows[0]
        await this.applications.assertDeployedModuleCurrent(client,deployed.module)
        const review=(await (command.profile?client.query('SELECT application_prepare_activation($1,$2) AS id',[command.appId,command.profile]):client.query('SELECT application_prepare_activation($1) AS id',[command.appId]))).rows[0]
        const snapshot=(await client.query("SELECT snapshot->>'profile' AS profile,snapshot#>>'{application,module_key}' AS module,snapshot#>>'{application,client_mode}' AS mode FROM application_activation_reviews WHERE id=$1",[review.id])).rows[0]
        return {id:review.id,profile:snapshot.profile,canApply:true,scope:{principal:snapshot.profile==='canonical_app_delegation_v1'?(snapshot.module==='records'?'service_and_member_or_external_user':'service_and_member'):snapshot.mode==='external_frontend'?(snapshot.module==='records'?'member_or_external_user':'member'):'service',client:snapshot.mode,module:snapshot.module,resources:snapshot.module==='native'?['company','deal']:this.applications.registry.applications.get(snapshot.module)?.application.resources.some(resource=>resource.origin.kind==='native')?[...new Set(this.applications.registry.applications.get(snapshot.module)!.application.resources.map(resource=>resource.origin.kind))]:['generic']}}
      },true)
      case 'activation.apply':return this.transaction(actorId,workspaceId,async client=>{
        if(!(await client.query('SELECT id FROM application_activation_reviews WHERE id=$1 AND app_id=$2 AND workspace_id=$3',[command.reviewId,command.appId,workspaceId])).rows[0])throw new ApplicationPlatformError('access_unavailable','The review is unavailable.')
        const applied=(await client.query('SELECT application_apply_activation($1) AS id',[command.reviewId])).rows[0].id
        const review=(await client.query("SELECT snapshot->>'profile' AS profile FROM application_activation_reviews WHERE id=$1",[command.reviewId])).rows[0]
        return {appId:applied,profile:review.profile}
      },true)
      case 'activation.revoke':return this.transaction(actorId,workspaceId,async client=>{
        if(!(await client.query('SELECT id FROM application_clients WHERE id=$1 AND workspace_id=$2',[command.appId,workspaceId])).rows[0])throw new ApplicationPlatformError('access_unavailable','The application is unavailable.')
        return {revoked:(await client.query('SELECT application_revoke_activation($1) AS revoked',[command.appId])).rows[0].revoked}
      },true)
      case 'status':return this.setStatus(actorId,workspaceId,command.appId,command.status)
      case 'grant.review':return this.reviewGrant(actorId,workspaceId,command.appId,command.input)
      case 'grant.apply':return this.applyGrantReview(actorId,workspaceId,command.appId,command.reviewId)
      case 'grant.revoke':return this.revokeGrant(actorId,workspaceId,command.appId,command.grantId)
      case 'service.prepare':return this.prepareServiceSubject(actorId,workspaceId,command.appId,command.input)
      case 'credential.review':return this.reviewCredential(actorId,workspaceId,command.appId,command.input)
      case 'credential.deliver':{
        if(delivery.audience==='human')return this.applyCredentialReview(actorId,workspaceId,command.appId,command.reviewId)
        await this.listCredentials(actorId,workspaceId,command.appId)
        return {nativeDeliveryRequired:true,reviewId:command.reviewId,link:`/w/${encodeURIComponent(workspaceId)}/studio/programmatic-access?application=${encodeURIComponent(command.appId)}&credentialReview=${encodeURIComponent(command.reviewId)}`}
      }
      case 'credential.revoke':return this.revokeCredential(actorId,workspaceId,command.appId,command.credentialId)
      case 'schema.preview':return this.previewSchema(actorId,workspaceId,command.schemaId,{...command.input,...assistant})
      case 'schema.apply':return this.applySchema(actorId,workspaceId,command.reviewId,{...command.input,...assistant})
      case 'governance.catalog':return this.governanceCatalog(actorId,workspaceId,{...command.input,...assistant})
      case 'governance.preview':return this.previewGovernance(actorId,workspaceId,{...command.input,...assistant})
      case 'governance.apply':return this.applyGovernance(actorId,workspaceId,command.reviewId,{...command.input,...assistant})
    }
  }
  private async legacyReview(actorId:string,workspaceId:string,command:ApplicationLegacyCommand,assistantId?:string) {
    const execution=await this.nativeSchemaExecution(actorId,workspaceId,assistantId)
    await execution.security.authority.assertCurrent()
    const effectful=command.kind!=='legacy.view'
    const result=await this.transaction(actorId,workspaceId,client=>executeApplicationLegacyReview(client,execution,command),effectful)
    try {await execution.security.authority.assertCurrent()}
    catch {throw new ApplicationPlatformError('grant_revoked','The reviewed authority changed. Check the saved review before retrying.',effectful?'committed':'none')}
    return result
  }
  async managementMcpTools(actorId:string,workspaceId:string,rawSelection:unknown={}) {
    const selection=schemaAssistantInput.safeParse(rawSelection)
    if(!selection.success)throw new ApplicationPlatformError('invalid_value','The management assistant selection is invalid.')
    return buildNativeApplicationManagementMcpTools(this,await this.nativeSchemaExecution(actorId,workspaceId,selection.data.assistantId))
  }

  constructor(private readonly applications: ApplicationPlatformService, private readonly pool: Pool = getAppPool()) {}

  private async transaction<T>(actorId: string, workspaceId: string, operation: (client: PoolClient) => Promise<T>, effectful = false): Promise<T> {
    const client = await this.pool.connect()
    let committing = false
    try {
      await client.query('BEGIN')
      const role = await client.query(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
        FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='application_clients'::regclass WHERE r.rolname=current_user`)
      if (role.rows[0]?.bypass !== false) throw new ApplicationPlatformError('access_unavailable', 'A non-owner application role is required.')
      await applyRLSGucs(client, actorId)
      const membership = await client.query("SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN('owner','admin') FOR SHARE", [workspaceId, actorId])
      if (!membership.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'Application management is unavailable.')
      const result = await operation(client)
      committing = true
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (committing && effectful) throw new ApplicationPlatformError('outcome_uncertain', 'Check the application state before retrying.', 'uncertain')
      if ((error as { code?: string }).code === '42501') throw new ApplicationPlatformError('access_unavailable', 'Application management is unavailable.')
      if ((error as { code?: string }).code === '40001') throw new ApplicationPlatformError('record_version_conflict', 'The reviewed authority changed. Review it again.')
      if (['22023','23514','22P02'].includes((error as { code?: string }).code ?? '')) throw new ApplicationPlatformError('invalid_value', 'The requested authority is invalid.')
      throw error
    } finally { await rollbackAndRelease(client) }
  }

  private async nativeSchemaExecution(actorId: string,workspaceId: string,assistantId?: string,signal?: AbortSignal) {
    const selected = await this.transaction(actorId,workspaceId,async client => {
      const result=await client.query<{ id: string }>(`SELECT id FROM assistants WHERE workspace_id=$1
        AND ($2::uuid IS NULL AND kind='primary' OR id=$2) AND assistant_placement_visible($3,id) ORDER BY id LIMIT 1`,
        [workspaceId,assistantId ?? null,actorId])
      if (!result.rows[0]) throw new ApplicationPlatformError('access_unavailable','The management assistant is unavailable.')
      return result.rows[0].id
    })
    const assistant=await findAssistantById(selected)
    if (!assistant || assistant.workspaceId!==workspaceId) throw new ApplicationPlatformError('access_unavailable','The management assistant is unavailable.')
    return (await resolveExecutionContextSystem({ userId: actorId,workspaceId,assistant,memberMode: 'member',
      identity: { kind: 'attended',principal: { kind: 'workspace_member',userId: actorId,authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace',workspaceId },lifecycle: { sessionId: randomUUID(),sessionPersisted: false,
        channelId: 'native-application-management',channelType: 'web',abortSignal: signal ?? new AbortController().signal } })).executionContext
  }

  /** Native-session adapters only. Brian callers retain their original ExecutionContext in the MCP builder. */
  async previewSchema(actorId: string,workspaceId: string,typeId: string,rawInput: unknown,signal?: AbortSignal) {
    const input=schemaPreviewBody.safeParse(rawInput)
    if (!input.success || !z.string().uuid().safeParse(typeId).success) throw new ApplicationPlatformError('invalid_value','The schema proposal is invalid.')
    const execution=await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal)
    const preview=await previewApplicationSchema(this.pool,execution,typeId,input.data.expectedVersion,input.data.properties)
    await execution.security.authority.assertCurrent()
    return preview
  }

  async applySchema(actorId: string,workspaceId: string,previewId: string,rawInput: unknown,signal?: AbortSignal) {
    const input=schemaAssistantInput.safeParse(rawInput)
    if (!input.success || !z.string().uuid().safeParse(previewId).success) throw new ApplicationPlatformError('invalid_value','The schema review is invalid.')
    return applyApplicationSchema(this.pool,await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal),previewId)
  }

  async schemaMcpTools(actorId: string,workspaceId: string,rawSelection: unknown,signal?: AbortSignal) {
    const selection=schemaAssistantInput.safeParse(rawSelection)
    if (!selection.success) throw new ApplicationPlatformError('invalid_value','The management assistant selection is invalid.')
    return buildNativeApplicationSchemaMcpTools(this.pool,await this.nativeSchemaExecution(actorId,workspaceId,selection.data.assistantId,signal))
  }

  async governanceCatalog(actorId:string,workspaceId:string,rawSelection:unknown,signal?:AbortSignal) {
    const input=applicationGovernanceCatalogInput.extend(schemaAssistantInput.shape).strict().safeParse(rawSelection)
    if (!input.success) throw new ApplicationPlatformError('invalid_value','The native governance selection is invalid.')
    const execution=await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal)
    const result=await readApplicationGovernanceCatalog(this.pool,execution,{moduleKey:input.data.moduleKey,afterId:input.data.afterId})
    await execution.security.authority.assertCurrent();return result
  }
  async previewGovernance(actorId:string,workspaceId:string,rawInput:unknown,signal?:AbortSignal) {
    const input=applicationGovernancePreviewInput.extend(schemaAssistantInput.shape).strict().safeParse(rawInput)
    if (!input.success) throw new ApplicationPlatformError('invalid_value','The native governance proposal is invalid.')
    const execution=await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal)
    const {assistantId:_assistant,...proposal}=input.data
    const result=await previewApplicationGovernance(this.pool,execution,proposal)
    await execution.security.authority.assertCurrent();return result
  }
  async applyGovernance(actorId:string,workspaceId:string,reviewId:string,rawInput:unknown,signal?:AbortSignal) {
    const input=schemaAssistantInput.safeParse(rawInput)
    if (!input.success || !applicationGovernanceApplyInput.safeParse({reviewId}).success) throw new ApplicationPlatformError('invalid_value','The native governance review is invalid.')
    return applyApplicationGovernance(this.pool,await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal),{reviewId})
  }
  async governanceMcpTools(actorId:string,workspaceId:string,rawSelection:unknown,signal?:AbortSignal) {
    const input=applicationGovernanceModuleInput.extend(schemaAssistantInput.shape).strict().safeParse(rawSelection)
    if (!input.success) throw new ApplicationPlatformError('invalid_value','The native governance selection is invalid.')
    return buildNativeApplicationGovernanceMcpTools(this.pool,await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal),input.data.moduleKey)
  }

  list(actorId: string, workspaceId: string) {
    return this.transaction(actorId, workspaceId, async client => (await client.query(`SELECT ${clientColumns},
      (application_runtime_qualified(workspace_id,'application_data') OR application_scoped_qualified(workspace_id,id)) AS qualified FROM application_clients WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId])).rows)
  }

  async create(actorId: string, rawInput: unknown) {
    const parsed = applicationClientInputSchema.safeParse(rawInput)
    if (!parsed.success) throw new ApplicationPlatformError('invalid_value', 'The application registration is invalid.')
    const input = parsed.data
    if (!this.applications.registry.applications.has(input.moduleKey)) throw new ApplicationPlatformError('operation_not_available', 'The deployed module is unavailable.')
    // Check native governance before even creating public OAuth client metadata.
    const assistantId = await this.transaction(actorId, input.workspaceId, async client => {
      const result = await client.query<{ id: string }>(`SELECT id FROM assistants WHERE workspace_id=$1
        AND ($2::uuid IS NULL AND kind='primary' OR id=$2) AND assistant_placement_visible($3,id) ORDER BY id LIMIT 1`,
      [input.workspaceId, input.executingAssistantId ?? null, actorId])
      if (!result.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'The application assistant is unavailable.')
      return result.rows[0].id
    })
    const oauth = input.mode === 'external_frontend' ? await createDbOAuthClientStore().register({ clientName: input.name,
      clientUri: input.origins[0], redirectUris: input.redirectUris, tokenEndpointAuthMethod: 'none' }) : null
    return this.transaction(actorId, input.workspaceId, async client => {
      // Recheck the binding after registration's await. Public OAuth registry
      // metadata alone has no app/resource rights if this transaction refuses.
      if (!(await client.query('SELECT id FROM assistants WHERE id=$1 AND workspace_id=$2 AND assistant_placement_visible($3,id) FOR SHARE',
        [assistantId, input.workspaceId, actorId])).rows[0]) throw new ApplicationPlatformError('access_unavailable', 'The application assistant is unavailable.')
      const result = await client.query(`INSERT INTO application_clients(workspace_id,module_key,name,client_mode,origins,redirect_uris,
        home_app_id,oauth_client_id,executing_assistant_id,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${clientColumns}`,
      [input.workspaceId, input.moduleKey, input.name, input.mode, input.origins, input.redirectUris, input.homeAppId ?? null, oauth?.clientId ?? null, assistantId, actorId])
      return result.rows[0]
    }, true)
  }

  setStatus(actorId: string, workspaceId: string, appId: string, status: 'active' | 'suspended' | 'revoked') {
    return this.transaction(actorId, workspaceId, async client => {
      const current=await client.query<{status:string;qualified:boolean}>(`SELECT status,(application_runtime_qualified(workspace_id,'application_data') OR application_scoped_qualified(workspace_id,id)) AS qualified FROM application_clients WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,[appId,workspaceId])
      if(!current.rows[0]) throw new ApplicationPlatformError('access_unavailable','The application is unavailable.')
      if(status==='active'&&current.rows[0].status!=='active'&&!current.rows[0].qualified) throw new ApplicationPlatformError('operation_not_available','Application runtime qualification is incomplete.')
      const result = await client.query(`UPDATE application_clients SET status=$3 WHERE id=$1 AND workspace_id=$2
        AND (status<>'revoked' OR $3='revoked') RETURNING ${clientColumns}`, [appId, workspaceId, status])
      if (!result.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'The application is unavailable.')
      await client.query(`INSERT INTO application_authority_events(workspace_id,app_id,actor_user_id,action,resource_id)
        VALUES($1,$2,$3,'client_status_changed',$2)`, [workspaceId,appId,actorId])
      return result.rows[0]
    }, true)
  }

  listGrants(actorId: string, workspaceId: string, appId: string) {
    return this.transaction(actorId, workspaceId, async client => {
      if(!(await client.query('SELECT id FROM application_clients WHERE workspace_id=$1 AND id=$2',[workspaceId,appId])).rows[0]) throw new ApplicationPlatformError('access_unavailable','The application is unavailable.')
      return (await client.query(`SELECT id,principal_kind AS "principalKind",principal_user_id AS "principalUserId",
      resource_origin AS origin,resource_type AS "typeKey",actions,read_fields AS "readFields",write_fields AS "writeFields",selector,
      status,version::text AS version,starts_at AS "startsAt",expires_at AS "expiresAt",parent_grant_id AS "parentGrantId",compartments,project_ids AS "projectIds",clearance FROM application_access_grants WHERE workspace_id=$1 AND app_id=$2 ORDER BY id`, [workspaceId, appId])).rows
    })
  }

  private async withReleaseAuthority<T>(client: PoolClient, actorId: string, workspaceId: string, appId: string, operation: () => Promise<T>) {
    const result = await client.query<{ assistantId: string; moduleKey: string }>(`SELECT executing_assistant_id AS "assistantId",module_key AS "moduleKey"
      FROM application_clients WHERE id=$1 AND workspace_id=$2 AND status='active' FOR SHARE`, [appId, workspaceId])
    if(result.rows[0])await this.applications.assertDeployedModuleCurrent(client,result.rows[0].moduleKey)
    const assistant = result.rows[0]?.assistantId && await findAssistantById(result.rows[0].assistantId)
    if (!assistant || assistant.workspaceId !== workspaceId) throw new ApplicationPlatformError('access_unavailable', 'The application is unavailable.')
    const access = await resolveLiveAccessCeilingSystem({ userId: actorId, workspaceId, assistant, memberMode: 'member' })
    return runWithAgentAccess(access, async () => {
      await applyRLSGucs(client, actorId)
      await client.query("SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)", [assistant.id])
      return operation()
    })
  }

  async reviewGrant(actorId: string, workspaceId: string, appId: string, rawInput: unknown) {
    const parsed = applicationGrantInputSchema.safeParse(rawInput)
    if (!parsed.success) throw new ApplicationPlatformError('invalid_value', 'The grant proposal is invalid.')
    const proposal: ApplicationGrantInput = { ...parsed.data, expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt).toISOString() : null }
    return this.transaction(actorId, workspaceId, client => this.withReleaseAuthority(client, actorId, workspaceId, appId, async () => {
      const app = (await client.query<{ moduleKey: string }>('SELECT module_key AS "moduleKey" FROM application_clients WHERE id=$1 AND workspace_id=$2', [appId,workspaceId])).rows[0]
      const module = app && this.applications.registry.applications.get(app.moduleKey)
      if (!module || proposal.actions.some(action => action.startsWith('command:') && !module.commands[action.slice(8)])) {
        throw new ApplicationPlatformError('operation_not_available', 'The requested operation is unavailable.')
      }
      const result = await client.query<{ id: string }>('SELECT application_prepare_grant_review($1,$2) AS id', [appId, proposal])
      const review = (await client.query(`SELECT id,proposed_grant AS proposal,expires_at AS "expiresAt",
        (application_runtime_qualified(workspace_id,'application_data') OR application_scoped_grant_allowed(app_id,proposed_grant)) AS "canIssue" FROM application_grant_reviews WHERE id=$1`, [result.rows[0].id])).rows[0]
      return review
    }), true)
  }

  applyGrantReview(actorId: string, workspaceId: string, appId: string, reviewId: string) {
    return this.transaction(actorId, workspaceId, client => this.withReleaseAuthority(client, actorId, workspaceId, appId, async () => {
      const review = await client.query('SELECT id FROM application_grant_reviews WHERE id=$1 AND app_id=$2 AND workspace_id=$3', [reviewId,appId,workspaceId])
      if (!review.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'The review is unavailable.')
      const result = await client.query<{ id: string }>('SELECT application_apply_grant_review($1) AS id', [reviewId])
      return { grantId: result.rows[0].id }
    }), true)
  }

  listCredentials(actorId: string, workspaceId: string, appId: string) {
    return this.transaction(actorId, workspaceId, async client => {
      if(!(await client.query('SELECT id FROM application_clients WHERE workspace_id=$1 AND id=$2',[workspaceId,appId])).rows[0]) throw new ApplicationPlatformError('access_unavailable','The application is unavailable.')
      return (await client.query(`SELECT id,name,credential_kind AS kind,subject_user_id AS "serviceUserId",
      status,expires_at AS "expiresAt",last_used_at AS "lastUsedAt",version::text AS version FROM application_api_credentials
      WHERE workspace_id=$1 AND app_id=$2 ORDER BY created_at,id`, [workspaceId, appId])).rows
    })
  }

  async prepareServiceSubject(actorId: string, workspaceId: string, appId: string, rawInput: unknown) {
    const input = z.object({ name: z.string().min(1).max(128), idempotencyKey: z.string().uuid() }).strict().safeParse(rawInput)
    if (!input.success) throw new ApplicationPlatformError('invalid_value', 'The service identity is invalid.')
    await this.transaction(actorId, workspaceId, async client => {
      if (!(await client.query("SELECT id FROM application_clients WHERE id=$1 AND workspace_id=$2 AND status='active' AND client_mode<>'home_app'", [appId,workspaceId])).rows[0]) {
        throw new ApplicationPlatformError('access_unavailable', 'The application is unavailable.')
      }
    })
    const { user } = await findOrCreateUser({ authProvider: 'channel', authProviderId: `app-service:${appId}:${input.data.idempotencyKey}`,
      name: input.data.name, onboarding: 'application' })
    return this.transaction(actorId, workspaceId, async client => {
      if (!(await client.query("SELECT id FROM application_clients WHERE id=$1 AND workspace_id=$2 AND status='active'", [appId,workspaceId])).rows[0]) {
        throw new ApplicationPlatformError('access_unavailable', 'The application is unavailable.')
      }
      return { serviceUserId: user.id, name: user.name }
    })
  }

  async reviewCredential(actorId: string, workspaceId: string, appId: string, rawInput: unknown) {
    const parsed = applicationCredentialInputSchema.safeParse(rawInput)
    if (!parsed.success) throw new ApplicationPlatformError('invalid_value', 'The credential proposal is invalid.')
    const proposal = { ...parsed.data, expiresAt: new Date(parsed.data.expiresAt).toISOString() }
    return this.transaction(actorId, workspaceId, client => this.withReleaseAuthority(client, actorId, workspaceId, appId, async () => {
      const result = await client.query<{ id: string }>('SELECT application_prepare_credential_review($1,$2) AS id', [appId,proposal])
      return (await client.query(`SELECT id,proposal,expires_at AS "expiresAt",(application_runtime_qualified(workspace_id,'application_data') OR application_scoped_credential_allowed(app_id,proposal)) AS "canIssue"
        FROM application_credential_reviews WHERE id=$1`, [result.rows[0].id])).rows[0]
    }), true)
  }

  /** Native human delivery only. Brian tools return the review/management link. */
  applyCredentialReview(actorId: string, workspaceId: string, appId: string, reviewId: string) {
    return this.transaction(actorId, workspaceId, client => this.withReleaseAuthority(client, actorId, workspaceId, appId, async () => {
      const result = await client.query<{ consumed: string | null; qualified: boolean }>(`SELECT consumed_credential_id AS consumed,
        (application_runtime_qualified(workspace_id,'application_data') OR application_scoped_credential_allowed(app_id,proposal)) AS qualified FROM application_credential_reviews
        WHERE id=$1 AND app_id=$2 AND workspace_id=$3`, [reviewId,appId,workspaceId])
      if (!result.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'The review is unavailable.')
      const material = !result.rows[0].consumed && result.rows[0].qualified ? await mintApplicationCredentialSecret() : null
      const applied = (await client.query<{ receipt: { id: string; created: boolean } }>(
        'SELECT application_apply_credential_review($1,$2,$3) AS receipt', [reviewId,material?.id ?? null,material?.secretHash ?? null])).rows[0].receipt
      return applied.created && material && applied.id === material.id
        ? { credentialId: applied.id, secretAvailable: true, secret: material.token }
        : { credentialId: applied.id, secretAvailable: false }
    }), true)
  }

  revokeGrant(actorId: string, workspaceId: string, appId: string, grantId: string) {
    return this.transaction(actorId, workspaceId, async client => {
      const result = await client.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1 AND workspace_id=$2 AND app_id=$3 AND status<>'revoked' RETURNING id", [grantId, workspaceId, appId])
      if (result.rowCount === 1) await client.query(`INSERT INTO application_authority_events(workspace_id,app_id,actor_user_id,action,resource_id)
        VALUES($1,$2,$3,'grant_revoked',$4)`, [workspaceId,appId,actorId,grantId])
      return { revoked: result.rowCount === 1 }
    }, true)
  }

  revokeCredential(actorId: string, workspaceId: string, appId: string, credentialId: string) {
    return this.transaction(actorId, workspaceId, async client => {
      const result = await client.query("UPDATE application_api_credentials SET status='revoked' WHERE id=$1 AND workspace_id=$2 AND app_id=$3 AND status<>'revoked' RETURNING id", [credentialId, workspaceId, appId])
      if (result.rowCount === 1) await client.query(`INSERT INTO application_authority_events(workspace_id,app_id,actor_user_id,action,resource_id)
        VALUES($1,$2,$3,'credential_revoked',$4)`, [workspaceId,appId,actorId,credentialId])
      return { revoked: result.rowCount === 1 }
    }, true)
  }
}
