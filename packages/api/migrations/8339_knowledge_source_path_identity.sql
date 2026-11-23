BEGIN;

-- Source writes take the workspace lock first. Fence running captures before
-- taking the entry and chunk schema locks and keep their checkpoints intact.
LOCK TABLE public.workspaces IN EXCLUSIVE MODE;
UPDATE public.workspace_knowledge_sources
SET sync_dirty = true, sync_run_id = NULL, sync_lease_until = NULL
WHERE NOT binding_held AND (NOT sync_dirty OR sync_run_id IS NOT NULL);

-- The old unique path identifies legacy chunks' existing entry. Capture
-- that identity before enabling same-path entries in more than one source.
ALTER TABLE public.kb_chunks
  ADD COLUMN knowledge_entry_id uuid REFERENCES public.knowledge_entries(id) ON DELETE SET NULL;
ALTER TABLE public.kb_chunks DISABLE TRIGGER set_updated_at;
UPDATE public.kb_chunks c
SET knowledge_entry_id = k.id
FROM public.knowledge_entries k
WHERE c.workspace_id = k.workspace_id AND c.source_path = k.path AND c.source <> 'doc_page';
ALTER TABLE public.kb_chunks ENABLE TRIGGER set_updated_at;
CREATE INDEX idx_kb_chunks_knowledge_entry ON public.kb_chunks (knowledge_entry_id)
  WHERE knowledge_entry_id IS NOT NULL;

ALTER TABLE public.knowledge_entries
  DROP CONSTRAINT knowledge_entries_team_path_key,
  ADD CONSTRAINT knowledge_entries_workspace_source_path_key
    UNIQUE NULLS NOT DISTINCT (workspace_id, source_id, path),
  DROP CONSTRAINT knowledge_entries_source_id_fkey,
  ADD CONSTRAINT knowledge_entries_source_id_fkey
    FOREIGN KEY (source_id) REFERENCES public.workspace_knowledge_sources(id) ON DELETE NO ACTION;

-- Preserve every other check, setting and grant on the canonical writers.
-- Each body hash identifies the immediately preceding released definition.
DO $source_path$
DECLARE
  edit record;
  original pg_proc;
  successor pg_proc;
  definition text;
  body text;
BEGIN
  FOR edit IN SELECT * FROM (VALUES
    ('apply_knowledge_source_sync_worker(jsonb,jsonb)',
     '7cce4ae089ee7dc387d0563251f2afdc7785342aba2dba69936fb28913ca2c8f',
     'WHERE workspace_id=w AND path=(p->>''path'') FOR UPDATE;',
     'WHERE workspace_id=w AND source_id=s.id AND path=(p->>''path'') FOR UPDATE;', true),
    ('admit_knowledge_repo_write(jsonb,jsonb,jsonb,uuid,text)',
     'b74001ff9668f258548255ebaa1c05bba0d0833bcec5cc55ac89601ad795e7b5',
     'WHERE workspace_id=w AND path=p->>''path'' FOR UPDATE;',
     'WHERE workspace_id=w AND source_id=s.id AND path=p->>''path'' FOR UPDATE;', false),
    ('publish_admitted_knowledge_repo_write(jsonb,jsonb,jsonb,uuid,text)',
     'b82c0c7feb0c19c81cf9dbaac3e9b2780491de23ef967df72a9b40347d420e55',
     NULL, NULL, true),
    ('apply_knowledge_source_refresh(jsonb,jsonb)',
     '0ee95c221af8e543cbb8cea71d1e107f8fb212a3c5cb74d6c518ecbf6d3cd500',
     'WHERE workspace_id=w AND path=p->>''path'' FOR UPDATE;',
     'WHERE workspace_id=w AND source_id=s.id AND path=p->>''path'' FOR UPDATE;', false)
  ) AS patch(signature, body_sha, old_lookup, new_lookup, scope_conflict_target)
  LOOP
    SELECT * INTO STRICT original FROM pg_proc
    WHERE oid = to_regprocedure('public.' || edit.signature);
    IF encode(sha256(convert_to(original.prosrc, 'UTF8')), 'hex') <> edit.body_sha THEN
      RAISE EXCEPTION 'knowledge_source_path_predecessor_changed: %', edit.signature;
    END IF;
    body := original.prosrc;
    IF edit.old_lookup IS NOT NULL THEN
      body := replace(body, edit.old_lookup, edit.new_lookup);
    END IF;
    IF edit.scope_conflict_target THEN
      body := replace(body, 'ON CONFLICT(workspace_id,path)',
        'ON CONFLICT ON CONSTRAINT knowledge_entries_workspace_source_path_key');
    END IF;
    definition := pg_get_functiondef(original.oid);
    IF body = original.prosrc OR strpos(definition, original.prosrc) = 0 THEN
      RAISE EXCEPTION 'knowledge_source_path_patch_missing: %', edit.signature;
    END IF;
    EXECUTE replace(definition, original.prosrc, body);
    SELECT * INTO STRICT successor FROM pg_proc WHERE oid = original.oid;
    IF to_jsonb(successor) IS DISTINCT FROM jsonb_set(to_jsonb(original), '{prosrc}', to_jsonb(body)) THEN
      RAISE EXCEPTION 'knowledge_source_path_function_metadata_changed: %', edit.signature;
    END IF;
  END LOOP;
END $source_path$;

COMMIT;
