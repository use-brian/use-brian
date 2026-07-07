/**
 * Golden-set evaluation for the v2 classifier (Q6 of the design thread).
 *
 * For each fixture in `fixtures/classifier-golden-set.json`, runs Pipeline
 * B's extraction against the content using a real Gemini call and asserts
 * the resulting structured output matches the hand-labelled expectations:
 *
 *   - entity_kinds        — every listed kind must appear at least once
 *                           in the entities/CRM writes.
 *   - entity_names_substr — every listed name substring must appear
 *                           (case-insensitive) in some emitted entity.
 *   - task_text_substr    — every listed substring must appear (CI) in
 *                           some emitted task.
 *   - memory_count_max    — the count of memory writes must NOT exceed
 *                           this. Acts as the over-classification guard:
 *                           if fixture expects "memory should be 0" the
 *                           v2 prompt must route content elsewhere.
 *   - ephemeral_count_min — at least this many items must land in
 *                           `ephemeral` (proof the LLM uses the slot).
 *
 * The suite is integration-grade: it requires `GEMINI_API_KEY` and skips
 * silently without it. It also skips fixtures whose `content` is empty
 * (the placeholder entry in the seed file) — so the suite is a no-op
 * until a human hand-fills the golden set via
 * `pnpm tsx packages/api/scripts/dump-classifier-fixtures.ts`.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGeminiProvider } from '../../providers/gemini.js'
import {
  processEpisode,
  type EpisodeUpdaterPort,
  type PipelineBDeps,
  type PipelineBEpisode,
} from '../pipeline-b.js'
import type {
  CrmStore,
  EntityStore,
  EntityLinksStore,
  LLMProvider,
  MemoryStore,
  TaskStore,
} from '../../index.js'
import type { Sensitivity } from '../../security/sensitivity.js'

type Fixture = {
  name: string
  content: string
  expected: {
    entity_kinds?: string[]
    entity_names_substr?: string[]
    task_text_substr?: string[]
    memory_count_max?: number
    /** At least this many memory writes must happen — the "true memory" tier is asserted, not just bounded. */
    memory_count_min?: number
    /** Every listed substring must appear (CI) in some emitted memory summary. */
    memory_text_substr?: string[]
    ephemeral_count_min?: number
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'classifier-golden-set.json'), 'utf-8'),
).filter((f: Fixture) => f.content && f.content.trim().length > 0)

const apiKey = process.env.GEMINI_API_KEY
const describeIf = apiKey && fixtures.length > 0 ? describe : describe.skip

describeIf('[COMP:brain/classifier-golden-set] Pipeline B v2 classifier (integration)', () => {
  const provider = createGeminiProvider(apiKey!)

  for (const fixture of fixtures) {
    it(`classifies "${fixture.name}" correctly`, async () => {
      const { result, recorded } = await runExtraction(provider, fixture.content)

      expect(result.extracted).toBe(true)

      const exp = fixture.expected
      // Self-explaining failures: every assert carries what the model
      // actually emitted, so a red run is diagnosable from the log alone.
      const got = `got ${JSON.stringify({ ...recorded, ephemeralCount: result.ephemeralCount })}`

      if (exp.entity_kinds) {
        const seenKinds = new Set(recorded.entities.map((e) => e.kind))
        for (const kind of exp.entity_kinds) {
          expect(seenKinds, `expected entity kind=${kind}; ${got}`).toContain(kind)
        }
      }

      if (exp.entity_names_substr) {
        const seenNames = recorded.entities.map((e) => e.displayName.toLowerCase())
        for (const needle of exp.entity_names_substr) {
          const found = seenNames.some((n) => n.includes(needle.toLowerCase()))
          expect(found, `expected entity name containing "${needle}"; ${got}`).toBe(true)
        }
      }

      if (exp.task_text_substr) {
        const seenTasks = recorded.tasks.map((t) => t.title.toLowerCase())
        for (const needle of exp.task_text_substr) {
          const found = seenTasks.some((t) => t.includes(needle.toLowerCase()))
          expect(found, `expected task containing "${needle}"; ${got}`).toBe(true)
        }
      }

      if (exp.memory_count_max !== undefined) {
        expect(
          recorded.memories.length,
          `expected ≤ ${exp.memory_count_max} memory writes; ${got}`,
        ).toBeLessThanOrEqual(exp.memory_count_max)
      }

      if (exp.memory_count_min !== undefined) {
        expect(
          recorded.memories.length,
          `expected ≥ ${exp.memory_count_min} memory writes; ${got}`,
        ).toBeGreaterThanOrEqual(exp.memory_count_min)
      }

      if (exp.memory_text_substr) {
        const seenMemories = recorded.memories.map((m) => m.summary.toLowerCase())
        for (const needle of exp.memory_text_substr) {
          const found = seenMemories.some((m) => m.includes(needle.toLowerCase()))
          expect(found, `expected memory containing "${needle}"; ${got}`).toBe(true)
        }
      }

      if (exp.ephemeral_count_min !== undefined) {
        expect(
          result.ephemeralCount,
          `expected ≥ ${exp.ephemeral_count_min} ephemeral items; ${got}`,
        ).toBeGreaterThanOrEqual(exp.ephemeral_count_min)
      }
    }, 30_000)
  }
})

// ── Minimal in-memory test rig ───────────────────────────────────────

type Recorded = {
  entities: { kind: string; displayName: string }[]
  tasks: { title: string }[]
  memories: { summary: string }[]
}

async function runExtraction(provider: LLMProvider, content: string) {
  const recorded: Recorded = { entities: [], tasks: [], memories: [] }

  const entities: EntityStore = {
    create: vi.fn(async (params) => {
      recorded.entities.push({ kind: params.kind, displayName: params.displayName })
      return { id: `ent-${recorded.entities.length}`, ...params, attributes: params.attributes ?? {}, canonicalId: params.canonicalId ?? null, sourceEpisodeId: null, validFrom: new Date(), validTo: null, retractedAt: null, supersededBy: null, createdByUserId: 'u', createdByAssistantId: null, createdAt: new Date(), workspaceId: 'ws', userId: null, assistantId: null, source: 'extracted', sensitivity: 'internal', verifiedAt: null, verifiedByUserId: null } as never
    }),
    // NB: findByCanonicalIdSystem returns an ARRAY (writeEntity does
    // `existing.length`). A `null` mock here crashed the write path for
    // every canonical_id-carrying entity (companies/repositories), was
    // swallowed by per-entity failure isolation, and masqueraded as the
    // model "systematically dropping companies" — 2026-07-07.
    findByCanonicalIdSystem: vi.fn(async () => []),
    findByNameSystem: vi.fn(async () => null),
    supersedeAttributes: vi.fn(async () => null),
  } as unknown as EntityStore

  const crm: CrmStore = {
    createContact: vi.fn(async (params) => {
      recorded.entities.push({ kind: 'person', displayName: params.name })
      return { id: `con-${recorded.entities.length}` } as never
    }),
    createCompany: vi.fn(async (params) => {
      recorded.entities.push({ kind: 'company', displayName: params.name })
      return { id: `co-${recorded.entities.length}` } as never
    }),
  } as unknown as CrmStore

  const tasks: TaskStore = {
    create: vi.fn(async (params) => {
      recorded.tasks.push({ title: params.title })
      return { id: `task-${recorded.tasks.length}`, title: params.title } as never
    }),
  } as unknown as TaskStore

  const memories: MemoryStore = {
    create: vi.fn(async (params) => {
      recorded.memories.push({ summary: params.summary })
      return { id: `mem-${recorded.memories.length}`, summary: params.summary } as never
    }),
  } as unknown as MemoryStore

  const entityLinks: EntityLinksStore = {
    create: vi.fn(async () => ({ id: 'link' } as never)),
  } as unknown as EntityLinksStore

  const episodes: EpisodeUpdaterPort = {
    updateCheckpoint: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
  }

  const episode: PipelineBEpisode = {
    id: 'golden-ep',
    sourceKind: 'manual_paste',
    occurredAt: new Date(),
    sensitivity: 'internal' as Sensitivity,
    workspaceId: 'ws-golden',
    userId: 'u-golden',
    assistantId: 'a-golden',
    createdByUserId: 'u-golden',
    createdByAssistantId: null,
  }

  const deps: PipelineBDeps = {
    provider,
    // Keep in lockstep with EXTRACTION_MODEL in
    // packages/api/src/build-episode-ingestors.ts — the golden set must
    // eval the model prod extraction actually runs, not a sibling tier.
    model: 'gemini-3-flash-standard',
    crm,
    entities,
    entityLinks,
    memories,
    tasks,
    episodes,
    classifierModel: null,
  }

  const result = await processEpisode(episode, content, deps)
  return { result, recorded }
}
