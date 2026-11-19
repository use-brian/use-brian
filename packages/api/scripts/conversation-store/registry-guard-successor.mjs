// [COMP:api/native-turn-frame] Source-defined tuple-version witness for the canonical registry guard.
// The witness records the exact catalog tuple versions (ctid, xmin) that a full
// registry/table-contract comparison verified, plus the in-place-updatable flags
// that a tuple version does not cover. At every fence the guard re-reads those
// identities from the live catalog; equality means the full comparator would read
// byte-identical rows, so it returns true. Any difference runs the unchanged full
// comparator. The guard never writes; only the owner-only refresh rewrites the
// witness, in the same statement and snapshot as a passing full comparison.
// No authorization, grant or source decision is stored or reused.

export const witnessTable = 'public.native_turn_contract_witness'
export const witnessRefresh = 'native_turn_contract_witness_refresh()'
export const preparationOwner = 'capture_conversation_preparation(uuid,jsonb,jsonb,jsonb)'
export const enrolledSignatures = Object.freeze([preparationOwner, witnessRefresh])

const q = value => "'" + value.replaceAll("'", "''") + "'"
const arr = values => 'ARRAY[' + values.map(q).join(',') + ']'

// Relations whose catalog rows any part of the full guard reads.
export const conversionRelations = Object.freeze(['native_conversation_frame_requirements', 'native_conversation_conversion_runs',
  'native_conversation_conversion_inputs', 'native_conversation_conversion_pending', 'native_conversation_conversion_pages'])
export const witnessRelations = Object.freeze(['native_turn_frames', 'native_turn_publication_work', 'native_turn_publication_events',
  'native_turn_publication_seals', 'native_turn_publication_impossible', 'native_turn_publication_debt', 'native_conversation_publications',
  ...conversionRelations, 'scope_derivation_sources', 'scope_derivations', 'native_turn_contract_helpers', 'native_turn_contract_witness'])
export const witnessTypes = Object.freeze([...conversionRelations, 'native_conversation_requirement_source', 'native_conversation_conversion_unit_kind',
  ...[...conversionRelations, 'native_conversation_requirement_source', 'native_conversation_conversion_unit_kind'].map(name => '_' + name),
  'native_executable_contract_v1'])

// Canonical witness sets: derived only from source names, the registry and the
// catalog. The authenticator recomputes them; a stored subset is refused.
export const witnessSetsSql = `SELECT
 (SELECT array_agg(DISTINCT x.o ORDER BY x.o) FROM(SELECT (h.contract).oid o FROM public.native_turn_contract_helpers h
  UNION SELECT t.tgfoid FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN('public.scope_derivation_sources'::regclass,'public.scope_derivations'::regclass)) x) procs,
 (SELECT array_agg(DISTINCT x.o ORDER BY x.o) FROM(SELECT c.oid o FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(${arr(witnessRelations)})
  UNION SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(${arr(conversionRelations)})
  UNION SELECT t.typrelid FROM pg_catalog.pg_type t WHERE t.oid='public.native_executable_contract_v1'::regtype) x) relations,
 ARRAY['public.sessions'::regclass::oid] class_only,
 (SELECT array_agg(t.oid ORDER BY t.oid) FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typname=ANY(${arr(witnessTypes)})) types`
export const witnessSetCounts = Object.freeze({ relationNames: witnessRelations.length, types: witnessTypes.length })

// Live tuple identities for the sets in row alias w. Typed arrays, no text output.
export const liveWitnessSql = w => `SELECT array_agg(s.t ORDER BY s.f,s.k1,s.k2,s.t) tids,array_agg(s.x ORDER BY s.f,s.k1,s.k2,s.t) xmins,coalesce(string_agg(s.fl,'' ORDER BY s.f,s.k1,s.k2,s.t),'') flags FROM(
  SELECT 1 f,0::oid k1,0 k2,h.ctid t,h.xmin x,NULL::text fl FROM public.native_turn_contract_helpers h
  UNION ALL SELECT 2,p.oid,0,p.ctid,p.xmin,NULL FROM pg_catalog.pg_proc p WHERE p.oid=ANY(${w}.procs)
  UNION ALL SELECT 3,c.oid,0,c.ctid,c.xmin,concat(c.relhasindex::int,c.relhasrules::int,c.relhastriggers::int,c.relhassubclass::int) FROM pg_catalog.pg_class c WHERE c.oid=ANY(${w}.relations||${w}.class_only)
  UNION ALL SELECT 4,a.attrelid,a.attnum,a.ctid,a.xmin,NULL FROM pg_catalog.pg_attribute a WHERE a.attrelid=ANY(${w}.relations)
  UNION ALL SELECT 5,k.oid,0,k.ctid,k.xmin,NULL FROM pg_catalog.pg_constraint k WHERE k.conrelid=ANY(${w}.relations)
  UNION ALL SELECT 6,g.oid,0,g.ctid,g.xmin,NULL FROM pg_catalog.pg_trigger g WHERE g.tgrelid=ANY(${w}.relations)
  UNION ALL SELECT 7,d.oid,0,d.ctid,d.xmin,NULL FROM pg_catalog.pg_attrdef d WHERE d.adrelid=ANY(${w}.relations)
  UNION ALL SELECT 8,y.oid,0,y.ctid,y.xmin,NULL FROM pg_catalog.pg_policy y WHERE y.polrelid=ANY(${w}.relations)
  UNION ALL SELECT 9,r.oid,0,r.ctid,r.xmin,NULL FROM pg_catalog.pg_rewrite r WHERE r.ev_class=ANY(${w}.relations)
  UNION ALL SELECT 10,i.indexrelid,0,i.ctid,i.xmin,concat(i.indisunique::int,i.indnullsnotdistinct::int,i.indisprimary::int,i.indisexclusion::int,i.indimmediate::int,i.indisclustered::int,i.indisvalid::int,i.indcheckxmin::int,i.indisready::int,i.indislive::int,i.indisreplident::int) FROM pg_catalog.pg_index i WHERE i.indrelid=ANY(${w}.relations)
  UNION ALL SELECT 11,n.inhrelid,n.inhseqno,n.ctid,n.xmin,NULL FROM pg_catalog.pg_inherits n WHERE n.inhrelid=ANY(${w}.relations) OR n.inhparent=ANY(${w}.relations)
  UNION ALL SELECT 12,y.oid,0,y.ctid,y.xmin,NULL FROM pg_catalog.pg_type y WHERE y.oid=ANY(${w}.types)
  UNION ALL SELECT 13,e.oid,0,e.ctid,e.xmin,NULL FROM pg_catalog.pg_enum e WHERE e.enumtypid=ANY(${w}.types)
  UNION ALL SELECT 14,0,0,j.ctid,j.xmin,NULL FROM public.crm_erasure_journal_targets j WHERE j.table_name IN(SELECT c.relname FROM pg_catalog.pg_class c WHERE c.oid=ANY(${w}.relations))
 ) s`

// Inserted after the guard's opening BEGIN. One statement; on any difference the
// unchanged full comparator that follows decides.
export const guardFastPath = ` IF EXISTS(SELECT 1 FROM public.native_turn_contract_witness w CROSS JOIN LATERAL(${liveWitnessSql('w')}) l
  WHERE w.singleton AND l.tids=w.tids AND l.xmins=w.xmins AND l.flags=w.flags) THEN RETURN true;END IF;
`

export const witnessTableSql = `CREATE TABLE public.native_turn_contract_witness(
 singleton boolean PRIMARY KEY CHECK(singleton),
 procs oid[] NOT NULL,relations oid[] NOT NULL,class_only oid[] NOT NULL,types oid[] NOT NULL,
 tids tid[] NOT NULL,xmins xid[] NOT NULL,flags text NOT NULL);
REVOKE ALL ON public.native_turn_contract_witness FROM PUBLIC,app_user;
ALTER TABLE public.native_turn_contract_witness ENABLE ROW LEVEL SECURITY;
INSERT INTO public.crm_erasure_journal_targets VALUES('native_turn_contract_witness','{singleton}',false);
CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON public.native_turn_contract_witness FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect();`

// Owner-only maintenance. The full comparison and the recorded identities share
// one INSERT statement, so they read the same snapshot.
export const refreshBody = `
DECLARE recorded integer;
BEGIN
 IF NOT pg_has_role(current_user,(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.sessions'::regclass),'USAGE')
  OR (SELECT rolsuper OR rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'contract_witness_owner_required' USING ERRCODE='42501';END IF;
 DELETE FROM public.native_turn_contract_witness;
 INSERT INTO public.native_turn_contract_witness(singleton,procs,relations,class_only,types,tids,xmins,flags)
  SELECT true,w.procs,w.relations,w.class_only,w.types,l.tids,l.xmins,l.flags FROM(${witnessSetsSql}) w CROSS JOIN LATERAL(${liveWitnessSql('w')}) l
  WHERE public.native_turn_helpers_current() IS TRUE AND cardinality(w.types)=${witnessTypes.length}
   AND (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(${arr(witnessRelations)}))=${witnessRelations.length};
 GET DIAGNOSTICS recorded=ROW_COUNT;
 IF recorded<>1 THEN RAISE EXCEPTION 'contract_witness_source_changed' USING ERRCODE='42501';END IF;
 RETURN public.native_turn_helpers_current();
END`
export const refreshDeclaration = body => `CREATE FUNCTION public.native_turn_contract_witness_refresh() RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS ${'$refresh$'}${body}${'$refresh$'};
REVOKE ALL ON FUNCTION public.native_turn_contract_witness_refresh() FROM PUBLIC,app_user;`

// Insert the fast path into a rendered predecessor guard body and extend its
// registry roster, re-ordering under the database default collation exactly as
// the runtime ORDER BY h.signature does. The old roster must re-render to itself.
export const guardRendererSql = (name, predecessor) => `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $witness$
DECLARE body text;anchor constant text:='array_agg(h.signature ORDER BY h.signature)=';start_at integer;end_at integer;old_array text;names text[];rendered text;
BEGIN
 body:=pg_temp.${predecessor}(routine,parts,successor);
 IF routine='native_turn_helpers_current()' THEN
  IF left(body,6)<>'BEGIN'||chr(10) OR (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 OR strpos(body,'native_turn_contract_witness')>0 THEN RAISE EXCEPTION 'witness_root_source_changed';END IF;
  start_at:=strpos(body,anchor)+length(anchor);end_at:=strpos(substring(body FROM start_at),'::text[]')+start_at-1;
  old_array:=substring(body FROM start_at FOR end_at-start_at);
  SELECT array_agg(replace(m[1],'''''','''') ORDER BY o) INTO names FROM regexp_matches(old_array,'''((?:[^'']|'''')*)''','g') WITH ORDINALITY x(m,o);
  IF old_array IS DISTINCT FROM (SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' FROM unnest(names) s) OR names&&${arr(enrolledSignatures)}::text[]
  THEN RAISE EXCEPTION 'witness_root_roster_changed';END IF;
  SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' INTO rendered FROM unnest(names||${arr(enrolledSignatures)}::text[]) s;
  body:='BEGIN'||chr(10)||${q(guardFastPath)}||substring(body FROM 7 FOR start_at-7)||rendered||substring(body FROM end_at);
 END IF;
 RETURN body;
END $witness$;`

// Source authentication of the two enrolled members and the witness relation.
// Read-only: every compiled reference lives in pg_temp under the given prefix.
export function enrolledAuthenticationSql({ prefix, preparationCreate, predecessor = false }) {
  const marker = 'CREATE FUNCTION public.capture_conversation_preparation('
  if (preparationCreate.split(marker).length !== 2 || !preparationCreate.trimEnd().endsWith('$function$;')) throw Error('witness_preparation_source_changed')
  const preparationReference = preparationCreate.replace(marker, `CREATE FUNCTION pg_temp.${prefix}preparation_reference(`)
  const refreshReference = `CREATE FUNCTION pg_temp.${prefix}refresh_reference() RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $refresh$${refreshBody}$refresh$;`
  return `${preparationReference}
${predecessor ? '' : refreshReference}
DO $${prefix}enrolled$ DECLARE owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);runtime oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 actual pg_proc;reference pg_proc;digest text;identity constant text[]:=ARRAY['oid','proname','pronamespace','proowner','proacl','prosrc','proargdefaults'];BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.${preparationOwner}');
 SELECT * INTO STRICT reference FROM pg_proc WHERE oid=to_regprocedure('pg_temp.${prefix}preparation_reference(uuid,jsonb,jsonb,jsonb)');
 IF actual.oid IS NULL THEN RAISE EXCEPTION 'installation_enrolled_member_missing: ${preparationOwner}';END IF;
 digest:=substring(actual.prosrc FROM 'self_digest constant text:=''([0-9a-f]{64})''');
 IF digest IS NULL OR (to_jsonb(actual)-identity) IS DISTINCT FROM (to_jsonb(reference)-identity) OR actual.pronamespace<>'public'::regnamespace OR actual.proowner<>owner_id
  OR pg_get_function_arguments(actual.oid) IS DISTINCT FROM pg_get_function_arguments(reference.oid)
  OR (actual.prosrc COLLATE "C") IS DISTINCT FROM (replace(reference.prosrc,repeat('0',64),digest) COLLATE "C")
  OR encode(sha256(convert_to(jsonb_set(to_jsonb(actual),'{prosrc}',to_jsonb(replace(actual.prosrc,digest,repeat('0',64))))::text,'UTF8')),'hex')<>digest
  OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(runtime,owner_id,'EXECUTE',false)]
 THEN RAISE EXCEPTION 'installation_enrolled_member_changed: ${preparationOwner}';END IF;
 IF ${predecessor ? 'true' : 'false'} THEN
  IF to_regprocedure('public.${witnessRefresh}') IS NOT NULL OR to_regclass('${witnessTable}') IS NOT NULL
   OR EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=ANY(${arr(enrolledSignatures)}::text[])) THEN RAISE EXCEPTION 'witness_successor_already_installed';END IF;
  RETURN;
 END IF;
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.${witnessRefresh}');
 SELECT * INTO reference FROM pg_proc WHERE oid=to_regprocedure('pg_temp.${prefix}refresh_reference()');
 IF actual.oid IS NULL OR (to_jsonb(actual)-identity) IS DISTINCT FROM (to_jsonb(reference)-identity) OR actual.pronamespace<>'public'::regnamespace OR actual.proowner<>owner_id
  OR (actual.prosrc COLLATE "C") IS DISTINCT FROM (reference.prosrc COLLATE "C") OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
 THEN RAISE EXCEPTION 'installation_enrolled_member_changed: ${witnessRefresh}';END IF;
 IF EXISTS(SELECT 1 FROM unnest(${arr(enrolledSignatures)}::text[]) s LEFT JOIN native_turn_contract_helpers h ON h.signature=s LEFT JOIN pg_proc p ON p.oid=to_regprocedure(s)
  WHERE h.signature IS NULL OR p.oid IS NULL OR ROW(p.oid,p.proname,p.pronamespace,p.proowner,p.prolang,p.procost,p.prorows,p.provariadic,p.prosupport,p.prokind,p.prosecdef,p.proleakproof,p.proisstrict,p.proretset,p.provolatile,p.proparallel,p.pronargs,p.pronargdefaults,p.prorettype,p.proargtypes,p.proallargtypes,p.proargmodes,p.proargnames,p.proargdefaults::text,p.protrftypes,p.prosrc,p.probin,p.prosqlbody::text,p.proconfig,p.proacl)::public.native_executable_contract_v1 IS DISTINCT FROM h.contract)
 THEN RAISE EXCEPTION 'installation_enrolled_registry_changed';END IF;
END $${prefix}enrolled$;`
}

// Witness relation contract: exact columns, owner-only ACL, RLS without policies,
// the reviewed recovery capture and nothing else. Stored sets must equal the
// canonical derivation; stale identities are reported, never repaired here.
export const witnessRelationCheckSql = prefix => `DO $${prefix}witness_relation$ DECLARE rel pg_class;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);BEGIN
 SELECT * INTO rel FROM pg_class WHERE oid=to_regclass('${witnessTable}');
 IF rel.oid IS NULL OR rel.relkind<>'r' OR rel.relpersistence<>'p' OR rel.relowner<>owner_id OR NOT rel.relrowsecurity OR rel.relforcerowsecurity
  OR coalesce(rel.relacl,acldefault('r',rel.relowner)) IS DISTINCT FROM acldefault('r',rel.relowner)
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=rel.oid) OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=rel.oid)
  OR (SELECT array_agg(a.attname::text||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||a.atthasdef::text||':'||coalesce(a.attacl::text,'') ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=rel.oid AND a.attnum>0 AND NOT a.attisdropped)
   IS DISTINCT FROM ARRAY['singleton:boolean:true:false:','procs:oid[]:true:false:','relations:oid[]:true:false:','class_only:oid[]:true:false:','types:oid[]:true:false:','tids:tid[]:true:false:','xmins:xid[]:true:false:','flags:text:true:false:']
  OR (SELECT array_agg(c.contype::text||':'||pg_get_constraintdef(c.oid) ORDER BY c.contype) FROM pg_constraint c WHERE c.conrelid=rel.oid AND c.contype<>'n')
   IS DISTINCT FROM ARRAY['c:CHECK (singleton)','p:PRIMARY KEY (singleton)']
  OR (SELECT array_agg(g.tgname::text||':'||g.tgfoid::regprocedure::text||':'||g.tgtype||':'||g.tgenabled::text||':'||g.tgisinternal::text ORDER BY g.tgname) FROM pg_trigger g WHERE g.tgrelid=rel.oid)
   IS DISTINCT FROM ARRAY['crm_recovery_capture:crm_capture_erasure_effect():29:O:false']
  OR NOT EXISTS(SELECT 1 FROM public.crm_erasure_journal_targets t WHERE t.table_name='native_turn_contract_witness' AND t.key_columns='{singleton}' AND NOT t.capture_inserts)
  OR EXISTS(SELECT 1 FROM public.native_turn_contract_witness w CROSS JOIN(${witnessSetsSql}) s
   WHERE NOT w.singleton OR w.procs IS DISTINCT FROM s.procs OR w.relations IS DISTINCT FROM s.relations OR w.class_only IS DISTINCT FROM s.class_only OR w.types IS DISTINCT FROM s.types)
 THEN RAISE EXCEPTION 'installation_contract_witness_changed';END IF;
END $${prefix}witness_relation$;`
export const witnessCurrencySql = `SELECT EXISTS(SELECT 1 FROM public.native_turn_contract_witness w CROSS JOIN LATERAL(${liveWitnessSql('w')}) l
 WHERE w.singleton AND l.tids=w.tids AND l.xmins=w.xmins AND l.flags=w.flags) witness_current`
