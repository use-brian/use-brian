/** Genuine native member transport over the existing execution kernel. [COMP:api/application-management] */
import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import { z } from 'zod'
import type {AccessCeiling} from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { getPool } from '../db/client.js'
import { authSessionStore } from '../db/auth-session-store.js'
import { findAssistantById } from '../db/users.js'
import { resolveExecutionContextSystem } from '../context-scope/execution-context.js'
export async function resolveNativeApplicationModuleExecution(req:Request,workspaceId:string,assistantId?:string,abortSignal?:AbortSignal,maximumAccess?:AccessCeiling) {
 if(!req.userId||!req.authSessionId||!z.string().uuid().safeParse(req.authSessionId).success)throw new ApplicationPlatformError('authentication_required','A native session is required.')
 const actor=req.userId,claims={userId:actor,sessionId:req.authSessionId,authVersion:req.authVersion??0}
 const current=()=>authSessionStore.validateAccess(claims)
 if(!await current())throw new ApplicationPlatformError('authentication_required','The native session is unavailable.')
 const selected=(await getPool().query<{id:string}>(`SELECT a.id FROM assistants a JOIN workspace_members m ON m.workspace_id=a.workspace_id AND m.user_id=$1
 WHERE a.workspace_id=$2 AND ($3::uuid IS NULL AND a.kind='primary' OR a.id=$3) AND assistant_placement_visible($1,a.id) ORDER BY a.id LIMIT 1`,[actor,workspaceId,assistantId??null])).rows[0]
 const assistant=selected&&await findAssistantById(selected.id)
 if(!assistant||assistant.workspaceId!==workspaceId)throw new ApplicationPlatformError('access_unavailable','The module assistant is unavailable.')
 const abort=new AbortController();if(req.aborted||abortSignal?.aborted)abort.abort();else req.once('aborted',()=>abort.abort())
 if(abortSignal&&!abortSignal.aborted)abortSignal.addEventListener('abort',()=>abort.abort(),{once:true})
 return (await resolveExecutionContextSystem({userId:actor,workspaceId,assistant,memberMode:'member',credentialCurrent:current,maximumAccess,
 identity:{kind:'attended',principal:{kind:'workspace_member',userId:actor,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId},
 lifecycle:{sessionId:randomUUID(),sessionPersisted:false,channelId:'native-module',channelType:'web',abortSignal:abort.signal}})).executionContext
}
