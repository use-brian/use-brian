/** Host-only anonymous share authority for canonical native reads. [COMP:api/application-records] */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { ApplicationPlatformError } from '@use-brian/shared'
export type CanonicalPublicShareAuthority={kind:'link';token:string}|{kind:'published'}|{kind:'preview';userId:string}
const frames=new AsyncLocalStorage<{workspaceId:string;rootId:string;authority:CanonicalPublicShareAuthority;active:boolean}>()
export async function runWithCanonicalPublicShare<T>(workspaceId:string,rootId:string,authority:CanonicalPublicShareAuthority,operation:()=>Promise<T>):Promise<T>{
 const frame={workspaceId,rootId,authority,active:true}
 return frames.run(frame,async()=>{try{return await operation()}finally{frame.active=false}})
}
export function currentCanonicalPublicShare(workspaceId:string){
 const frame=frames.getStore();if(!frame)return undefined
 const assertLive=()=>{if(frames.getStore()!==frame||!frame.active||frame.workspaceId!==workspaceId)throw new ApplicationPlatformError('access_unavailable','The share is unavailable.')}
 assertLive();return {actorId:frame.authority.kind==='preview'?frame.authority.userId:'00000000-0000-0000-0000-000000000000',assertLive,
  async apply(client:PoolClient){assertLive();await client.query("SELECT set_config('app.public_share_root',$1,true),set_config('app.public_share_mode',$2,true),set_config('app.public_share_token_hash',$3,true)",
   [frame.rootId,frame.authority.kind,frame.authority.kind==='link'?createHash('sha256').update(frame.authority.token).digest('hex'):'']);assertLive()}}
}
