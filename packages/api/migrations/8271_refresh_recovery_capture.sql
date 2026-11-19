-- Refresh capture for tables introduced after the previous schema registry.
-- [COMP:operations/crm-recovery]
BEGIN;
-- Native conversation contracts pin existing trigger records. Refresh coverage
-- without changing the catalog identities of already-correct capture triggers.
CREATE OR REPLACE FUNCTION public.crm_install_erasure_capture() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE target record; keys text[]; capture record;
BEGIN
  FOR target IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND c.relname NOT IN('crm_erasure_journal','crm_erasure_journal_targets','_migrations')
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
  LOOP
    SELECT array_agg(a.attname::text ORDER BY k.ord) INTO keys FROM pg_constraint p,
      unnest(p.conkey) WITH ORDINALITY k(id,ord),pg_attribute a
      WHERE p.conrelid=target.oid AND p.contype='p' AND a.attrelid=target.oid AND a.attnum=k.id;
    INSERT INTO public.crm_erasure_journal_targets VALUES(target.relname,COALESCE(keys,'{}'),target.relname='crm_address_suppression_tombstones')
      ON CONFLICT(table_name) DO UPDATE SET key_columns=EXCLUDED.key_columns,capture_inserts=EXCLUDED.capture_inserts;
    SELECT * INTO capture FROM pg_trigger WHERE tgrelid=target.oid AND tgname='crm_recovery_capture';
    IF FOUND AND capture.tgfoid='public.crm_capture_erasure_effect()'::regprocedure
      AND capture.tgtype=29 AND NOT capture.tgisinternal AND capture.tgconstraint=0
      AND NOT capture.tgdeferrable AND NOT capture.tginitdeferred
      AND capture.tgnargs=0 AND capture.tgargs=''::bytea AND capture.tgattr=''::int2vector
      AND capture.tgqual IS NULL AND capture.tgoldtable IS NULL AND capture.tgnewtable IS NULL
    THEN
      IF capture.tgenabled<>'O' THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER crm_recovery_capture',target.relname);
      END IF;
    ELSE
      EXECUTE format('DROP TRIGGER IF EXISTS crm_recovery_capture ON public.%I',target.relname);
      EXECUTE format('CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect()',target.relname);
    END IF;
  END LOOP;
END;
$$;
SELECT public.crm_install_erasure_capture();
-- Do not leave publication unavailable if a native contract does not yet admit
-- the new capture triggers. Its reviewed contract update must accompany this
-- coverage change before this migration can be released.
DO $$ BEGIN
  IF public.native_turn_helpers_current() IS NOT TRUE THEN
    RAISE EXCEPTION 'recovery_capture_native_contract_update_required';
  END IF;
END $$;
COMMIT;
