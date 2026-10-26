-- Per-member navigation is not an invocation authority change.
-- [COMP:api/policy-epoch]
BEGIN;

DO $review$
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc
     WHERE oid='public.application_policy_epoch_changed()'::regprocedure)
   IS DISTINCT FROM 'd9d4b10d7b766e501a09eadfd23af22310760d40e0cb9e0e08edac31fcc06c58' THEN
  RAISE EXCEPTION 'Canonical policy epoch trigger changed before navigation repair';
 END IF;
END $review$;

CREATE OR REPLACE FUNCTION application_policy_epoch_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid; old_w uuid; before_policy jsonb; after_policy jsonb;
 defaults jsonb:='{"classification_mode":"legacy","required_enforcement_version":2,"access_mode":"departments","default_department_id":null,"setup_state":"legacy"}';
BEGIN
 IF TG_TABLE_NAME='workspace_members' AND TG_OP='UPDATE' THEN
  -- Compare every other column, including future authority metadata. Keep
  -- insertion/deletion and membership replacement revision-sensitive.
  IF (to_jsonb(OLD)-ARRAY['picker_pinned_at','picker_hidden_at','picker_last_opened_at'])
     IS NOT DISTINCT FROM
     (to_jsonb(NEW)-ARRAY['picker_pinned_at','picker_hidden_at','picker_last_opened_at']) THEN
   RETURN NULL;
  END IF;
 END IF;
 IF TG_TABLE_NAME='workspace_access_policies' THEN
  before_policy:=defaults; after_policy:=defaults;
  IF TG_OP<>'INSERT' THEN before_policy:=to_jsonb(OLD)-ARRAY['workspace_id','revision','updated_at','reviewed_inventory_revision']; END IF;
  IF TG_OP<>'DELETE' THEN after_policy:=to_jsonb(NEW)-ARRAY['workspace_id','revision','updated_at','reviewed_inventory_revision']; END IF;
  -- The old revision also tracks ordinary source holds/supersession. Only
  -- effective configuration belongs in an invocation policy epoch.
  IF before_policy IS NOT DISTINCT FROM after_policy THEN RETURN NULL; END IF;
 END IF;
 IF TG_TABLE_NAME='application_native_field_contracts' THEN
  UPDATE application_policy_contract_epoch SET revision=nextval('application_policy_revision_seq');
  RETURN NULL;
 END IF;
 IF TG_OP<>'DELETE' THEN
  w:=CASE WHEN TG_TABLE_NAME='workspaces' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'workspace_id')::uuid END;
 END IF;
 IF TG_OP<>'INSERT' THEN
  old_w:=CASE WHEN TG_TABLE_NAME='workspaces' THEN (to_jsonb(OLD)->>'id')::uuid ELSE (to_jsonb(OLD)->>'workspace_id')::uuid END;
 END IF;
 FOR w IN SELECT DISTINCT id FROM unnest(ARRAY[w,old_w]) id WHERE id IS NOT NULL LOOP
  -- Parent deletion and FK cascades do not recreate erased epoch rows.
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=w) THEN
   INSERT INTO application_policy_workspace_epochs(workspace_id,revision) VALUES(w,nextval('application_policy_revision_seq'))
    ON CONFLICT(workspace_id) DO UPDATE SET revision=nextval('application_policy_revision_seq');
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_policy_epoch_changed() FROM PUBLIC;
COMMIT;
