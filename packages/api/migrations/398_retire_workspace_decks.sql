-- Retire the legacy DeckSpec relation after the canonical Office Presentation
-- surface has replaced it. Blob deletion is deliberately deferred: candidates
-- are queued for a production worker/operator that must recheck every live
-- workspace_files reference immediately before deleting storage bytes.

BEGIN;

CREATE TABLE workspace_file_cleanup_queue (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id                   UUID NOT NULL REFERENCES workspace_files(id) ON DELETE CASCADE,
  reason                    TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','deleted','retained','failed')),
  eligible_at               TIMESTAMPTZ NOT NULL,
  requires_reference_recheck BOOLEAN NOT NULL DEFAULT TRUE,
  metadata                  JSONB NOT NULL DEFAULT '{}',
  attempt                   INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  last_error                TEXT,
  claimed_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id, reason)
);

CREATE INDEX idx_workspace_file_cleanup_queue_claim
  ON workspace_file_cleanup_queue (eligible_at, created_at)
  WHERE status = 'queued';

ALTER TABLE workspace_file_cleanup_queue ENABLE ROW LEVEL SECURITY;

-- No member policy: this is an internal cleanup ledger, not a user-facing
-- deletion API. The later deletion worker must operate as the trusted system
-- role and revalidate references before it mutates workspace_files or storage.
INSERT INTO workspace_file_cleanup_queue (
  workspace_id,
  file_id,
  reason,
  eligible_at,
  requires_reference_recheck,
  metadata
)
SELECT
  deck.workspace_id,
  file.id,
  'legacy_workspace_deck_binary',
  now() + interval '30 days',
  TRUE,
  jsonb_build_object(
    'legacyDeckId', deck.id,
    'legacyPath', deck.file_path,
    'legacyVersion', deck.version,
    'retiredAt', now()
  )
FROM workspace_decks deck
JOIN workspace_files file
  ON file.workspace_id = deck.workspace_id
 AND ltrim(file.path, '/') = ltrim(deck.file_path, '/')
ON CONFLICT (file_id, reason) DO NOTHING;

DROP TABLE workspace_decks;

COMMIT;
