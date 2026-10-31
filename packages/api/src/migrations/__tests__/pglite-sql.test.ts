import { describe, expect, it } from 'vitest'

import { toPgliteMigrationSql } from '../pglite-sql.js'

describe('[COMP:api/pglite-migration-sql] PGLite migration SQL normalization', () => {
  it('removes one outer transaction pair', () => {
    expect(toPgliteMigrationSql('BEGIN;\nCREATE TABLE example (id int);\nCOMMIT;\n', '001.sql'))
      .toBe('\nCREATE TABLE example (id int);\n')
  })

  it('downgrades concurrent indexes while preserving ordinary and unique indexes', () => {
    const sql = [
      'CREATE INDEX CONCURRENTLY idx_a ON a (id);',
      'CREATE UNIQUE INDEX CONCURRENTLY idx_b ON b (id);',
      'CREATE INDEX idx_c ON c (id);',
    ].join('\n')

    expect(toPgliteMigrationSql(sql, '378.sql')).toBe([
      'CREATE INDEX idx_a ON a (id);',
      'CREATE UNIQUE INDEX idx_b ON b (id);',
      'CREATE INDEX idx_c ON c (id);',
    ].join('\n'))
  })

  it('normalizes only the reviewed int4-zero Datum at the two query prerequisite boundaries', () => {
    const native = '({CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]})'
    const embedded = native.replace('[ 0 0 0 0 0 0 0 0 ]', '[ 0 0 0 0 ]')
    for (const file of ['81660_legacy_native_query_privileges.sql', '8166_native_session_query_acquisition.sql']) {
      expect(toPgliteMigrationSql(native, file)).toBe(embedded)
      const differentDefault = native.replace('[ 0 0', '[ 1 0')
      expect(toPgliteMigrationSql(differentDefault, file)).toBe(differentDefault)
      const differentType = native.replace(':consttype 23', ':consttype 20')
      expect(toPgliteMigrationSql(differentType, file)).toBe(differentType)
    }
    expect(toPgliteMigrationSql(native, 'unrelated.sql')).toBe(native)
  })

  it('rejects malformed outer transaction wrappers', () => {
    expect(() => toPgliteMigrationSql('BEGIN;\nBEGIN;\nSELECT 1;\nCOMMIT;', 'bad.sql'))
      .toThrow('bad.sql: expected one outer BEGIN/COMMIT pair')
  })
})
