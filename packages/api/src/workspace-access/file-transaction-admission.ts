import { AsyncLocalStorage } from 'node:async_hooks'
import type { PoolClient } from 'pg'
import type { WorkspaceFileCreateInput,WorkspaceFile } from '@use-brian/core'

type Renewal = (fileId: string) => Promise<void>
type Admission = (client: PoolClient, actor: string, input: WorkspaceFileCreateInput) => Promise<void | Renewal>
const admissions = new AsyncLocalStorage<readonly Admission[]>()

/** Trusted per-call host guards, never read from file metadata or transport fields. */
export function withFileTransactionAdmission<T>(admission: Admission, operation: () => T): T {
  return admissions.run([...(admissions.getStore() ?? []), admission], operation)
}
export async function admitFileTransaction(client: PoolClient, actor: string, input: WorkspaceFileCreateInput): Promise<Renewal> {
  const renewals: Renewal[] = []
  for (const admission of admissions.getStore() ?? []) {
    const renew = await admission(client, actor, input)
    if (renew) renewals.push(renew)
  }
  return async fileId => {
    for (const renew of renewals) await renew(fileId)
  }
}

// A semantic erasure command pins versions and finishes its receipt in the
// same app-role transaction as native File deletion. No transport can set it.
type ErasureAdmission=(client:PoolClient,actor:string,file:WorkspaceFile)=>Promise<Renewal>
const erasures=new AsyncLocalStorage<ErasureAdmission>()
export function withFileErasureAdmission<T>(admission:ErasureAdmission,operation:()=>T):T{return erasures.run(admission,operation)}
export async function admitFileErasure(client:PoolClient,actor:string,file:WorkspaceFile):Promise<Renewal>{
 return erasures.getStore()?.(client,actor,file)??(async()=>{})
}
