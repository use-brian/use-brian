BEGIN;
-- [COMP:api/application-persistence] Preserve the ordinary runtime facade grant.
-- The prior implementation's ACL follows its renamed OID, while the recreated
-- facade has its own ACL. Its existing source/field/ancestry checks are unchanged.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_entity_derivation_source(uuid,text,uuid) TO app_user;
END IF;END $$;
COMMIT;
