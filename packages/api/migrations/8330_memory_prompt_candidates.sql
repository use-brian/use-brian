-- [COMP:memory/learning] Preselect the exact prompt and learning candidates before app-role RLS.
BEGIN;

CREATE INDEX idx_memories_prompt_voice_identity ON public.memories (workspace_id)
 WHERE (((scope = 'workspace' AND tags @> ARRAY['self-profile']::text[]) OR tags @> ARRAY['voice']::text[])
        AND valid_to IS NULL);

CREATE INDEX idx_memories_learning_exception ON public.memories (workspace_id)
 WHERE learning#>>'{applicability,exceptionTo}' IS NOT NULL
   AND learning->>'origin'='explicit' AND learning->>'confirmed'='true'
   AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held;

COMMIT;
