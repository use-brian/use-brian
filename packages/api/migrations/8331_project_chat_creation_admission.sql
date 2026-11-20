-- Shared Project chat roots use the Project roster, not the superseded
-- personal/legacy Project-focus predicate. Receipt equality/consumption stays
-- ahead of this authority check. No other provenance or audience is changed.
BEGIN;
DO $project_chat_creation$
DECLARE target regprocedure := 'public.require_session_creation_admission()'::regprocedure;
 routine pg_proc; original text; successor text; trigger_before jsonb;
 signature text; ok boolean;
 needle constant text := $needle$    -- A matched receipt/row pair is not a grant. Resolve live member and$needle$;
 addition constant text := $addition$    -- D24: an explicitly shared Project room has exactly one Project label
    -- and no Department audience. Do not pass that label to the legacy
    -- personal predicate (which accepts only an empty/one-Team projection).
    IF NEW.context_project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.project_shared_scopes s
      WHERE s.project_id=NEW.context_project_id AND s.workspace_id=NEW.workspace_id
    ) THEN
      IF policy.setup_state IS DISTINCT FROM 'ready'
        OR NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id=NEW.workspace_id
          AND w.department_read_v2 AND w.project_shared_spaces)
        OR NEW.context_group_id IS NOT NULL
        OR NEW.context_compartments IS DISTINCT FROM ARRAY['project:'||NEW.context_project_id::text]
        OR NOT EXISTS (SELECT 1 FROM public.project_shared_scopes s
          JOIN public.workspace_projects p ON p.id=s.project_id AND p.workspace_id=s.workspace_id
          WHERE s.project_id=NEW.context_project_id AND s.workspace_id=NEW.workspace_id
            AND s.status='active' AND p.status='active')
        -- Oversight is read-only; both live roster edges are necessary even
        -- for a workspace owner. Legacy Project focus grants are not a roster.
        OR public.project_member_live(NEW.context_project_id,'user',actor) IS NOT TRUE
        OR public.project_member_live(NEW.context_project_id,'assistant',NEW.assistant_id) IS NOT TRUE
        OR NEW.effective_clearance IS DISTINCT FROM (SELECT clearance FROM public.assistants WHERE id=NEW.assistant_id)
        OR public.member_operation_scope_allows(NEW.workspace_id,NEW.effective_clearance,NEW.context_compartments,true) IS NOT TRUE
        OR public.agent_read_scope_allows(NEW.effective_clearance,NEW.context_compartments,ARRAY[NEW.context_project_id]) IS NOT TRUE
        OR public.agent_mutation_scope_allows(NEW.context_compartments) IS NOT TRUE
        OR public.agent_visibility_allows(NEW.workspace_id,NULL,NULL) IS NOT TRUE
      THEN RAISE EXCEPTION 'workspace_creation_scope_unavailable' USING ERRCODE='42501'; END IF;
      RETURN NEW;
    END IF;
$addition$;
BEGIN
 -- The obsolete branch compiler is superseded by develop's complete portable
 -- executable-record registry (8274/8276). This is not an upgrade path for an already compiled candidate.
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8328_conversation_graph_frontier.sql')
  OR to_regclass('public.native_turn_helper_attestations') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.native_turn_contract_helpers'::regclass
    AND attname='contract' AND atttypid='public.native_executable_contract_v1'::regtype AND attnotnull AND NOT attisdropped)
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.native_turn_contract_helpers'::regclass
    AND attname='fingerprint' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'project_chat_creation_canonical_predecessor_required';END IF;
 -- These proofs must remain true: do not rebaseline any unrelated canonical
 -- helper, embedded reader pin, receipt registration or native contract table.
 -- Current source-owned 8328 proof ports cover the complete canonical and
 -- retained executable cohorts; do not call retired legacy batch shortcuts.
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'native_retained_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'project_chat_creation_dependency_changed: %',signature; END IF;
 END LOOP;
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid=target;
 original := routine.prosrc;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM '6ab79d20c4f67c1318e6acc8a257c4cb0c37259cd97b453338f456df63266f05'
  OR routine.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
  OR routine.pronamespace<>'public'::regnamespace OR routine.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR NOT routine.prosecdef OR routine.provolatile<>'v' OR routine.proparallel<>'u' OR routine.prokind<>'f'
  OR routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  OR routine.prorettype<>'trigger'::regtype OR routine.pronargs<>0 OR routine.proargnames IS NOT NULL
  OR routine.proargmodes IS NOT NULL OR routine.proallargtypes IS NOT NULL OR routine.proargdefaults IS NOT NULL
  OR routine.pronargdefaults<>0 OR routine.provariadic<>0 OR routine.proretset OR routine.proisstrict OR routine.proleakproof
  OR routine.procost<>100 OR routine.prorows<>0 OR routine.probin IS NOT NULL OR routine.prosqlbody IS NOT NULL
  OR routine.prosupport<>0 OR routine.protrftypes IS NOT NULL
  OR (SELECT count(*)=1 AND coalesce(bool_and(a.grantee=routine.proowner AND a.grantor=routine.proowner
    AND a.privilege_type='EXECUTE' AND NOT a.is_grantable),false)
   FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a) IS NOT TRUE
 THEN RAISE EXCEPTION 'project_chat_creation_predecessor_changed'; END IF;
 SELECT to_jsonb(t) INTO STRICT trigger_before FROM pg_trigger t
 WHERE t.tgrelid='public.sessions'::regclass AND t.tgname='zzzz_session_creation_admission'
  AND t.tgfoid=target AND t.tgtype=7 AND t.tgenabled='O' AND NOT t.tgisinternal
  AND t.tgnargs=0 AND t.tgqual IS NULL;
 -- This trigger is not a registered reader helper and has no executable
 -- literal pins. Refuse an unexpected consumer instead of silently repinning.
 IF EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE to_regprocedure(h.signature)=target)
  OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.prokind='f' AND p.oid<>target AND (
   position(quote_literal(original) IN p.prosrc)>0
   OR position(encode(sha256(convert_to(to_jsonb(routine)::text,'UTF8')),'hex') IN p.prosrc)>0
   OR position(encode(sha256(convert_to(original,'UTF8')),'hex') IN p.prosrc)>0))
 THEN RAISE EXCEPTION 'project_chat_creation_unexpected_pin_consumer'; END IF;
 IF (length(original)-length(replace(original,needle,'')))/length(needle)<>1
 THEN RAISE EXCEPTION 'project_chat_creation_splice_changed'; END IF;
 successor := replace(original,needle,addition||needle);
 EXECUTE replace(pg_get_functiondef(target),original,successor);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=target) IS DISTINCT FROM to_jsonb(routine)-'prosrc'
  OR (SELECT prosrc FROM pg_proc WHERE oid=target) IS DISTINCT FROM successor
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE t.tgrelid='public.sessions'::regclass
    AND t.tgname='zzzz_session_creation_admission') IS DISTINCT FROM trigger_before
 THEN RAISE EXCEPTION 'project_chat_creation_registration_changed'; END IF;
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'native_retained_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'project_chat_creation_successor_changed: %',signature; END IF;
 END LOOP;
END $project_chat_creation$;
COMMIT;
