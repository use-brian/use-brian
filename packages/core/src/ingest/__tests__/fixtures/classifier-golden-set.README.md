# Classifier golden-set fixtures

This file feeds `pipeline-b.golden-set.test.ts` — the v2 classifier launch
gate (Q6 of the brain-ingestion-classification design thread).

The fixture format is a JSON array of objects. Empty array = no-op test
suite (intentional default — the suite skips when fixtures are empty
OR when `GEMINI_API_KEY` is unset).

## Schema

```ts
interface Fixture {
  /** Human-readable label shown in test output. */
  name: string

  /** The raw Episode content the LLM extracts from. */
  content: string

  expected: {
    /** Every listed entity kind must appear in the emitted entities/CRM rows. */
    entity_kinds?: ('person' | 'company' | 'project' | 'product' | 'repository')[]

    /** Every listed substring must appear (case-insensitive) in some emitted entity display_name. */
    entity_names_substr?: string[]

    /** Every listed substring must appear (case-insensitive) in some emitted task title. */
    task_text_substr?: string[]

    /** The count of memory writes must NOT exceed this. Use 0 to assert "this should NOT land as a memory". */
    memory_count_max?: number

    /** At least this many memory writes must happen — asserts the "true memory" tier positively. */
    memory_count_min?: number

    /** Every listed substring must appear (case-insensitive) in some emitted memory summary. */
    memory_text_substr?: string[]

    /** At least this many items must land in `ephemeral` (proof the LLM is using the slot). */
    ephemeral_count_min?: number
  }
}
```

## Example

```json
[
  {
    "name": "Alice CEO announcement",
    "content": "Just spoke with Alice — she's now the CEO of Hinson HQ. Schedule a Q3 sync next Tuesday.",
    "expected": {
      "entity_kinds": ["person", "company"],
      "entity_names_substr": ["alice", "hinson hq"],
      "task_text_substr": ["schedule"],
      "memory_count_max": 0
    }
  }
]
```

## Populating from real data

```bash
pnpm --filter @sidanclaw/api exec tsx scripts/dump-classifier-fixtures.ts \
  --workspace=<workspace-id> --limit=20 \
  > packages/core/src/ingest/__tests__/fixtures/classifier-golden-set.json
```

Then hand-edit each entry's `expected` block to encode the correct
classification. Run the suite with `GEMINI_API_KEY=<key> pnpm test --filter
@sidanclaw/core --run pipeline-b.golden-set.test.ts` to verify.
