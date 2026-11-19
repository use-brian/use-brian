
DECLARE result jsonb;routed boolean:=false;
BEGIN
 -- Entry fence, as the predecessor: a changed guard refuses before any evaluation.
 -- The joint preparation owner (8275) reads this pinned guard fingerprint.
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 -- Fused admission owner (8289). The compiled statements of fused_f_capture
 -- evaluate this boundary. A shape it does not compile (Memory candidates and
 -- history, foreign families, annotation points, history-bearing messages, any
 -- branch whose compiled form declines) is answered by the generic owner, the
 -- unchanged predecessor body, as one whole capture. Availability failures
 -- propagate; nothing is stored or reused.
 BEGIN
  result:=fused_f_capture(w,roots,authority,cohorts,'__CAPTURE_GUARD_FINGERPRINT__');
 EXCEPTION WHEN transaction_rollback OR insufficient_resources OR program_limit_exceeded OR object_not_in_prerequisite_state
  OR operator_intervention OR system_error OR internal_error THEN RAISE;
  WHEN OTHERS THEN routed:=true;
 END;
 IF routed OR result IS NOT DISTINCT FROM '{"fusedRoute":"generic"}'::jsonb THEN
  RETURN capture_conversation_evidence_generic(w,roots,authority,cohorts);
 END IF;
 RETURN result;
END 