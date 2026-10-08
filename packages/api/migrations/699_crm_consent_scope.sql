BEGIN;
-- [COMP:crm/association-source-scope] Legacy rows remain explicitly unclassified.
-- Saved consent and suppression scopes remain independent of current contact labels.
ALTER TABLE association_consent_events ADD COLUMN scope_snapshot jsonb, ADD COLUMN scope_sources jsonb;
ALTER TABLE crm_suppression_events ADD COLUMN scope_snapshot jsonb, ADD COLUMN scope_sources jsonb;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['association_consent_events','crm_suppression_events'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (
      (scope_snapshot IS NULL AND scope_sources IS NULL) OR
      (scope_snapshot IS NOT NULL AND scope_sources IS NOT NULL
       AND jsonb_typeof(scope_snapshot)=''object'' AND jsonb_typeof(scope_sources)=''array''
       AND jsonb_array_length(scope_sources)>0
       AND (scope_snapshot->>''workspaceId'') IS NOT DISTINCT FROM workspace_id::text
       AND scope_snapshot ?& ARRAY[''workspaceId'',''userId'',''assistantId'',''sensitivity'',''compartments'',''projectIds'']
       AND coalesce(scope_snapshot->>''sensitivity'','''') IN(''public'',''internal'',''confidential'')
       AND jsonb_typeof(scope_snapshot->''compartments'')=''array''
       AND jsonb_typeof(scope_snapshot->''projectIds'')=''array''))',tab,tab||'_scope_evidence_shape');
  END LOOP;
END $$;
COMMIT;
