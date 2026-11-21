/** [COMP:api/harness-migration-upgrade] No candidate bridge is supported. Run before ledger creation, recovery or aliases.
 * 8268 alone is deliberately NOT rejected: develop owns its authenticated Memory
 * lineage transition. Neither a filename alias nor that transition authenticates
 * the old harness/admission/compiler candidate.
 */
export const projectHarnessSuccessorFiles = [
  '8335_project_harnesses.sql',
  '8336_project_harness_verification.sql',
  '8337_project_chat_creation_admission.sql',
] as const

// Catalog reads only. In particular, refusal must not create a ledger, repair
// receipts, erase candidate effects, repin functions, or invoke catalog code.
export const projectHarnessCandidateBoundarySql = `DO $project_harness_boundary$
DECLARE applied text[]:=ARRAY[]::text[]; foundation boolean; verification boolean; admission boolean;
BEGIN
 IF to_regclass('public._migrations') IS NOT NULL THEN
  SELECT coalesce(array_agg(name),ARRAY[]::text[]) INTO applied FROM public._migrations;
 END IF;
 IF applied && ARRAY['8269_project_harnesses.sql','8270_project_harness_verification.sql',
   '8271_project_chat_creation_admission.sql','8272_native_helper_attestation_cost.sql',
   '8329_project_harnesses.sql','8330_project_harness_verification.sql','8331_project_chat_creation_admission.sql']::text[]
 THEN RAISE EXCEPTION 'project_harness_candidate_upgrade_unsupported: historical candidate ledger; preserve database';END IF;
 IF to_regclass('public.native_turn_helper_attestations') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND strpos(p.prosrc,'native_turn_helper_attestations')>0)
 THEN RAISE EXCEPTION 'project_harness_candidate_upgrade_unsupported: historical compiler effects; preserve database';END IF;
 foundation:='${projectHarnessSuccessorFiles[0]}'=ANY(applied);
 verification:='${projectHarnessSuccessorFiles[1]}'=ANY(applied);
 admission:='${projectHarnessSuccessorFiles[2]}'=ANY(applied);
 IF (verification AND NOT foundation) OR (admission AND NOT verification)
 THEN RAISE EXCEPTION 'project_harness_candidate_upgrade_unsupported: incomplete successor receipts; preserve database';END IF;
 IF NOT foundation AND (
  EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
    AND c.relname=ANY(ARRAY['project_harness_products','project_harness_components','project_harness_revisions']))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND starts_with(p.proname,'project_harness_'))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.connamespace='public'::regnamespace
    AND c.conname='project_shared_scopes_workspace_project_unique'))
 THEN RAISE EXCEPTION 'project_harness_candidate_upgrade_unsupported: unreceipted foundation effects; preserve database';END IF;
 IF NOT verification AND (
  EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
    AND c.relname=ANY(ARRAY['project_harness_approvals','project_harness_runs','project_harness_evidence','project_harness_execution_audit']))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND starts_with(p.proname,'harness_execution_')))
 THEN RAISE EXCEPTION 'project_harness_candidate_upgrade_unsupported: unreceipted verification effects; preserve database';END IF;
 IF NOT admission AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='require_session_creation_admission'
    AND strpos(p.prosrc,'D24: an explicitly shared Project room')>0)
 THEN RAISE EXCEPTION 'project_harness_candidate_upgrade_unsupported: unreceipted Project admission; preserve database';END IF;
END $project_harness_boundary$;`
