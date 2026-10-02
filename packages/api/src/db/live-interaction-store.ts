/** Owner-pool store. Callers MUST authorize capture scope before reading/writing.
 * createLiveInteractionStore(pool?) supports a pg-compatible pool for integration tests.
 * Transcript reads return latest persisted evidence and a revision cursor, never a question cutoff.
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "./client.js";
import {
  DEFAULT_INTERACTION_RULE,
  type InteractionCapture,
  type InteractionJob,
  type InteractionUtterance,
} from "@use-brian/shared";
export type Capture = InteractionCapture & {
  ownerId: string;
  ruleVersion: number;
  error?: string | null;
};
export type Pending = { text: string; endMs: number; rule: string };
export type Inbox = {
  capture: Capture;
  token: string;
  pending: Pending | null;
  cursor: string;
  utterance: InteractionUtterance;
  rule: string;
  ruleVersion: number;
};
export type TranscriptRead = {
  cursor: string;
  segments: { id: string; data: InteractionUtterance; revision: string }[];
};
export type ClaimedJob = InteractionJob & {
  token: string;
  attempts: number;
  published: boolean;
};
export function createLiveInteractionStore(
  pool?: Pick<Pool, "connect" | "query">,
) {
  const db = () => pool ?? getPool();
  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await db().connect();
    try {
      await c.query("BEGIN");
      const v = await fn(c);
      await c.query("COMMIT");
      return v;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  // Deliberately constant: neither provider diagnostics nor speech enters this field.
  const detectorError = "Could not process spoken input. Please try again or type your question.";
  async function exhaustInbox(c: PoolClient, captureId: string, cursor: string) {
    await c.query("UPDATE live_interaction_utterances SET processed=true WHERE capture_id=$1 AND cursor=$2", [captureId, cursor]);
    await c.query(
      `UPDATE live_interaction_captures SET pending=NULL,detector_token=NULL,
       detector_until=NULL,detector_retry=now(),data=data || jsonb_build_object('error',$2::text)
       WHERE id=$1`, [captureId, detectorError],
    );
  }
  const capture = async (id: string): Promise<Capture | null> =>
    (
      await db().query(
        "SELECT data FROM live_interaction_captures WHERE id=$1",
        [id],
      )
    ).rows[0]?.data ?? null;
  const job = async (id: string): Promise<InteractionJob | null> =>
    (
      await db().query(
        "SELECT data || jsonb_build_object('status',status) AS data FROM live_interaction_jobs WHERE id=$1",
        [id],
      )
    ).rows[0]?.data ?? null;
  return {
    capture,
    job,
    async settings(userId: string): Promise<{ rule: string; version: number }> {
      return (
        (
          await db().query(
            "SELECT rule,version FROM live_interaction_settings WHERE user_id=$1",
            [userId],
          )
        ).rows[0] ?? { rule: DEFAULT_INTERACTION_RULE, version: 1 }
      );
    },
    async saveSettings(userId: string, rule: string) {
      await db().query(
        `INSERT INTO
          live_interaction_settings (user_id, rule)
        VALUES
          ($1, $2)
        ON CONFLICT (user_id) DO UPDATE
        SET
          rule = $2,
          version = live_interaction_settings.version + 1`,
        [userId, rule],
      );
      return { rule };
    },
    async create(c: Capture) {
      await db().query(
        `INSERT INTO
          live_interaction_captures (id, owner_id, workspace_id, page_id, chat_session_id, assistant_id, data)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)`,
        [
          c.id,
          c.ownerId,
          c.workspaceId,
          c.pageId,
          c.chatSessionId,
          c.assistantId,
          c,
        ],
      );
      return c;
    },
    async stop(id: string) {
      await db().query(
        `UPDATE live_interaction_captures SET data=jsonb_set(data,'{state}','"stopped"') WHERE id=$1`,
        [id],
      );
    },
    async ingest(id: string, u: InteractionUtterance) {
      return tx(async (c) => {
        const r = (
          await c.query(
            "SELECT * FROM live_interaction_captures WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (
          r &&
          (
            await c.query(
              "SELECT 1 FROM live_interaction_utterances WHERE capture_id=$1 AND id=$2",
              [id, u.id],
            )
          ).rowCount
        )
          return;
        if (!r || r.data.state !== "listening")
          throw Object.assign(new Error("Capture stopped"), { status: 409 });
        const s = (
          await c.query(
            "SELECT rule,version FROM live_interaction_settings WHERE user_id=$1",
            [r.owner_id],
          )
        ).rows[0];
        await c.query(
          `INSERT INTO
            live_interaction_utterances (capture_id, id, source, previous_id, data, rule, rule_version)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (capture_id, id) DO NOTHING`,
          [
            id,
            u.id,
            u.source,
            u.previousId ?? null,
            u,
            s?.rule ?? r.data.rule,
            s?.version ?? r.data.ruleVersion,
          ],
        );
      });
    },
    /** Explicit controls are serialized with detector commits. Synthetic occurrences
     * use a JSON source marker (the SQL source column remains ASR-compatible).
     * A repeated request is a no-op, including cancellation, across restarts. */
    async question(id: string, request: { id: string; action: "submit" | "cancel"; text?: string }) {
      return tx(async (c) => {
        const r = (await c.query(
          "SELECT * FROM live_interaction_captures WHERE id=$1 FOR UPDATE", [id],
        )).rows[0];
        if (!r) throw Object.assign(new Error("Capture unavailable"), { status: 409 });
        const occurrenceId = `manual:${request.id}`;
        const inserted = await c.query(
          `INSERT INTO live_interaction_utterances
            (capture_id,id,source,data,rule,rule_version,processed)
           VALUES ($1,$2,'system',$3,$4,$5,true)
           ON CONFLICT (capture_id,id) DO NOTHING RETURNING cursor`,
          [id, occurrenceId, { id: occurrenceId, source: "manual", action: request.action,
            text: request.text ?? "", startMs: 0, endMs: 0 }, r.data.rule, r.data.ruleVersion],
        );
        if (!inserted.rowCount) return;
        // Clear the pre-control detector backlog and invalidate its lease. Speech
        // evidence remains readable; already accepted jobs are never touched.
        await c.query("UPDATE live_interaction_utterances SET processed=true WHERE capture_id=$1 AND NOT processed", [id]);
        await c.query("UPDATE live_interaction_captures SET pending=NULL,detector_token=NULL,detector_until=NULL,detector_retry=now(),data=data - 'error' WHERE id=$1", [id]);
        if (request.action === "cancel") return;
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [r.workspace_id]);
        const count = (await c.query(
          `SELECT count(*)::int AS n FROM live_interaction_jobs j
           JOIN live_interaction_captures c ON c.id=j.capture_id
           WHERE c.workspace_id=$1 AND j.status IN ('queued','running')`, [r.workspace_id],
        )).rows[0].n;
        const cursor = String(inserted.rows[0].cursor);
        const j = {
          id: randomUUID(), captureId: id, chatSessionId: r.data.chatSessionId,
          pageId: r.data.pageId, question: request.text!, answer: "",
          error: count >= 100 ? "Interaction queue full" : null,
          status: count >= 100 ? "failed" : "queued", createdAt: new Date().toISOString(),
          userMessageId: randomUUID(), assistantMessageId: randomUUID(),
          rule: r.data.rule, ruleVersion: r.data.ruleVersion, questionCursor: cursor,
          source: "manual", sourceUtteranceId: occurrenceId,
        };
        await c.query(
          `INSERT INTO live_interaction_jobs (id,capture_id,occurrence,data,status)
           VALUES ($1,$2,$3,$4,$5)`, [j.id,id,cursor,j,j.status],
        );
      });
    },
    async claimInbox(): Promise<Inbox | null> {
      return tx(async (c) => {
        const r = (
          await c.query(
            `SELECT
              c.*
            FROM
              live_interaction_captures c
            WHERE
              (
                detector_until IS NULL
                OR detector_until < now()
              )
              AND detector_retry <= now()
              AND EXISTS (
                SELECT
                  1
                FROM
                  live_interaction_utterances u
                WHERE
                  u.capture_id = c.id
                  AND NOT u.processed
              )
            ORDER BY
              detector_retry
            FOR UPDATE
              SKIP LOCKED
            LIMIT
              1`,
          )
        ).rows[0];
        if (!r) return null;
        const u = (
          await c.query(
            `SELECT
              *,
              (
                previous_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT
                    1
                  FROM
                    live_interaction_utterances p
                  WHERE
                    p.capture_id = u.capture_id
                    AND p.id = u.previous_id
                )
              ) AS gap
            FROM
              live_interaction_utterances u
            WHERE
              capture_id = $1
              AND NOT processed
              AND (
                previous_id IS NULL
                OR (
                  created_at < now() - interval '5 seconds'
                  AND NOT EXISTS (
                    SELECT
                      1
                    FROM
                      live_interaction_utterances p
                    WHERE
                      p.capture_id = u.capture_id
                      AND p.id = u.previous_id
                  )
                )
                OR EXISTS (
                  SELECT
                    1
                  FROM
                    live_interaction_utterances p
                  WHERE
                    p.capture_id = u.capture_id
                    AND p.id = u.previous_id
                    AND p.processed
                )
              )
            ORDER BY
              (data ->> 'startMs')::bigint,
              cursor
            LIMIT
              1`,
            [r.id],
          )
        ).rows[0];
        if (!u) {
          await c.query(
            "UPDATE live_interaction_captures SET detector_retry=now()+interval '1 second' WHERE id=$1",
            [r.id],
          );
          return null;
        }
        // A crashed/expired worker also consumes an attempt. Never evaluate a fourth time.
        if (u.detector_attempts >= 3) {
          await exhaustInbox(c, r.id, String(u.cursor));
          return null;
        }
        await c.query("UPDATE live_interaction_utterances SET detector_attempts=detector_attempts+1 WHERE cursor=$1", [u.cursor]);
        const token = randomUUID();
        await c.query(
          `UPDATE live_interaction_captures
          SET
            detector_token = $2,
            detector_until = now() + interval '30 seconds'
          WHERE
            id = $1`,
          [r.id, token],
        );
        return {
          capture: r.data,
          token,
          pending: u.gap || u.data.discontinuity === true ? null : r.pending,
          cursor: String(u.cursor),
          utterance: u.data,
          rule: u.rule,
          ruleVersion: u.rule_version,
        };
      });
    },
    async finishInbox(
      i: Inbox,
      pending: Pending | null,
      question?: string | string[],
      clearError = i.utterance.source === "microphone",
    ) {
      return tx(async (c) => {
        const locked = await c.query(
          `SELECT
            id
          FROM
            live_interaction_captures
          WHERE
            id = $1
            AND detector_token = $2
            AND detector_until > now()
          FOR UPDATE`,
          [i.capture.id, i.token],
        );
        if (!locked.rowCount) return false;
        const questions = Array.isArray(question)
          ? question
          : question
            ? [question]
            : [];
        for (const [occurrenceIndex, question] of questions.entries()) {
          // Workspace lock serializes queue admission and manual retries across processes.
          await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            i.capture.workspaceId,
          ]);
          const count = (
            await c.query(
              `SELECT
                count(*)::int AS n
              FROM
                live_interaction_jobs j
                JOIN live_interaction_captures c ON c.id = j.capture_id
              WHERE
                c.workspace_id = $1
                AND j.status IN ('queued', 'running')`,
              [i.capture.workspaceId],
            )
          ).rows[0].n;
          const j = {
            id: randomUUID(),
            captureId: i.capture.id,
            chatSessionId: i.capture.chatSessionId,
            pageId: i.capture.pageId,
            question,
            answer: "",
            error: count >= 100 ? "Interaction queue full" : null,
            status: count >= 100 ? "failed" : "queued",
            createdAt: new Date().toISOString(),
            userMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
            rule: i.rule,
            ruleVersion: i.ruleVersion,
            questionCursor: i.cursor,
            originalSpeech: i.utterance.text,
            sourceUtteranceId: i.utterance.id,
            startMs: i.utterance.startMs,
            endMs: i.utterance.endMs,
          };
          await c.query(
            `INSERT INTO
              live_interaction_jobs (id, capture_id, occurrence, data, status, occurrence_index)
            VALUES
              ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (capture_id, occurrence, occurrence_index) DO NOTHING`,
            [j.id, j.captureId, i.cursor, j, j.status, occurrenceIndex],
          );
        }
        await c.query(
          "UPDATE live_interaction_utterances SET processed=true WHERE cursor=$1",
          [i.cursor],
        );
        await c.query(
          "UPDATE live_interaction_captures SET pending=$2,detector_token=NULL,detector_until=NULL,data=CASE WHEN $3 THEN data - 'error' ELSE data END WHERE id=$1",
          [i.capture.id, pending, clearError],
        );
        return true;
      });
    },
    async releaseInbox(i: Inbox) {
      return tx(async (c) => {
        const locked = await c.query(
          `SELECT id FROM live_interaction_captures WHERE id=$1 AND detector_token=$2
           AND detector_until > now() FOR UPDATE`, [i.capture.id, i.token],
        );
        if (!locked.rowCount) return false;
        const u = (await c.query(
          "SELECT detector_attempts FROM live_interaction_utterances WHERE capture_id=$1 AND cursor=$2 AND NOT processed",
          [i.capture.id, i.cursor],
        )).rows[0];
        if (!u) return false;
        if (u.detector_attempts >= 3) await exhaustInbox(c, i.capture.id, i.cursor);
        else await c.query(
          `UPDATE live_interaction_captures SET detector_until=NULL,detector_token=NULL,
           detector_retry=now()+interval '2 seconds' WHERE id=$1`, [i.capture.id],
        );
        return true;
      });
    },
    async listCaptureErrors(owner: string, workspace: string, chat: string): Promise<{ captureId: string; error: string }[]> {
      return (await db().query(
        `SELECT id AS "captureId", data->>'error' AS error FROM live_interaction_captures
         WHERE owner_id=$1 AND workspace_id=$2 AND chat_session_id=$3
           AND jsonb_typeof(data->'error')='string'`, [owner, workspace, chat],
      )).rows;
    },
    async listJobs(
      owner: string,
      workspace: string,
      chat: string,
    ): Promise<InteractionJob[]> {
      return (
        await db().query(
          `SELECT
            j.data || jsonb_build_object('status', j.status) AS data
          FROM
            live_interaction_jobs j
            JOIN live_interaction_captures c ON c.id = j.capture_id
          WHERE
            c.owner_id = $1
            AND c.workspace_id = $2
            AND c.chat_session_id = $3
          ORDER BY
            j.created_at DESC
          LIMIT
            100`,
          [owner, workspace, chat],
        )
      ).rows.map((r) => r.data);
    },
    async claimJob(workspaceLimit = 12): Promise<ClaimedJob | null> {
      return tx(async (c) => {
        // Global queue mutex is held only for short DB operations; no model calls in transactions.
        await c.query("SELECT pg_advisory_xact_lock(650,1)");
        await c.query(
          `UPDATE live_interaction_jobs
          SET
            status = CASE
              WHEN attempts >= 3 THEN 'failed'
              ELSE 'queued'
            END,
            data = CASE WHEN status = 'completed' THEN data || '{"answerCompleted":true}'::jsonb ELSE data END,
            token = NULL,
            lease_until = NULL
          WHERE
            (status = 'running' OR (status = 'completed' AND NOT published AND attempts >= 3))
            AND lease_until < now()`,
        );
        const r = (
          await c.query(
            `SELECT j.*
            FROM live_interaction_jobs j
            JOIN live_interaction_captures c ON c.id = j.capture_id
            WHERE (j.status = 'queued' OR (j.status = 'completed' AND NOT j.published))
              AND j.available_at <= now()
              AND (j.lease_until IS NULL OR j.lease_until < now())
              AND (SELECT count(*) FROM live_interaction_jobs active
                   WHERE active.capture_id = j.capture_id AND active.lease_until > now()) < 3
              AND (SELECT count(*) FROM live_interaction_jobs active
                   JOIN live_interaction_captures ac ON ac.id = active.capture_id
                   WHERE ac.workspace_id = c.workspace_id AND active.lease_until > now()) < $1
            ORDER BY j.created_at
            LIMIT 1
            FOR UPDATE OF j SKIP LOCKED`,
            [workspaceLimit],
          )
        ).rows[0];
        if (r) {
          const token = randomUUID();
          const updated = (
            await c.query(
              `UPDATE live_interaction_jobs
              SET
                data = CASE
                  WHEN status = 'queued' THEN data || '{"answer":"","error":null}'::jsonb
                  ELSE data
                END,
                status = CASE
                  WHEN status = 'completed' THEN status
                  ELSE 'running'
                END,
                attempts = attempts + 1,
                token = $2,
                lease_until = now() + interval '30 seconds'
              WHERE
                id = $1
              RETURNING
                *`,
              [r.id, token],
            )
          ).rows[0];
          return {
            ...updated.data,
            status: updated.status,
            token,
            attempts: updated.attempts,
            published: updated.published,
          };
        }
        return null;
      });
    },
    async heartbeat(id: string, token: string) {
      return !!(
        await db().query(
          `UPDATE live_interaction_jobs
          SET
            lease_until = now() + interval '30 seconds'
          WHERE
            id = $1
            AND token = $2
            AND lease_until > now()
            AND status IN ('running', 'completed')`,
          [id, token],
        )
      ).rowCount;
    },
    async text(id: string, token: string, answer: string) {
      return !!(
        await db().query(
          `UPDATE live_interaction_jobs
          SET
            data = jsonb_set(data, '{answer}', to_jsonb($3::text))
          WHERE
            id = $1
            AND token = $2
            AND status = 'running'
            AND lease_until > now()`,
          [id, token, answer],
        )
      ).rowCount;
    },
    async complete(id: string, token: string, answer: string) {
      return !!(
        await db().query(
          `UPDATE live_interaction_jobs
          SET
            status = 'completed',
            data = jsonb_set(data, '{answer}', to_jsonb($3::text)) || '{"error":null,"answerCompleted":true}'::jsonb
          WHERE
            id = $1
            AND token = $2
            AND status = 'running'
            AND lease_until > now()`,
          [id, token, answer],
        )
      ).rowCount;
    },
    async published(id: string, token: string) {
      await db().query(
        `UPDATE live_interaction_jobs
        SET
          published = TRUE,
          token = NULL,
          lease_until = NULL
        WHERE
          id = $1
          AND token = $2
          AND status = 'completed'
          AND lease_until > now()`,
        [id, token],
      );
    },
    async fail(id: string, token: string, error: string) {
      await db().query(
        `UPDATE live_interaction_jobs
        SET
          status = CASE
            WHEN attempts >= 3 THEN 'failed'
            WHEN status = 'completed' THEN status
            ELSE 'queued'
          END,
          data = jsonb_set(data, '{error}', to_jsonb($3::text)) ||
            CASE WHEN status = 'completed' THEN '{"answerCompleted":true}'::jsonb ELSE '{}'::jsonb END,
          token = NULL,
          lease_until = NULL,
          available_at = now() + interval '2 seconds'
        WHERE
          id = $1
          AND token = $2
          AND lease_until > now()`,
        [id, token, error.slice(0, 1000)],
      );
    },
    async cancel(id: string) {
      await db().query(
        `UPDATE live_interaction_jobs
        SET
          status = 'cancelled',
          data = CASE WHEN status = 'completed' THEN data || '{"answerCompleted":true}'::jsonb ELSE data END,
          token = NULL,
          lease_until = NULL
        WHERE
          id = $1
          AND (status IN ('queued', 'running', 'failed') OR (status = 'completed' AND NOT published))`,
        [id],
      );
    },
    async retry(id: string) {
      await tx(async (c) => {
        const capture = (
          await c.query(
            `SELECT
              c.workspace_id
            FROM
              live_interaction_jobs j
              JOIN live_interaction_captures c ON c.id = j.capture_id
            WHERE
              j.id = $1`,
            [id],
          )
        ).rows[0];
        if (!capture) return;
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          capture.workspace_id,
        ]);
        const count = (
          await c.query(
            `SELECT
              count(*)::int AS n
            FROM
              live_interaction_jobs j
              JOIN live_interaction_captures c ON c.id = j.capture_id
            WHERE
              c.workspace_id = $1
              AND j.status IN ('queued', 'running')`,
            [capture.workspace_id],
          )
        ).rows[0].n;
        if (count >= 100)
          throw Object.assign(new Error("Interaction queue full"), {
            status: 409,
          });
        await c.query(
          `UPDATE live_interaction_jobs
          SET
            status = CASE WHEN data @> '{"answerCompleted":true}'::jsonb THEN 'completed' ELSE 'queued' END,
            attempts = 0,
            token = NULL,
            lease_until = NULL,
            available_at = now(),
            data = CASE WHEN data @> '{"answerCompleted":true}'::jsonb
              THEN data || '{"error":null}'::jsonb
              ELSE data || '{"answer":"","error":null}'::jsonb END
          WHERE
            id = $1
            AND status IN ('failed', 'cancelled')`,
          [id],
        );
      });
    },
    async listUtterances(
      captureId: string,
    ): Promise<(InteractionUtterance & { revision: string })[]> {
      return (
        await db().query(
          `SELECT
            data || jsonb_build_object('revision', cursor::text) AS data
          FROM
            (
              SELECT
                *
              FROM
                live_interaction_utterances
              WHERE
                capture_id = $1
                AND data ->> 'source' <> 'manual'
              ORDER BY
                cursor DESC
              LIMIT
                10000
            ) tail
          ORDER BY
            cursor`,
          [captureId],
        )
      ).rows.map((r) => r.data);
    },
    async readLiveTranscriptRange(
      captureId: string,
      options: {
        afterCursor?: string;
        startMs?: number;
        endMs?: number;
        limit?: number;
      } = {},
    ): Promise<TranscriptRead> {
      const r = await db().query(
        `WITH
          revision AS (
            SELECT
              coalesce(max(cursor), 0)::text AS cursor
            FROM
              live_interaction_utterances
            WHERE
              capture_id = $1
                AND data ->> 'source' <> 'manual'
          )
        SELECT
          revision.cursor,
          coalesce(
            (
              SELECT
                jsonb_agg(x)
              FROM
                (
                  SELECT
                    id,
                    data,
                    cursor::text AS revision
                  FROM
                    live_interaction_utterances
                  WHERE
                    capture_id = $1
                AND data ->> 'source' <> 'manual'
                    AND cursor > $2::bigint
                    AND (data ->> 'endMs')::bigint >= $3
                    AND (data ->> 'startMs')::bigint <= $4
                  ORDER BY
                    cursor
                  LIMIT
                    $5
                ) x
            ),
            '[]'
          ) AS segments
        FROM
          revision`,
        [
          captureId,
          options.afterCursor ?? "0",
          options.startMs ?? 0,
          options.endMs ?? Number.MAX_SAFE_INTEGER,
          Math.min(200, Math.max(1, options.limit ?? 100)),
        ],
      );
      return r.rows[0];
    },
    async searchLiveTranscript(
      captureId: string,
      text: string,
      limit = 30,
    ): Promise<TranscriptRead> {
      const r = await db().query(
        `SELECT
          coalesce(max(cursor), 0)::text AS cursor,
          coalesce(
            jsonb_agg(jsonb_build_object('id', id, 'data', data, 'revision', cursor::text)) FILTER (
              WHERE
                matched
            ),
            '[]'
          ) AS segments
        FROM
          (
            SELECT
              *,
              position(lower($2) IN lower(data ->> 'text')) > 0
              AND row_number() OVER (
                PARTITION BY
                  (position(lower($2) IN lower(data ->> 'text')) > 0)
                ORDER BY
                  cursor DESC
              ) <= $3 AS matched
            FROM
              live_interaction_utterances
            WHERE
              capture_id = $1
                AND data ->> 'source' <> 'manual'
          ) s`,
        [captureId, text.slice(0, 1000), Math.min(100, Math.max(1, limit))],
      );
      return r.rows[0];
    },
  };
}
export type LiveInteractionStore = ReturnType<
  typeof createLiveInteractionStore
>;
