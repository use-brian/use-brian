/**
 * Unit tests for the universal access projection helper.
 * Component tag: [COMP:brain/permission-predicates].
 *
 * Pure string/value assertions; no DB needed. See
 * docs/plans/company-brain/permissions.md → "Access predicate" and
 * "Universal resource projection".
 */

import { describe, it, expect } from 'vitest'
import type { Sensitivity } from '@sidanclaw/core'
import {
  buildAccessPredicate,
  type AccessContext,
} from '../access-predicate.js'

const ctx: AccessContext = {
  workspaceId: 'ws-1',
  userId: 'u-1',
  assistantId: 'a-1',
  assistantKind: 'standard',
  clearance: 'confidential',
}

describe('[COMP:brain/permission-predicates] buildAccessPredicate', () => {
  it('produces the canonical fragment with default options', () => {
    const ap = buildAccessPredicate(ctx)
    expect(ap.sql).toBe(
      '(workspace_id IS NULL OR workspace_id = $1)' +
        ' AND (user_id IS NULL OR user_id = $2)' +
        ' AND (assistant_id IS NULL OR assistant_id = $3)' +
        ' AND sensitivity_rank(sensitivity) <= sensitivity_rank($4)',
    )
    expect(ap.params).toEqual(['ws-1', 'u-1', 'a-1', 'confidential'])
    expect(ap.nextIdx).toBe(5)
  })

  it('prefixes every column when alias is supplied', () => {
    const ap = buildAccessPredicate(ctx, { alias: 'm' })
    expect(ap.sql).toBe(
      '(m.workspace_id IS NULL OR m.workspace_id = $1)' +
        ' AND (m.user_id IS NULL OR m.user_id = $2)' +
        ' AND (m.assistant_id IS NULL OR m.assistant_id = $3)' +
        ' AND sensitivity_rank(m.sensitivity) <= sensitivity_rank($4)',
    )
    // 7 column occurrences (workspace_id×2, user_id×2, assistant_id×2, sensitivity) all prefixed
    expect(ap.sql.match(/\bm\./g)).toHaveLength(7)
    expect(ap.nextIdx).toBe(5)
  })

  it('offsets placeholder indices by startIdx', () => {
    const ap = buildAccessPredicate(ctx, { startIdx: 7 })
    expect(ap.sql).toContain('$7')
    expect(ap.sql).toContain('$8')
    expect(ap.sql).toContain('$9')
    expect(ap.sql).toContain('$10')
    expect(ap.sql).not.toContain('$1 ')
    expect(ap.nextIdx).toBe(11)
  })

  it('composes alias and startIdx independently', () => {
    const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 3 })
    expect(ap.sql).toBe(
      '(e.workspace_id IS NULL OR e.workspace_id = $3)' +
        ' AND (e.user_id IS NULL OR e.user_id = $4)' +
        ' AND (e.assistant_id IS NULL OR e.assistant_id = $5)' +
        ' AND sensitivity_rank(e.sensitivity) <= sensitivity_rank($6)',
    )
    expect(ap.params).toEqual(['ws-1', 'u-1', 'a-1', 'confidential'])
    expect(ap.nextIdx).toBe(7)
  })

  it('returns params in placeholder order: workspaceId, userId, assistantId, clearance', () => {
    const distinct: AccessContext = {
      workspaceId: 'WS',
      userId: 'U',
      assistantId: 'A',
      assistantKind: 'standard',
      clearance: 'internal',
    }
    const ap = buildAccessPredicate(distinct)
    expect(ap.params[0]).toBe('WS')
    expect(ap.params[1]).toBe('U')
    expect(ap.params[2]).toBe('A')
    expect(ap.params[3]).toBe('internal')
  })

  it('accepts every Sensitivity tier in clearance', () => {
    const tiers: Sensitivity[] = ['public', 'internal', 'confidential']
    for (const tier of tiers) {
      const ap = buildAccessPredicate({ ...ctx, clearance: tier })
      expect(ap.params[3]).toBe(tier)
    }
  })

  it.each([
    ['empty string', ''],
    ['leading digit', '1bad'],
    ['contains space', 'm m'],
    ['contains semicolon', 'm;DROP'],
    ['contains double quote', 'm"'],
    ['contains dot', 'a.b'],
    ['contains hyphen', 'a-b'],
  ])('rejects invalid alias: %s', (_label, alias) => {
    expect(() => buildAccessPredicate(ctx, { alias })).toThrow(/invalid alias/)
  })

  it('accepts identifier-safe aliases (letters, digits, underscore; non-leading digit)', () => {
    for (const alias of ['m', 'M', '_x', 'a1', 'tbl_2', 'A_B_3']) {
      expect(() => buildAccessPredicate(ctx, { alias })).not.toThrow()
    }
  })

  describe('no-clearance branch (system caller)', () => {
    const systemCtx: AccessContext = {
      workspaceId: 'ws-1',
      userId: 'u-1',
      assistantId: 'a-1',
      assistantKind: 'standard',
    }

    it('drops the sensitivity_rank clause and shrinks params to 3', () => {
      const ap = buildAccessPredicate(systemCtx)
      expect(ap.sql).toBe(
        '(workspace_id IS NULL OR workspace_id = $1)' +
          ' AND (user_id IS NULL OR user_id = $2)' +
          ' AND (assistant_id IS NULL OR assistant_id = $3)',
      )
      expect(ap.sql).not.toContain('sensitivity_rank')
      expect(ap.params).toEqual(['ws-1', 'u-1', 'a-1'])
      expect(ap.nextIdx).toBe(4)
    })

    it('honours alias + startIdx in the no-clearance branch', () => {
      const ap = buildAccessPredicate(systemCtx, { alias: 'm', startIdx: 5 })
      expect(ap.sql).toBe(
        '(m.workspace_id IS NULL OR m.workspace_id = $5)' +
          ' AND (m.user_id IS NULL OR m.user_id = $6)' +
          ' AND (m.assistant_id IS NULL OR m.assistant_id = $7)',
      )
      expect(ap.nextIdx).toBe(8)
    })

    it('treats explicit undefined clearance the same as omitted', () => {
      const ap = buildAccessPredicate({ ...systemCtx, clearance: undefined })
      expect(ap.params).toHaveLength(3)
      expect(ap.nextIdx).toBe(4)
    })
  })

  describe('primary widen (workspace reflector)', () => {
    const primaryCtx: AccessContext = {
      workspaceId: 'ws-1',
      userId: 'u-1',
      assistantId: 'a-primary',
      assistantKind: 'primary',
      clearance: 'confidential',
    }

    it('drops the assistant_id partition entirely (no clause, no param)', () => {
      const ap = buildAccessPredicate(primaryCtx)
      expect(ap.sql).toBe(
        '(workspace_id IS NULL OR workspace_id = $1)' +
          ' AND (user_id IS NULL OR user_id = $2)' +
          ' AND sensitivity_rank(sensitivity) <= sensitivity_rank($3)',
      )
      expect(ap.sql).not.toContain('assistant_id')
      expect(ap.params).toEqual(['ws-1', 'u-1', 'confidential'])
      expect(ap.nextIdx).toBe(4)
    })

    it('preserves the user_id partition (user-specific rows stay scoped)', () => {
      const ap = buildAccessPredicate(primaryCtx)
      expect(ap.sql).toContain('user_id')
    })

    it('preserves clearance ceiling (sensitivity still bounds the read)', () => {
      const ap = buildAccessPredicate(primaryCtx)
      expect(ap.sql).toContain('sensitivity_rank')
      expect(ap.params).toContain('confidential')
    })

    it('honours alias + startIdx alongside the widen', () => {
      const ap = buildAccessPredicate(primaryCtx, { alias: 'm', startIdx: 5 })
      expect(ap.sql).toBe(
        '(m.workspace_id IS NULL OR m.workspace_id = $5)' +
          ' AND (m.user_id IS NULL OR m.user_id = $6)' +
          ' AND sensitivity_rank(m.sensitivity) <= sensitivity_rank($7)',
      )
      expect(ap.nextIdx).toBe(8)
    })

    it('widens for primary in the no-clearance branch too (system primary callers)', () => {
      const ap = buildAccessPredicate({
        workspaceId: 'ws-1',
        userId: 'u-1',
        assistantId: 'a-primary',
        assistantKind: 'primary',
      })
      expect(ap.sql).toBe(
        '(workspace_id IS NULL OR workspace_id = $1)' +
          ' AND (user_id IS NULL OR user_id = $2)',
      )
      expect(ap.params).toEqual(['ws-1', 'u-1'])
      expect(ap.nextIdx).toBe(3)
    })

    it("does NOT widen for kind='standard'", () => {
      const ap = buildAccessPredicate({ ...primaryCtx, assistantKind: 'standard' })
      expect(ap.sql).toContain('assistant_id')
      expect(ap.params).toContain('a-primary')
    })

    it("does NOT widen for kind='app'", () => {
      const ap = buildAccessPredicate({ ...primaryCtx, assistantKind: 'app' })
      expect(ap.sql).toContain('assistant_id')
      expect(ap.params).toContain('a-primary')
    })
  })

  describe('compartment axis', () => {
    it('omits the clause for the universe grant (compartments absent)', () => {
      const ap = buildAccessPredicate(ctx)
      expect(ap.sql).not.toContain('compartments')
      expect(ap.params).toEqual(['ws-1', 'u-1', 'a-1', 'confidential'])
      expect(ap.nextIdx).toBe(5)
    })

    it('omits the clause for the universe grant (explicit null)', () => {
      const ap = buildAccessPredicate({ ...ctx, compartments: null })
      expect(ap.sql).not.toContain('compartments')
      expect(ap.params).toEqual(['ws-1', 'u-1', 'a-1', 'confidential'])
      expect(ap.nextIdx).toBe(5)
    })

    it('appends the superset clause for a finite grant (row.compartments <@ $n)', () => {
      const ap = buildAccessPredicate({ ...ctx, compartments: ['sales', 'finance'] })
      expect(ap.sql).toBe(
        '(workspace_id IS NULL OR workspace_id = $1)' +
          ' AND (user_id IS NULL OR user_id = $2)' +
          ' AND (assistant_id IS NULL OR assistant_id = $3)' +
          ' AND sensitivity_rank(sensitivity) <= sensitivity_rank($4)' +
          ' AND compartments <@ $5::text[]',
      )
      expect(ap.params).toEqual(['ws-1', 'u-1', 'a-1', 'confidential', ['sales', 'finance']])
      expect(ap.nextIdx).toBe(6)
    })

    it('treats an empty grant as cleared-into-nothing (still emits the clause)', () => {
      const ap = buildAccessPredicate({ ...ctx, compartments: [] })
      expect(ap.sql).toContain('AND compartments <@ $5::text[]')
      expect(ap.params).toEqual(['ws-1', 'u-1', 'a-1', 'confidential', []])
      expect(ap.nextIdx).toBe(6)
    })

    it('composes with the no-clearance branch (system caller): compartment takes $4', () => {
      const ap = buildAccessPredicate({
        workspaceId: 'ws-1',
        userId: 'u-1',
        assistantId: 'a-1',
        assistantKind: 'standard',
        compartments: ['sales'],
      })
      expect(ap.sql).toBe(
        '(workspace_id IS NULL OR workspace_id = $1)' +
          ' AND (user_id IS NULL OR user_id = $2)' +
          ' AND (assistant_id IS NULL OR assistant_id = $3)' +
          ' AND compartments <@ $4::text[]',
      )
      expect(ap.sql).not.toContain('sensitivity_rank')
      expect(ap.params).toEqual(['ws-1', 'u-1', 'a-1', ['sales']])
      expect(ap.nextIdx).toBe(5)
    })

    it('composes with primary widen (assistant_id dropped, clearance + compartment kept)', () => {
      const ap = buildAccessPredicate({
        workspaceId: 'ws-1',
        userId: 'u-1',
        assistantId: 'a-primary',
        assistantKind: 'primary',
        clearance: 'confidential',
        compartments: ['ops'],
      })
      expect(ap.sql).toBe(
        '(workspace_id IS NULL OR workspace_id = $1)' +
          ' AND (user_id IS NULL OR user_id = $2)' +
          ' AND sensitivity_rank(sensitivity) <= sensitivity_rank($3)' +
          ' AND compartments <@ $4::text[]',
      )
      expect(ap.sql).not.toContain('assistant_id')
      expect(ap.params).toEqual(['ws-1', 'u-1', 'confidential', ['ops']])
      expect(ap.nextIdx).toBe(5)
    })

    it('prefixes the compartment column with the alias and offsets by startIdx', () => {
      const ap = buildAccessPredicate(
        { ...ctx, compartments: ['sales'] },
        { alias: 'm', startIdx: 7 },
      )
      // visibility $7-$9, clearance $10, compartment $11
      expect(ap.sql).toContain('AND m.compartments <@ $11::text[]')
      expect(ap.nextIdx).toBe(12)
    })
  })
})
