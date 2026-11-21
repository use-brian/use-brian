-- migration: concurrent-index
-- [COMP:files/prompt-context] Traverse the ranked operational catalog in recency order.
CREATE INDEX CONCURRENTLY idx_wf_prompt_catalog_updated ON public.workspace_files USING btree (workspace_id, updated_at DESC)
WHERE ((purpose = 'operational'::text) AND (valid_to IS NULL)
 AND ((path !~~ '/doc/%'::text) OR ((upload_identity IS NOT NULL) AND (source_episode_id IS NOT NULL)))
 AND (path !~~ '/apps/%'::text) AND (path !~~ '/office/sessions/%'::text)
 AND ((metadata ->> 'noIndex'::text) IS DISTINCT FROM 'true'::text));
