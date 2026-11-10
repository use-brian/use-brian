import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
vi.mock('../admission-policy-read.js', async original => ({
  ...await original<object>(), readAdmissionPolicy: vi.fn(),
}))
import { readAdmissionPolicy } from '../admission-policy-read.js'
import { admitAnchoredSession } from '../session-create-admission.js'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const input = { workspaceId,assistantId:'assistant',userId:'actor',channelType:'doc_thread',channelId:'thread',anchorKind:'doc_thread' as const }
function client() {
  return { query:vi.fn(async (sql: string) => ({ rows:sql.includes('FROM assistants') ? [{ workspaceId,clearance:'internal' }] : [] })) }
}
describe('[COMP:api/session-schema] anchored provenance after workspace setup', () => {
  it.each([true,false])('retains the anchored receipt in ready mode (v2=%s) without applying Department defaults', async departmentReadV2 => {
    vi.mocked(readAdmissionPolicy).mockResolvedValue({ workspaceId,revision:'4',mode:'enterprise',setupState:'ready',departmentReadV2 } as never)
    const db = client()
    const result = await admitAnchoredSession(db as unknown as PoolClient,input)
    const call = db.query.mock.calls.find(([sql]) => sql.includes('session_creation_admission')) as unknown as [string,string[]]
    expect(JSON.parse(call[1][0])).toMatchObject({ provenance:'anchored_thread',actor:'actor',anchorKind:'doc_thread',policyRevision:'4' })
    expect(result).toMatchObject({ workspaceId,effectiveClearance:'internal' })
    expect(result).not.toHaveProperty('contextGroupId')
    expect(result).not.toHaveProperty('contextCompartments')
  })
  it('keeps legacy creation unchanged and refuses a foreign assistant in ready v2 mode', async () => {
    vi.mocked(readAdmissionPolicy).mockResolvedValue({ workspaceId,revision:'4',mode:'enterprise',setupState:'legacy',departmentReadV2:true } as never)
    const db = client()
    await admitAnchoredSession(db as unknown as PoolClient,input)
    expect(db.query.mock.calls.some(([sql]) => sql.includes('session_creation_admission'))).toBe(false)
    vi.mocked(readAdmissionPolicy).mockResolvedValue({ workspaceId,revision:'4',mode:'enterprise',setupState:'ready',departmentReadV2:true } as never)
    await expect(admitAnchoredSession(client() as unknown as PoolClient,{ ...input,workspaceId:'other' })).rejects.toMatchObject({ code:'context_not_available' })
  })
})
