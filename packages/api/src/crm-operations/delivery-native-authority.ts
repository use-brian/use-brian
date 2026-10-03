/** Transactional native sender identity and mailbox grants. [COMP:crm/delivery-policy] */
import type { PoolClient } from 'pg'
import { CrmOperationsError, type CrmOperationsActor, type CrmNativeDeliveryAuthority } from '@use-brian/core'
import { defaultGrantedConnectorActions } from '@use-brian/shared'
import { connectorExposureAllowed } from '../context-scope/connector-exposure.js'
import { connectorInstanceGovernanceId } from '../db/connector-instance-store.js'

export type NativeDeliveryPrincipal = { actor: CrmOperationsActor; ceiling: CrmNativeDeliveryAuthority }
const denied = () => new CrmOperationsError('not_authorized','Current assistant, credential and mailbox grants are required for CRM delivery.')

/** Lock credential/capability revocation against the actual provider invocation. */
export async function lockNativeDeliveryPrincipal(client:PoolClient,workspaceId:string,native:NativeDeliveryPrincipal,write:boolean) {
  const {actor,ceiling}=native
  if(actor.kind==='assistant') {
    if(actor.assistantId!==ceiling.assistantId) throw denied()
  } else {
    let credential
    if(actor.kind==='brain_key') credential=await client.query(`SELECT scope FROM brain_keys WHERE id=$1 AND workspace_id=$2 AND status='active' FOR SHARE`,[actor.credentialId,workspaceId])
    else if(actor.kind==='oauth_token') credential=await client.query(`SELECT a.scope FROM oauth_authorizations a JOIN oauth_clients c ON c.client_id=a.client_id
      WHERE a.id=$1 AND a.workspace_id=$2 AND a.revoked_at IS NULL AND a.access_token_hash IS NOT NULL
      AND a.access_token_expires_at>clock_timestamp() AND c.revoked_at IS NULL FOR SHARE OF a,c`,[actor.credentialId,workspaceId])
    else if(actor.kind==='home_app') credential=await client.query(`SELECT granted_scopes->>'data' AS scope FROM workspace_home_apps
      WHERE id=$1 AND workspace_id=$2 AND status='active' AND granted_scopes IS NOT NULL FOR SHARE`,[actor.credentialId,workspaceId])
    else throw denied()
    if(!credential.rowCount || !['read','read_write'].includes(credential.rows[0].scope) || (write && credential.rows[0].scope!=='read_write')) throw denied()
    const primary=await client.query(`SELECT id FROM assistants WHERE workspace_id=$1 ORDER BY (kind='primary') DESC,created_at,id LIMIT 1 FOR SHARE`,[workspaceId])
    if(primary.rows[0]?.id!==ceiling.assistantId) throw denied()
  }
  const assistant=await client.query(`SELECT id FROM assistants WHERE id=$1 AND workspace_id=$2 FOR SHARE`,[ceiling.assistantId,workspaceId])
  if(!assistant.rowCount) throw denied()
  if('userId' in actor && actor.userId) {
    const membership=await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[workspaceId,actor.userId])
    if(!membership.rowCount) throw denied()
  }
  const capabilities=await client.query<{capability:string}>(`SELECT capability FROM assistant_capabilities WHERE assistant_id=$1 AND revoked_at IS NULL
    AND capability=ANY($2::text[]) ORDER BY capability FOR SHARE`,[ceiling.assistantId,['crm',write?'home_app:crm:write':'home_app:crm:read']])
  if(capabilities.rowCount!==2) throw denied()
}

type Mailbox = {id:string;scope:string;userId:string|null;provider:string;createdAt:Date;compartments:string[];projectIds:string[]}
/** Same primary precedence and exact-account action vocabulary as connector injection. */
export async function lockNativeDeliveryMailbox(client:PoolClient,workspaceId:string,native:NativeDeliveryPrincipal,instanceId:string) {
  const turn={effectiveCompartments:native.ceiling.compartments,effectiveProjectIds:native.ceiling.projectIds,
    access:{mutationCompartments:native.ceiling.mutationCompartments===undefined?[]:native.ceiling.mutationCompartments}}
  const workspace=(await client.query<{owner:string;personal:boolean}>('SELECT owner_user_id AS owner,is_personal AS personal FROM workspaces WHERE id=$1 FOR SHARE',[workspaceId])).rows[0]
  if(!workspace) throw denied()
  const instances=(await client.query<Mailbox>(`SELECT id,scope,user_id AS "userId",provider,created_at AS "createdAt",compartments,project_ids AS "projectIds"
    FROM connector_instance WHERE connected AND health_status<>'auth_failed' AND provider IN('gmail','imap','agentmail') AND
    (workspace_id=$1 OR (scope='user' AND ($2::boolean AND user_id=$3 OR id IN(SELECT connector_instance_id FROM connector_grant WHERE target_type='workspace' AND target_id=$1))))
    ORDER BY created_at,id FOR SHARE`,[workspaceId,workspace.personal,workspace.owner])).rows
  const exposures=(await client.query<{connectorInstanceId:string;compartments:string[];projectIds:string[]}>(`SELECT connector_instance_id AS "connectorInstanceId",compartments,project_ids AS "projectIds"
    FROM connector_grant WHERE target_type='workspace' AND target_id=$1 ORDER BY connector_instance_id FOR SHARE`,[workspaceId])).rows
  const visible=instances.filter(row=>row.scope==='workspace' || (workspace.personal && row.userId===workspace.owner)
    ? connectorExposureAllowed(turn,row,'fixed-operation')
    : exposures.some(grant=>grant.connectorInstanceId===row.id && connectorExposureAllowed(turn,grant,'fixed-operation')))
  const selected=visible.find(row=>row.id===instanceId)
  if(!selected) throw denied()
  const owned=visible.filter(row=>row.provider===selected.provider && row.scope==='workspace')
  const exposed=visible.filter(row=>row.provider===selected.provider && row.scope==='user')
  // The first grantor is the exposed provider family; workspace ownership supersedes it.
  const family=owned.length ? owned : exposed.filter(row=>row.userId===exposed[0]?.userId)
  if(!family.some(row=>row.id===instanceId)) throw denied()
  if(selected.provider==='agentmail') {
    const handled=await client.query(`SELECT ca.id FROM channels c JOIN channel_integrations ci ON ci.channel_id=c.id AND ci.channel_type='email'
      JOIN channel_assistants ca ON ca.channel_id=c.id AND ca.external_surface_id IS NULL
      WHERE c.workspace_id=$1 AND c.channel_type='email' AND c.status='active' AND ci.status='active' AND ca.assistant_id=$2 AND ci.connector_instance_id=$3 FOR SHARE OF c,ci,ca`,[workspaceId,native.ceiling.assistantId,instanceId])
    if(!handled.rowCount) throw denied()
  }
  const exact=connectorInstanceGovernanceId(selected.provider,instanceId)
  const governance=selected.provider==='gmail' && family[0]?.id===instanceId ? selected.provider : exact
  const settings=await client.query<{connectorId:string;enabled:boolean}>(`SELECT connector_id AS "connectorId",enabled FROM assistant_connector_settings
    WHERE assistant_id=$1 AND connector_id IN($2,$3) ORDER BY connector_id FOR SHARE`,[native.ceiling.assistantId,exact,selected.provider])
  const setting=settings.rows.find(row=>row.connectorId===exact) ?? settings.rows.find(row=>row.connectorId===selected.provider)
  if(setting?.enabled===false) throw denied()
  const sendAction={gmail:'gmailSendMessage',imap:'imapSendMessage',agentmail:'agentmailSendMessage'}[selected.provider]
  if(!sendAction) throw denied()
  const grant=await client.query<{actions:string[]}>(`SELECT allowed_actions AS actions FROM assistant_connector_grants WHERE assistant_id=$1 AND connector_id=$2 FOR SHARE`,[native.ceiling.assistantId,governance])
  // No row = the registry default grant (every write, sends included).
  const actions=grant.rows[0]?.actions??defaultGrantedConnectorActions(selected.provider)
  if(!actions.includes(sendAction)) throw denied()
  const policy=selected.scope==='workspace'
    ? await client.query(`SELECT policy FROM workspace_tool_policy WHERE workspace_id=$1 AND server_name IN($2,$3) AND tool_name=$4 FOR SHARE`,[workspaceId,selected.provider,exact,sendAction])
    : await client.query(`SELECT policy FROM mcp_tool_settings WHERE user_id=$1 AND assistant_id=$2 AND server_name IN($3,$4) AND tool_name=$5 FOR SHARE`,[selected.userId,native.ceiling.assistantId,selected.provider,exact,sendAction])
  if(policy.rows.some(row=>row.policy==='block')) throw denied()
}
