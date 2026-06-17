import { describe, it, expect } from 'vitest'
import {
  EDGE_TYPES,
  EDGE_SPECS,
  ENTITY_KINDS,
  LINK_ENDPOINT_KINDS,
  type EdgeAttributesFor,
  type EdgeType,
  getEdgeSpec,
  isEdgeType,
  isEntityKind,
  isLinkEndpointKind,
  makeEdgeInput,
  validateEdge,
} from '../edges.js'

describe('[COMP:brain/edge-vocabulary] Edge vocabulary', () => {
  describe('constant tables', () => {
    it('declares all 20 locked edge types', () => {
      expect(EDGE_TYPES).toHaveLength(20)
    })

    it('contains each named edge from data-model.md §Entity Links', () => {
      const expected = [
        'works_at',
        'attended',
        'discussed_in',
        'represents',
        'mentioned',
        'signed_contract_with',
        'competes_with',
        'customer_since',
        'engagement_of',
        'target_investor',
        'outreach_strategy_for',
        'mutual_connection',
        'discussed_with',
        'depends_on',
        'mentioned_publicly_at',
        'target_competitor',
        'documented_by',
        'platform_engagement_for',
        'replies_to',
        'detail_page_of',
      ] as const
      for (const name of expected) {
        expect(EDGE_TYPES).toContain(name)
      }
    })

    it('has a spec entry for every edge type', () => {
      for (const t of EDGE_TYPES) {
        const spec = getEdgeSpec(t)
        expect(spec, `missing spec for ${t}`).toBeDefined()
        expect(spec.fromKinds.length, `${t} fromKinds empty`).toBeGreaterThan(0)
        expect(spec.toKinds.length, `${t} toKinds empty`).toBeGreaterThan(0)
        expect(spec.description, `${t} description missing`).toBeTruthy()
      }
    })

    it('marks the three documented-attribute edges with the right shape tag', () => {
      expect(EDGE_SPECS.target_investor.attributesShape).toBe('target_investor')
      expect(EDGE_SPECS.target_competitor.attributesShape).toBe('target_competitor')
      expect(EDGE_SPECS.documented_by.attributesShape).toBe('documented_by')
    })
  })

  describe('type guards', () => {
    it('isEdgeType accepts known edge types and rejects others', () => {
      expect(isEdgeType('works_at')).toBe(true)
      expect(isEdgeType('mentioned')).toBe(true)
      expect(isEdgeType('replies_to')).toBe(true)
      expect(isEdgeType('bogus_edge')).toBe(false)
      expect(isEdgeType(null)).toBe(false)
      expect(isEdgeType(42)).toBe(false)
    })

    it('isLinkEndpointKind accepts schema kinds incl. workspace + doc surfaces', () => {
      expect(isLinkEndpointKind('entity')).toBe(true)
      expect(isLinkEndpointKind('workspace')).toBe(true)
      expect(isLinkEndpointKind('episode')).toBe(true)
      expect(isLinkEndpointKind('page')).toBe(true)
      expect(isLinkEndpointKind('entity_instance')).toBe(true)
      expect(isLinkEndpointKind('contact')).toBe(false)
      expect(isLinkEndpointKind('')).toBe(false)
    })

    it('isEntityKind accepts the system entity kinds', () => {
      expect(ENTITY_KINDS).toEqual(['person', 'company', 'project', 'product', 'deal', 'repository'])
      expect(isEntityKind('person')).toBe(true)
      expect(isEntityKind('deal')).toBe(true)
      expect(isEntityKind('repository')).toBe(true)
      expect(isEntityKind('thing')).toBe(false)
    })

    it('exposes LINK_ENDPOINT_KINDS as a discoverable list', () => {
      expect(LINK_ENDPOINT_KINDS).toContain('entity')
      expect(LINK_ENDPOINT_KINDS).toContain('workspace')
      expect(LINK_ENDPOINT_KINDS).toContain('file')
    })
  })

  describe('validateEdge — happy paths', () => {
    it('accepts works_at: person → company', () => {
      const result = validateEdge({
        edge_type: 'works_at',
        source_kind: 'entity',
        source_entity_kind: 'person',
        target_kind: 'entity',
        target_entity_kind: 'company',
      })
      expect(result.ok).toBe(true)
    })

    it('accepts mentioned with any source endpoint kind targeting an entity', () => {
      for (const fromKind of LINK_ENDPOINT_KINDS) {
        const result = validateEdge({
          edge_type: 'mentioned',
          source_kind: fromKind,
          source_entity_kind: fromKind === 'entity' ? 'person' : undefined,
          target_kind: 'entity',
          target_entity_kind: 'company',
        })
        expect(result.ok, `mentioned should accept source_kind=${fromKind}`).toBe(true)
      }
    })

    it('accepts target_investor with audience_clearance=internal', () => {
      const result = validateEdge({
        edge_type: 'target_investor',
        source_kind: 'workspace',
        target_kind: 'entity',
        target_entity_kind: 'company',
        attributes: { audience_clearance: 'internal', preference_summary: 'long-term capital' },
      })
      expect(result.ok).toBe(true)
    })

    it('accepts documented_by: entity (product) → file with commit_sha', () => {
      const result = validateEdge({
        edge_type: 'documented_by',
        source_kind: 'entity',
        source_entity_kind: 'product',
        target_kind: 'file',
        attributes: { commit_sha: 'abc123def' },
      })
      expect(result.ok).toBe(true)
    })

    it('accepts replies_to: episode → episode', () => {
      const result = validateEdge({
        edge_type: 'replies_to',
        source_kind: 'episode',
        target_kind: 'episode',
      })
      expect(result.ok).toBe(true)
    })

    it('accepts customer_since: company → workspace', () => {
      const result = validateEdge({
        edge_type: 'customer_since',
        source_kind: 'entity',
        source_entity_kind: 'company',
        target_kind: 'workspace',
        attributes: { since: '2026-Q1' },
      })
      expect(result.ok).toBe(true)
    })

    it('accepts detail_page_of: page → entity', () => {
      const result = validateEdge({
        edge_type: 'detail_page_of',
        source_kind: 'page',
        target_kind: 'entity',
        target_entity_kind: 'company',
      })
      expect(result.ok).toBe(true)
    })

    it('accepts detail_page_of: page → task and page → entity_instance', () => {
      expect(
        validateEdge({ edge_type: 'detail_page_of', source_kind: 'page', target_kind: 'task' }).ok,
      ).toBe(true)
      expect(
        validateEdge({
          edge_type: 'detail_page_of',
          source_kind: 'page',
          target_kind: 'entity_instance',
        }).ok,
      ).toBe(true)
    })
  })

  describe('validateEdge — failure paths', () => {
    it('rejects an unknown edge_type', () => {
      const result = validateEdge({
        edge_type: 'never_added' as EdgeType,
        source_kind: 'entity',
        source_entity_kind: 'person',
        target_kind: 'entity',
        target_entity_kind: 'company',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/unknown edge_type/)
    })

    it('rejects works_at when source entity kind is wrong (company instead of person)', () => {
      const result = validateEdge({
        edge_type: 'works_at',
        source_kind: 'entity',
        source_entity_kind: 'company',
        target_kind: 'entity',
        target_entity_kind: 'company',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/source_entity_kind/)
    })

    it('rejects detail_page_of from a non-page source', () => {
      const result = validateEdge({
        edge_type: 'detail_page_of',
        source_kind: 'entity',
        source_entity_kind: 'company',
        target_kind: 'task',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/source_kind/)
    })

    it('rejects works_at when target_kind is not entity', () => {
      const result = validateEdge({
        edge_type: 'works_at',
        source_kind: 'entity',
        source_entity_kind: 'person',
        target_kind: 'file',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/target_kind/)
    })

    it('requires source_entity_kind when the edge constrains it and source_kind=entity', () => {
      const result = validateEdge({
        edge_type: 'works_at',
        source_kind: 'entity',
        target_kind: 'entity',
        target_entity_kind: 'company',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/source_entity_kind required/)
    })

    it('rejects target_investor with an unknown audience_clearance value', () => {
      const result = validateEdge({
        edge_type: 'target_investor',
        source_kind: 'workspace',
        target_kind: 'entity',
        target_entity_kind: 'company',
        attributes: {
          // bypass the discriminated-attribute type to simulate a runtime payload
          audience_clearance: 'secret',
        } as unknown as EdgeAttributesFor<'target_investor'>,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/audience_clearance/)
    })

    it('rejects target_investor with an unknown attribute key', () => {
      const result = validateEdge({
        edge_type: 'target_investor',
        source_kind: 'workspace',
        target_kind: 'entity',
        target_entity_kind: 'person',
        attributes: { rogue_key: 'x' } as unknown as EdgeAttributesFor<'target_investor'>,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/unknown attribute/)
    })
  })

  describe('makeEdgeInput', () => {
    it('returns the input verbatim on valid edges', () => {
      const input = makeEdgeInput({
        edge_type: 'depends_on',
        source_kind: 'task',
        source_id: 't-23',
        target_kind: 'task',
        target_id: 't-19',
      })
      expect(input.edge_type).toBe('depends_on')
      expect(input.source_id).toBe('t-23')
      expect(input.target_id).toBe('t-19')
    })

    it('throws on invalid combinations', () => {
      expect(() =>
        makeEdgeInput({
          edge_type: 'works_at',
          source_kind: 'entity',
          source_id: 'e-1',
          source_entity_kind: 'company', // wrong: must be person
          target_kind: 'entity',
          target_id: 'e-2',
          target_entity_kind: 'company',
        }),
      ).toThrow(/Invalid edge input/)
    })
  })

  describe('type-level — EdgeAttributesFor discriminates documented shapes', () => {
    it('lets target_investor attributes typecheck their fields', () => {
      // If the discriminated mapped type breaks, this file won't compile.
      const attrs: EdgeAttributesFor<'target_investor'> = {
        audience_clearance: 'public',
        preference_summary: 'b2b infra',
      }
      expect(attrs.audience_clearance).toBe('public')

      const compAttrs: EdgeAttributesFor<'target_competitor'> = { tracking_focus: 'pricing' }
      expect(compAttrs.tracking_focus).toBe('pricing')

      const docAttrs: EdgeAttributesFor<'documented_by'> = { commit_sha: 'deadbeef' }
      expect(docAttrs.commit_sha).toBe('deadbeef')
    })
  })
})
