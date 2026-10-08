BEGIN;
-- [COMP:crm/privacy-admission] Spec: crm-operations.md, Privacy write admission.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'association_site_content','association_site_content_revisions',
    'association_membership_catalogues','association_membership_catalogue_revisions',
    'association_programme_catalogues','association_programme_catalogue_revisions'
  ] LOOP
    EXECUTE format('CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.crm_privacy_guard_write()',table_name);
  END LOOP;
END;
$$;
COMMIT;
