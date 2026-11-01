import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPool } from '../client.js'
const enabled = Boolean(process.env.BRIAN_ASSURANCE_FIXTURE), owner = getPool()
const scope = (tier = 2) => ({ kind: 'native_legacy', tier, compartments: null, projectIds: null })
const selector = (ids: string[] | null = null) => ({ ids, ownerId: null, relationships: [], empty: false })
const clause = (read: string[], tier = 2, ids: string[] | null = null) => ({ scope: scope(tier), selector: selector(ids), read })
const domain = (clauses: unknown[]) => ({ kind: 'application_query', version: 1, clauses })
async function result(name: 'before' | 'after', current: unknown, original: unknown, fields: string[]) {
  try { return { value: (await owner.query(`SELECT ${name === 'before' ? 'crm_formula_comparison.before' : 'application_query_domain_contains'}($1,$2,$3) AS value`, [current, original, fields])).rows[0].value } }
  catch (error) { return { code: (error as { code: string }).code, message: (error as Error).message } }
}
describe.skipIf(!enabled).sequential('[COMP:crm/query-formula] immutable expression equivalence and logical bounds', () => {
  beforeAll(async () => {
    const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href); await assertLocalFixture()
    await owner.query('CREATE SCHEMA crm_formula_comparison')
    await owner.query(await readFile(new URL('./fixtures/native-query-formula-before.sql', import.meta.url), 'utf8'))
  })
  afterAll(async () => { if (enabled) await owner.query('DROP SCHEMA crm_formula_comparison CASCADE'); await owner.end() })
  it('retains complete field masks, selector alternatives and malformed-domain refusal', async () => {
    const shapes = [domain([]), domain([clause([])]), domain([clause(['a', 'b', 'c'])]), domain([clause(['a'], 1), clause(['b', 'c'], 3)]),
      domain([clause(['a', 'b'], 3), clause(['b', 'c'], 1)]), domain([clause(['a', 'b'], 2, ['00000000-0000-4000-8000-000000000001'])]),
      domain([clause(['a', 'b'], 2), clause(['a', 'b'], 2)]), { ...domain([clause(['a'])]), unexpected: true },
      domain([{ ...clause(['a']), scope: { ...scope(), tier: 9 } }]), null]
    const department = '00000000-0000-4000-8000-000000000002'
    for (const departments of [null, {}, {[department]: 2}]) for (const contextDepartment of [null, department]) {
      shapes.push(domain([{ ...clause(['a','b']), scope: {kind:'native_department_v2',tier:2,departments,contextDepartment,
        projectLabels:[],otherLabels:null,projectIds:null} }]))
    }
    for (const current of shapes) for (const original of shapes) for (const fields of [[], ['a'], ['a', 'b'], ['a', 'b', 'c']]) {
      expect(await result('after', current, original, fields)).toEqual(await result('before', current, original, fields))
    }
  })
  it('retains the exact logical complexity refusal despite sharing actual computation', async () => {
    const fields = Array.from({ length: 128 }, (_, index) => `field${index}`)
    for (const copies of [1, 4, 16, 50]) {
      const value = domain(Array.from({ length: copies }, () => clause(fields)))
      const expected = await result('before', value, value, fields)
      expect(await result('after', value, value, fields)).toEqual(expected)
      if (copies === 50) expect(expected).toMatchObject({ code: '42501', message: 'query_domain_complexity_unavailable' })
    }
  })
  it('retains the exact scope-union result and consumed budget for repeated inputs', async () => {
    const scopes: unknown[] = [scope(), scope(1), {...scope(),compartments:[]}, {...scope(),projectIds:[]}, null, {kind:'invalid'}]
    const invoke = async (name:string,original:unknown,current:unknown[],budget:number) => {
      try { return {value:(await owner.query(`SELECT ${name}($1,$2,$3) AS value`,[original,JSON.stringify(current),budget])).rows[0].value} }
      catch(error) {return {code:(error as {code:string}).code,message:(error as Error).message}}
    }
    for (const original of scopes) for (const current of [[],[original],[original,original],scopes]) for (const budget of [0,1,2,4,8,32]) {
      expect(await invoke('application_query_scope_union_contains',original,current,budget)).toEqual(await invoke('crm_formula_comparison.scope_before',original,current,budget))
    }
  })

})
