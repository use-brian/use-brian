import { runWithAgentAccess } from '../agent-access-context.js'
import { describe, expect, it } from 'vitest'
import { buildAccessPredicate } from '../access-predicate.js'
import { buildMemoryAccessPredicate } from '../memory-access-predicate.js'

const ordinary = {
  workspaceId: 'ws-1',
  userId: 'user-a',
  assistantId: 'assistant-studio',
  assistantKind: 'standard' as const,
  clearance: 'public' as const,
  compartments: [] as string[],
}

describe('[COMP:brain/client-self-memory] memory access predicate', () => {
  it('adds holding protection without changing the ordinary authority parameters', () => {
    const predicate = buildMemoryAccessPredicate(ordinary)
    const universal = buildAccessPredicate(ordinary)
    expect(predicate).toEqual({ ...universal, sql: `(${universal.sql}) AND scope_held = false` })
  })

  it('adds one exact internal self branch without widening the ordinary ceiling', () => {
    const predicate = buildMemoryAccessPredicate({
      ...ordinary,
      clientSelfMemory: { compartment: 'client:studio-client:alice' },
    }, { alias: 'm', startIdx: 2 })

    expect(predicate.sql).toContain('sensitivity_rank(m.sensitivity) <= sensitivity_rank($5)')
    expect(predicate.sql).toContain('m.compartments <@ $6::text[]')
    expect(predicate.sql).toContain(' OR ')
    expect(predicate.sql).toContain('m.workspace_id = $7')
    expect(predicate.sql).toContain('m.user_id = $8')
    expect(predicate.sql).toContain('m.assistant_id = $9')
    expect(predicate.sql).toContain('sensitivity_rank(m.sensitivity) <= sensitivity_rank($10)')
    expect(predicate.sql).toContain('m.compartments = ARRAY[$11]::text[]')
    expect(predicate.params.slice(-5)).toEqual([
      'ws-1',
      'user-a',
      'assistant-studio',
      'internal',
      'client:studio-client:alice',
    ])
    expect(predicate.nextIdx).toBe(12)
    expect(predicate.sql).toMatch(/\) AND m\.scope_held = false$/)
  })

  it('refuses an operator compartment in the client-only branch', () => {
    expect(() => buildMemoryAccessPredicate({
      ...ordinary,
      clientSelfMemory: { compartment: 'sales' },
    })).toThrow(/client:/)
  })
})


describe('[COMP:brain/client-self-memory] delegated visibility',()=>{
  it('fences both ordinary and self-memory branches under an inherited visibility ceiling',()=>{
    runWithAgentAccess({workspaceId:'ws-1',userId:'other-actor',clearance:'internal',compartments:null,visibilityAssistantIds:[]},()=>{
      const result=buildMemoryAccessPredicate({...ordinary,clientSelfMemory:{compartment:'client:fixture'}})
      expect(result.sql.match(/assistant_id = ANY/g)).toHaveLength(2)
      expect(result.params.slice(-2)).toEqual(['other-actor',[]])
    })
  })
})
