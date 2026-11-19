/** [COMP:crm/association-retirement] Real upgrade deletion and CRM preservation. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

const migration = new URL('../../../migrations/8270_retire_association.sql', import.meta.url)
const fixtureModule = new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
const { createLocalFixture, cleanRuntimeEnvironment } = await import(fixtureModule)

describe('[COMP:crm/association-retirement] ordinary-owner upgrade', () => {
  it('purges commerce, preserves independent CRM data and prevents reactivation', async () => {
    let verified = false
    const completed = new Error('association_retirement_verified')
    try {
      await createLocalFixture({
        pgBin: process.env.PG_BIN,
        env: cleanRuntimeEnvironment(process.env), ordinaryOwner: true,
        // Allows isolated qualification against the committed predecessor when
        // an unrelated in-progress migration blocks the complete local replay.
        beforeApplyFile: process.env.ASSOCIATION_RETIREMENT_TEST_BOUNDARY ?? '8270_retire_association.sql',
        beforeApply: async ({ adminUrl }: { adminUrl: string }) => {
          const client = new pg.Client({ connectionString: adminUrl })
          await client.connect()
          try {
            expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
              .toEqual({ rolsuper: false, rolbypassrls: false })
            const user = randomUUID(), workspace = randomUUID(), contact = randomUUID(), event = randomUUID(), ticket = randomUUID(), order = randomUUID(), plan = randomUUID(), entitlement = randomUUID()
            const line = randomUUID(), commerceParticipation = randomUUID(), manualParticipation = randomUUID(), importedMembership = randomUUID()
            const tables = ['users','workspaces','entities','association_events','association_ticket_types','association_orders','association_membership_plans','association_memberships','association_order_lines','association_registrations','association_membership_source_imports','workspace_modules']
            const triggers = (await client.query<{ relname: string; tgname: string; tgenabled: string }>(`SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1) AND NOT t.tgisinternal AND t.tgenabled<>'D'`, [tables])).rows
            const forced = (await client.query<{ relname: string }>('SELECT relname FROM pg_class WHERE oid=ANY(SELECT unnest($1::text[])::regclass) AND relforcerowsecurity', [tables])).rows
            const quote = (value: string) => '"' + value.replaceAll('"','""') + '"'
            await client.query('BEGIN; SET LOCAL row_security=off')
            for (const row of forced) await client.query(`ALTER TABLE ${quote(row.relname)} NO FORCE ROW LEVEL SECURITY`)
            for (const row of triggers) await client.query(`ALTER TABLE ${quote(row.relname)} DISABLE TRIGGER ${quote(row.tgname)}`)
            // Seed pre-retirement records, preserving real FK/CHECK constraints.
            await client.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [user])
            await client.query(`INSERT INTO workspaces(id,name,owner_user_id,home_apps) VALUES($1,'Retirement fixture',$2,'["crm","association","page"]')`, [workspace,user])
            await client.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional member',$3,'manual')", [contact,workspace,user])
            await client.query("INSERT INTO workspace_modules(workspace_id,module_key,state) VALUES($1,'association','enabled')", [workspace])
            await client.query("INSERT INTO association_events(id,workspace_id,slug,title,starts_at,ends_at,timezone,mode) VALUES($1,$2,'retirement-event','Fictional event',now(),now()+interval '1 hour','UTC','venue')", [event,workspace])
            await client.query("INSERT INTO association_ticket_types(id,workspace_id,event_id,ticket_key,name,currency,price_minor) VALUES($1,$2,$3,'standard','Standard','USD',0)", [ticket,workspace,event])
            await client.query("INSERT INTO association_orders(id,workspace_id,contact_id,idempotency_key,request_fingerprint,currency,subtotal_minor,total_minor) VALUES($1,$2,$3,'retire',repeat('a',64),'USD',0,0)", [order,workspace,contact])
            await client.query("INSERT INTO association_membership_plans(id,workspace_id,plan_key,name,currency,fee_minor,billing_period) VALUES($1,$2,'generic','Generic entitlement','USD',0,'manual')", [plan,workspace])
            await client.query("INSERT INTO association_memberships(id,workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,starts_at) VALUES($1,$2,$3,$4,'generic',repeat('b',64),now())", [entitlement,workspace,contact,plan])
            await client.query("INSERT INTO association_order_lines(id,workspace_id,order_id,ticket_id,quantity,unit_price_minor,line_total_minor,pricing_basis,eligible_membership_id) VALUES($1,$2,$3,$4,1,0,0,'member',$5)", [line,workspace,order,ticket,entitlement])
            await client.query("INSERT INTO association_registrations(id,workspace_id,event_id,order_id,order_line_id,ticket_id,attendee_contact_id,attendee_name,status,source_kind,source_id,request_fingerprint) VALUES($1,$2,$3,$4,$5::uuid,$6,$7,'Fictional attendee','confirmed','commerce',$5::text,repeat('c',64))", [commerceParticipation,workspace,event,order,line,ticket,contact])
            await client.query("INSERT INTO association_registrations(id,workspace_id,event_id,attendee_contact_id,attendee_name,status,source_kind,source_id,request_fingerprint) VALUES($1,$2,$3,$4,'Fictional attendee','registered','manual','generic',repeat('d',64))", [manualParticipation,workspace,event,contact])
            await client.query("INSERT INTO association_memberships(id,workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,starts_at) VALUES($1,$2,$3,$4,'imported',repeat('e',64),now())", [importedMembership,workspace,contact,plan])
            await client.query("INSERT INTO association_membership_source_imports(workspace_id,membership_id,source_system,source_site,source_membership_id,source_plan_id,source_status,source_renewal_status,purchased_at,import_job_id,import_row,request_fingerprint) VALUES($1,$2,'fixture','example.test','source-member','source-plan','active','manual',now(),$3,1,repeat('f',64))", [workspace,importedMembership,randomUUID()])
            await client.query('SET CONSTRAINTS ALL IMMEDIATE')
            for (const row of triggers) await client.query(`ALTER TABLE ${quote(row.relname)} ${row.tgenabled==='A'?'ENABLE ALWAYS':row.tgenabled==='R'?'ENABLE REPLICA':'ENABLE'} TRIGGER ${quote(row.tgname)}`)
            for (const row of forced) await client.query(`ALTER TABLE ${quote(row.relname)} FORCE ROW LEVEL SECURITY`)
            await client.query('COMMIT')
            const before = (await client.query("SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND t.tgname<>'workspaces_provision_modules' ORDER BY c.relname,t.tgname")).rows
            await client.query(await readFile(migration, 'utf8'))
            expect((await client.query('SELECT id FROM association_orders WHERE id=$1', [order])).rows).toEqual([])
            expect((await client.query('SELECT id FROM association_ticket_types WHERE id=$1', [ticket])).rows).toEqual([])
            await client.query('BEGIN')
            for (const table of ['entities','association_events','association_memberships','association_membership_plans','association_registrations']) await client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`)
            for (const [table,id] of [['entities',contact],['association_events',event],['association_memberships',entitlement],['association_membership_plans',plan],['association_registrations',manualParticipation]]) {
              expect((await client.query(`SELECT id FROM ${table} WHERE id=$1`, [id])).rows).toEqual([{ id }])
            }
            expect((await client.query('SELECT id FROM association_memberships WHERE id=$1', [importedMembership])).rows).toEqual([])
            expect((await client.query('SELECT id FROM association_registrations WHERE id=$1', [commerceParticipation])).rows).toEqual([])
            await client.query('ROLLBACK')
            expect((await client.query('SELECT home_apps FROM workspaces WHERE id=$1', [workspace])).rows[0].home_apps).toEqual(['crm','page'])
            expect((await client.query("SELECT 1 FROM workspace_modules WHERE module_key='association'")).rows).toEqual([])
            expect((await client.query("SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND t.tgname<>'workspaces_provision_modules' ORDER BY c.relname,t.tgname")).rows).toEqual(before)
            expect((await client.query("SELECT convalidated FROM pg_constraint WHERE conname='association_records_retired'")).rows).toHaveLength(21)
            const newWorkspace = randomUUID()
            await client.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'After retirement',$2)", [newWorkspace,user])
            expect((await client.query('SELECT 1 FROM workspace_modules WHERE workspace_id=$1', [newWorkspace])).rows).toEqual([])
            verified = true
          } finally { await client.end() }
          // The fixture owns cleanup. Stop after assertions instead of applying
          // the already-exercised migration a second time through its ledger.
          throw completed
        },
      })
    } catch (error) {
      if (!verified) throw error
      expect((error as Error & { cause?: Error }).cause).toBe(completed)
    }
    expect(verified).toBe(true)
  }, 600_000)
})
