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

  it('rejects malformed outer transaction wrappers', () => {
    expect(() => toPgliteMigrationSql('BEGIN;\nBEGIN;\nSELECT 1;\nCOMMIT;', 'bad.sql'))
      .toThrow('bad.sql: expected one outer BEGIN/COMMIT pair')
  })
})
