import type {
  MarkUsefulData,
  MarkUsefulInput,
  MarkUsefulPrimitive,
  RetrievalActor,
  RetrievalEnvelope,
  RetrievalStore,
} from '@use-brian/core'
import { queryWithRLS } from './client.js'

/**
 * `mark-useful-store.ts` — WS-5 / WU-5.8.
 *
 * Implements `RetrievalStore.markUseful(actor, { row_id, primitive })`.
 * Records the CL-7 raw-retrieval usefulness signal per
 * `docs/architecture/brain/retrieval-layer.md`. Idempotent — repeat calls
 * just bump the counter.
 *
 * Storage today: `memories.useful_recall_count` (mig 027) and
 * `kb_chunks.useful_recall_count` (mig 132) are the only primitives
 * with the column. For `entity`, `edge`, and `task` the signal is
 * accepted silently — the contract is honored (`success: true`) so the
 * model can keep emitting feedback while the columns are added in a
 * follow-up migration. The store never throws on unsupported primitives.
 *
 * Permission model: `queryWithRLS` scopes the UPDATE to rows the
 * acting user can see. A row outside the workspace or above clearance
 * silently affects zero rows and returns `success: false`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TABLE_BY_PRIMITIVE: Partial<Record<MarkUsefulPrimitive, string>> = {
  memory: 'memories',
  kb_chunk: 'kb_chunks',
}

async function bumpUsefulCount(
  actor: RetrievalActor,
  table: string,
  rowId: string,
): Promise<boolean> {
  const result = await queryWithRLS(
    actor.userId,
    `UPDATE ${table}
        SET useful_recall_count = useful_recall_count + 1,
            last_recalled_at    = now()
      WHERE id = $1
        AND workspace_id = $2`,
    [rowId, actor.workspaceId],
  )
  return (result.rowCount ?? 0) > 0
}

function buildEnvelope(success: boolean): RetrievalEnvelope<MarkUsefulData> {
  return {
    api_version: 'v1',
    data: { success },
    meta: {
      retrieved_at: new Date().toISOString(),
      truncated: false,
    },
  }
}

export function createDbMarkUsefulStore(): Pick<RetrievalStore, 'markUseful'> {
  return {
    async markUseful(
      actor: RetrievalActor,
      input: MarkUsefulInput,
    ): Promise<RetrievalEnvelope<MarkUsefulData>> {
      if (!UUID_RE.test(input.row_id)) {
        return buildEnvelope(false)
      }
      const table = TABLE_BY_PRIMITIVE[input.primitive]
      if (!table) {
        // entity / edge / task — no counter column yet (see header).
        // Accept the signal so the model's tool-call doesn't error.
        return buildEnvelope(true)
      }
      const ok = await bumpUsefulCount(actor, table, input.row_id)
      return buildEnvelope(ok)
    },
  }
}
