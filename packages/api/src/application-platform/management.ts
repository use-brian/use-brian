/** Native app preparation and recovery; registration confers no data rights. [COMP:api/application-auth] */
import type { Pool, PoolClient } from 'pg'
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
import { applicationSchemaPreviewInput } from './schema-changes.js'
import { applicationGovernanceCatalogInput,applicationGovernanceModuleInput,applicationGovernancePreviewInput,applicationGovernanceApplyInput } from './governance.js'
import { buildNativeApplicationSchemaMcpTools,buildNativeApplicationGovernanceMcpTools } from './mcp.js'

const clientColumns = `id,workspace_id AS "workspaceId",module_key AS "moduleKey",name,client_mode AS mode,
  origins,redirect_uris AS "redirectUris",home_app_id AS "homeAppId",oauth_client_id AS "oauthClientId",executing_assistant_id AS "executingAssistantId",
  status,grant_revision::text AS revision,created_at AS "createdAt"`
const schemaAssistantInput = z.object({ assistantId: z.string().uuid().optional() }).strict()
const schemaPreviewBody = applicationSchemaPreviewInput.omit({ typeId: true }).extend(schemaAssistantInput.shape).strict()
export class ApplicationManagementService {
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
    const preview=await this.applications.previewSchema(execution,typeId,input.data.expectedVersion,input.data.properties)
    await execution.security.authority.assertCurrent()
    return preview
  }

  async applySchema(actorId: string,workspaceId: string,previewId: string,rawInput: unknown,signal?: AbortSignal) {
    const input=schemaAssistantInput.safeParse(rawInput)
    if (!input.success || !z.string().uuid().safeParse(previewId).success) throw new ApplicationPlatformError('invalid_value','The schema review is invalid.')
    return this.applications.applySchema(await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal),previewId)
  }

  async schemaMcpTools(actorId: string,workspaceId: string,rawSelection: unknown,signal?: AbortSignal) {
    const selection=schemaAssistantInput.safeParse(rawSelection)
    if (!selection.success) throw new ApplicationPlatformError('invalid_value','The management assistant selection is invalid.')
    return buildNativeApplicationSchemaMcpTools(this.applications,await this.nativeSchemaExecution(actorId,workspaceId,selection.data.assistantId,signal))
  }

  async governanceCatalog(actorId:string,workspaceId:string,rawSelection:unknown,signal?:AbortSignal) {
    const input=applicationGovernanceCatalogInput.extend(schemaAssistantInput.shape).strict().safeParse(rawSelection)
    if (!input.success) throw new ApplicationPlatformError('invalid_value','The native governance selection is invalid.')
    const execution=await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal)
    const result=await this.applications.governanceCatalog(execution,{moduleKey:input.data.moduleKey,afterId:input.data.afterId})
    await execution.security.authority.assertCurrent();return result
  }
  async previewGovernance(actorId:string,workspaceId:string,rawInput:unknown,signal?:AbortSignal) {
    const input=applicationGovernancePreviewInput.extend(schemaAssistantInput.shape).strict().safeParse(rawInput)
    if (!input.success) throw new ApplicationPlatformError('invalid_value','The native governance proposal is invalid.')
    const execution=await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal)
    const {assistantId:_assistant,...proposal}=input.data
    const result=await this.applications.previewGovernance(execution,proposal)
    await execution.security.authority.assertCurrent();return result
  }
  async applyGovernance(actorId:string,workspaceId:string,reviewId:string,rawInput:unknown,signal?:AbortSignal) {
    const input=schemaAssistantInput.safeParse(rawInput)
    if (!input.success || !applicationGovernanceApplyInput.safeParse({reviewId}).success) throw new ApplicationPlatformError('invalid_value','The native governance review is invalid.')
    return this.applications.applyGovernance(await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal),{reviewId})
  }
  async governanceMcpTools(actorId:string,workspaceId:string,rawSelection:unknown,signal?:AbortSignal) {
    const input=applicationGovernanceModuleInput.extend(schemaAssistantInput.shape).strict().safeParse(rawSelection)
    if (!input.success) throw new ApplicationPlatformError('invalid_value','The native governance selection is invalid.')
    return buildNativeApplicationGovernanceMcpTools(this.applications,await this.nativeSchemaExecution(actorId,workspaceId,input.data.assistantId,signal),input.data.moduleKey)
  }

  list(actorId: string, workspaceId: string) {
    return this.transaction(actorId, workspaceId, async client => (await client.query(`SELECT ${clientColumns},
      application_runtime_qualified(workspace_id,'application_data') AS qualified FROM application_clients WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId])).rows)
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
      const result = await client.query(`UPDATE application_clients SET status=$3 WHERE id=$1 AND workspace_id=$2
        AND (status<>'revoked' OR $3='revoked') RETURNING ${clientColumns}`, [appId, workspaceId, status])
      if (!result.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'The application is unavailable.')
      await client.query(`INSERT INTO application_authority_events(workspace_id,app_id,actor_user_id,action,resource_id)
        VALUES($1,$2,$3,'client_status_changed',$2)`, [workspaceId,appId,actorId])
      return result.rows[0]
    }, true)
  }

  listGrants(actorId: string, workspaceId: string, appId: string) {
    return this.transaction(actorId, workspaceId, async client => (await client.query(`SELECT id,principal_kind AS "principalKind",principal_user_id AS "principalUserId",
      resource_origin AS origin,resource_type AS "typeKey",actions,read_fields AS "readFields",write_fields AS "writeFields",selector,
      status,version::text AS version,expires_at AS "expiresAt" FROM application_access_grants WHERE workspace_id=$1 AND app_id=$2 ORDER BY id`, [workspaceId, appId])).rows)
  }

  private async withReleaseAuthority<T>(client: PoolClient, actorId: string, workspaceId: string, appId: string, operation: () => Promise<T>) {
    const result = await client.query<{ assistantId: string; moduleKey: string }>(`SELECT executing_assistant_id AS "assistantId",module_key AS "moduleKey"
      FROM application_clients WHERE id=$1 AND workspace_id=$2 AND status='active' FOR SHARE`, [appId, workspaceId])
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
        application_runtime_qualified(workspace_id,'application_data') AS "canIssue" FROM application_grant_reviews WHERE id=$1`, [result.rows[0].id])).rows[0]
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
    return this.transaction(actorId, workspaceId, async client => (await client.query(`SELECT id,name,credential_kind AS kind,subject_user_id AS "serviceUserId",
      status,expires_at AS "expiresAt",last_used_at AS "lastUsedAt",version::text AS version FROM application_api_credentials
      WHERE workspace_id=$1 AND app_id=$2 ORDER BY created_at,id`, [workspaceId, appId])).rows)
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
      return (await client.query(`SELECT id,proposal,expires_at AS "expiresAt",application_runtime_qualified(workspace_id,'application_data') AS "canIssue"
        FROM application_credential_reviews WHERE id=$1`, [result.rows[0].id])).rows[0]
    }), true)
  }

  /** Native human delivery only. Brian tools return the review/management link. */
  applyCredentialReview(actorId: string, workspaceId: string, appId: string, reviewId: string) {
    return this.transaction(actorId, workspaceId, client => this.withReleaseAuthority(client, actorId, workspaceId, appId, async () => {
      const result = await client.query<{ consumed: string | null; qualified: boolean }>(`SELECT consumed_credential_id AS consumed,
        application_runtime_qualified(workspace_id,'application_data') AS qualified FROM application_credential_reviews
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
