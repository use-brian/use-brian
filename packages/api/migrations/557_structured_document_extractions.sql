-- Internal actor-owned extraction state. Content stays in Files. No triggers.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_files_workspace_id_id_extraction ON workspace_files(workspace_id,id);
CREATE TABLE structured_document_extractions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 source_file_id uuid NOT NULL,
 pdf_sha256 text NOT NULL CHECK(pdf_sha256 ~ '^[a-f0-9]{64}$'),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','queued','submitting','running','archiving','completed','failed','cancelled')),
 remote_job_id text CHECK(length(remote_job_id) BETWEEN 1 AND 200),
 records_file_id uuid,
 records_sha256 text CHECK(records_sha256 ~ '^[a-f0-9]{64}$'),
 document_id text,
 image_files jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(image_files)='array' AND jsonb_array_length(image_files)<=10),
 page_numbers jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(page_numbers)='array' AND jsonb_array_length(page_numbers)<=10),
 archived_bytes integer NOT NULL DEFAULT 0 CHECK(archived_bytes BETWEEN 0 AND 134217728),
 error_code text CHECK(error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
 lease_token uuid,
 lease_expires_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,source_file_id) REFERENCES workspace_files(workspace_id,id),
 FOREIGN KEY(workspace_id,records_file_id) REFERENCES workspace_files(workspace_id,id),
 FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE,
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CHECK(status NOT IN ('running','archiving','completed') OR remote_job_id IS NOT NULL),
 CHECK(status <> 'completed' OR (records_file_id IS NOT NULL AND records_sha256 IS NOT NULL AND document_id IS NOT NULL AND jsonb_array_length(page_numbers)>0 AND jsonb_array_length(image_files)=jsonb_array_length(page_numbers)))
);
CREATE INDEX structured_extractions_actor_queue ON structured_document_extractions(user_id,next_attempt_at,created_at) WHERE status IN ('queued','submitting','running','archiving');
CREATE INDEX structured_extractions_workspace_actor ON structured_document_extractions(workspace_id,user_id);
ALTER TABLE structured_document_extractions ENABLE ROW LEVEL SECURITY;
-- Deliberately not FORCE: like Office generation, the trusted table-owner/system
-- pool discovers pending actors without an actor GUC. Non-owner app roles remain
-- subject to actor/member RLS; store predicates and service authorization still
-- scope all actor operations (including calls made through the owner pool).
CREATE POLICY structured_extractions_actor ON structured_document_extractions
 USING (user_id = nullif(current_setting('app.current_user_id',true),'')::uuid AND EXISTS (
 SELECT 1 FROM workspace_members m WHERE m.workspace_id=structured_document_extractions.workspace_id AND m.user_id=structured_document_extractions.user_id))
 WITH CHECK (user_id = nullif(current_setting('app.current_user_id',true),'')::uuid AND EXISTS (
 SELECT 1 FROM workspace_members m WHERE m.workspace_id=structured_document_extractions.workspace_id AND m.user_id=structured_document_extractions.user_id));
-- Composite references keep lineage within the initiating actor/workspace.
CREATE UNIQUE INDEX structured_extractions_scope_id ON structured_document_extractions(workspace_id,user_id,id);
CREATE UNIQUE INDEX office_artifacts_structured_scope_id ON office_artifacts(workspace_id,id);
CREATE UNIQUE INDEX office_versions_structured_artifact_id ON office_artifact_versions(artifact_id,id);
CREATE UNIQUE INDEX office_suggestions_structured_scope_id ON office_suggestions(workspace_id,artifact_id,id);
CREATE UNIQUE INDEX office_threads_structured_scope_id ON office_comment_threads(workspace_id,artifact_id,id);
CREATE TABLE structured_document_fill_proposals (
 id uuid PRIMARY KEY,
 thread_id uuid NOT NULL UNIQUE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 artifact_id uuid NOT NULL,
 base_version_id uuid NOT NULL,
 expected_seq bigint NOT NULL CHECK(expected_seq > 0),
 extraction_id uuid NOT NULL,
 evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 assistant_id uuid REFERENCES assistants(id) ON DELETE SET NULL,
 command jsonb NOT NULL,
 preview jsonb NOT NULL,
 lineage jsonb NOT NULL,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),
 target_ids uuid[] NOT NULL CHECK(cardinality(target_ids) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,workspace_id,extraction_id,artifact_id,evidence_hash),
 FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,user_id,extraction_id) REFERENCES structured_document_extractions(workspace_id,user_id,id),
 FOREIGN KEY(workspace_id,artifact_id) REFERENCES office_artifacts(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(artifact_id,base_version_id) REFERENCES office_artifact_versions(artifact_id,id),
 -- The reservation is inserted before its Office rows in the same statement.
 FOREIGN KEY(workspace_id,artifact_id,id) REFERENCES office_suggestions(workspace_id,artifact_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id,artifact_id,thread_id) REFERENCES office_comment_threads(workspace_id,artifact_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE structured_document_fill_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE structured_document_fill_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY structured_fill_actor ON structured_document_fill_proposals
 USING (user_id = nullif(current_setting('app.current_user_id',true),'')::uuid AND EXISTS (
 SELECT 1 FROM workspace_members m WHERE m.workspace_id=structured_document_fill_proposals.workspace_id AND m.user_id=structured_document_fill_proposals.user_id))
 WITH CHECK (user_id = nullif(current_setting('app.current_user_id',true),'')::uuid AND EXISTS (
 SELECT 1 FROM workspace_members m WHERE m.workspace_id=structured_document_fill_proposals.workspace_id AND m.user_id=structured_document_fill_proposals.user_id));
COMMIT;
