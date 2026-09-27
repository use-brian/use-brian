/** Bounded human workspace roster. [COMP:api/workspace-member-directory] */
import {getPool,rollbackAndRelease} from './client.js'

export type DirectoryMember={userId:string;name:string|null;email:string|null;avatarUrl:string|null}
type DirectoryRead={members:DirectoryMember[]}
const directorySql=`
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'userId', u.id, 'name', u.name, 'email', u.email, 'avatarUrl', u.avatar_url
  ) ORDER BY member.joined_at, member.id), '[]'::jsonb) AS members
  FROM workspace_members caller
  JOIN workspace_members member ON member.workspace_id=caller.workspace_id
  JOIN users u ON u.id=member.user_id
  WHERE caller.workspace_id=$1 AND caller.user_id=$2
  GROUP BY caller.id`

export type MemberDirectoryReply=
  | {status:200;body:{workspaceId:string;viewerId:string;members:DirectoryMember[];validForMs:number}}
  | {status:404|409;body:{error:'member_directory_unavailable'|'member_directory_changed'}}

/** System-pool visibility is necessary to read colleagues' profiles. The caller
 * membership is part of the same statement, never a separable unchecked roster. */
export async function readWorkspaceMemberDirectory(userId:string,workspaceId:string):Promise<MemberDirectoryReply> {
  const started=performance.now(),client=await getPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const initial=await client.query<DirectoryRead>(directorySql,[workspaceId,userId])
    await client.query('COMMIT')
    const first=initial.rows[0]
    if(!first)return {status:404,body:{error:'member_directory_unavailable'}}
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const verified=await client.query<DirectoryRead>(directorySql,[workspaceId,userId])
    if(JSON.stringify(verified.rows)!==JSON.stringify(initial.rows))return {status:409,body:{error:'member_directory_changed'}}
    await client.query('COMMIT')
    const validForMs=Math.floor(30_000-(performance.now()-started))
    if(!Number.isFinite(validForMs)||validForMs<=0)return {status:404,body:{error:'member_directory_unavailable'}}
    return {status:200,body:{workspaceId,viewerId:userId,members:first.members,validForMs}}
  } finally {await rollbackAndRelease(client)}
}
