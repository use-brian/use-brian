import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

const url = process.env.OFFICE_PDF_TEST_DATABASE_URL
const pool = url ? new pg.Pool({ connectionString: url }) : null

describe.skipIf(!url)('[COMP:api/office-pdf-sessions] migrated PDF session schema', () => {
  afterAll(async () => pool?.end())

  it('publishes the owner-idempotent lease and purge ledger with RLS', async () => {
    const columns = await pool!.query<{ table_name: string; column_name: string; is_nullable: string }>(`
      SELECT table_name,column_name,is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND (
         (table_name='office_artifacts' AND column_name IN ('expires_at','pdf_session_idempotency_key'))
         OR table_name IN ('office_pdf_session_assets','office_pdf_purge_objects'))
    `)
    expect(columns.rows.some(row => row.table_name === 'office_artifacts' && row.column_name === 'pdf_session_idempotency_key')).toBe(true)
    expect(columns.rows.some(row => row.table_name === 'office_pdf_purge_objects' && row.column_name === 'storage_uri' && row.is_nullable === 'YES')).toBe(true)
    const indexes = await pool!.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_office_pdf_%'`)
    expect(indexes.rows.map(row => row.indexname)).toContain('idx_office_pdf_session_idempotency')
    const rls = await pool!.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname,relrowsecurity FROM pg_class
       WHERE relname IN ('office_pdf_session_assets','office_pdf_purge_objects')
    `)
    expect(rls.rows).toEqual(expect.arrayContaining([
      { relname: 'office_pdf_session_assets', relrowsecurity: true },
      { relname: 'office_pdf_purge_objects', relrowsecurity: true },
    ]))
  })
})
