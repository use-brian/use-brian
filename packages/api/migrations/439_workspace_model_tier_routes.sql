-- Unify managed registry aliases and custom endpoint profiles under one
-- workspace tier-routing relation. No row means Auto; a row names exactly one
-- exact managed model or one verified custom profile.

BEGIN;

ALTER TABLE public.workspace_custom_llm_tier_defaults
  RENAME TO workspace_model_tier_routes;

ALTER TABLE public.workspace_model_tier_routes
  ALTER COLUMN profile_id DROP NOT NULL,
  ADD COLUMN model_alias text;

ALTER TABLE public.workspace_model_tier_routes
  ADD CONSTRAINT workspace_model_tier_routes_exactly_one_target
  CHECK ((profile_id IS NOT NULL)::integer + (model_alias IS NOT NULL)::integer = 1);

ALTER POLICY workspace_custom_llm_tier_defaults_member
  ON public.workspace_model_tier_routes
  RENAME TO workspace_model_tier_routes_member;

COMMIT;
