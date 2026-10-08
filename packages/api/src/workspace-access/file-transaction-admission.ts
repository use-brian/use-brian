import { AsyncLocalStorage } from 'node:async_hooks'
import type { PoolClient } from 'pg'
import type { WorkspaceFileCreateInput } from '@use-brian/core'

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
