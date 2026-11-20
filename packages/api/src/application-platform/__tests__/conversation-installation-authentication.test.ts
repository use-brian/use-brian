import { describe, expect, it, vi } from 'vitest'
const { assertAuthenticationReadOnly, currentInstallationAuthenticationSource, authenticateConversationInstallation } =
  await import(new URL('../../../scripts/conversation-store/installation-authentication.mjs', import.meta.url).href)

describe('[COMP:api/native-turn-frame] finite source-owned installation authentication', () => {
  it('constructs the current pinned source proof with no public registry mutation', async () => {
    const source = await currentInstallationAuthenticationSource()
    // The head recipe pins the newest executable-contract migration (8294).
    expect(source.sourceDigest).toBe('6107a119ebd420c92e1c8320249ad17453e9de2a0fbd82a65496c4748c9bbf20')
    expect(() => assertAuthenticationReadOnly(source.sql)).not.toThrow()
  })
  it.each([
    'INSERT INTO native_turn_contract_helpers VALUES(1)',
    'UPDATE public.native_turn_contract_helpers SET contract=NULL',
    'CREATE FUNCTION public.unreviewed() RETURNS boolean AS $$ SELECT true $$ LANGUAGE sql',
    'CREATE TRIGGER native_conversation_conversion_enroll AFTER INSERT ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.unreviewed()',
  ])('refuses public mutation in the finite compiler recipe: %s', (sql: string) => {
    expect(() => assertAuthenticationReadOnly(sql)).toThrow(/public.*mutation/)
  })
  it('allows the source reference trigger while checking its target scope', () => {
    expect(() => assertAuthenticationReadOnly('CREATE TRIGGER native_conversation_conversion_enroll AFTER INSERT ON pg_temp.a8273_conversion_enrollment_reference_0 FOR EACH ROW EXECUTE FUNCTION public.native_conversation_conversion_enroll()')).not.toThrow()
  })
  it('leaves a caller-owned transaction untouched', async () => {
    const query = vi.fn()
    await expect(authenticateConversationInstallation({ getTransactionStatus: () => 'T', query })).rejects.toThrow('installation_authentication_requires_idle_owner')
    expect(query).not.toHaveBeenCalled()
  })
})
