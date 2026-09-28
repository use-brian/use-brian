BEGIN;
ALTER TABLE workspace_access_command_reviews
  ADD COLUMN organization_revision bigint CHECK(organization_revision>=0),
  ADD CONSTRAINT workspace_access_command_review_family CHECK(
    (coalesce(command->>'type','') LIKE 'org.%')=(organization_revision IS NOT NULL)
  );
CREATE FUNCTION can_read_organization_command_review(review_workspace uuid,review_actor uuid,review_policy bigint,review_organization bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT can_read_department_command_review(review_workspace,review_actor,review_policy)
    AND (review_organization IS NULL OR (
      EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=review_workspace AND user_id=review_actor AND role IN('owner','admin'))
      AND coalesce((SELECT revision FROM workspace_org_state WHERE workspace_id=review_workspace),0)=review_organization
    ));
$$;
DROP POLICY workspace_access_command_review_actor ON workspace_access_command_reviews;
CREATE POLICY workspace_access_command_review_actor ON workspace_access_command_reviews FOR SELECT USING (
  can_read_organization_command_review(workspace_id,actor_user_id,policy_revision,organization_revision)
);
COMMIT;
