BEGIN;
-- [COMP:operations/crm-recovery] Keep receipt and admission tables in the
-- canonical schema-driven recovery journal when this schema release is applied.
SELECT public.crm_install_erasure_capture();
COMMIT;
