// [COMP:api/page-closure-adapter] Source module for the Page-derived title payload admission successor.
// `session_context_revision_allowed` admits a turn-frame or title revision through
// the ordinary capture first. A closure that capture declines because it reaches a
// Page receipt used to fall through to `application_canonical_ancestry_allowed`,
// which recomputes every field envelope of the closure (69k to 280k nested
// statements per title on the M5 stack-4 cluster). The successor asks the 8278
// Page source-family adapter next, admits only when it proves the closure now and
// every source it names is visible to the current reader, and otherwise keeps the
// original evaluation unchanged. Everything here is source text; no
// authorization is stored.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {executableProjection} from './executable-record.mjs'

const directory = fileURLToPath(new URL('./', import.meta.url))
const q = value => "'" + value.replaceAll("'", "''") + "'"
const sha = value => createHash('sha256').update(value).digest('hex')

// An existing registry member (owner and app_user EXECUTE). Its successor body
// replaces only the exact installed body; every other field of its record is unchanged.
export const admissionSignature = 'session_context_revision_allowed(uuid,uuid)'
export const predecessorAdmissionSha = 'eece218fb5e8f2c9f589601fd66a73e6151574152e6f176f8148b182e2bffc0b'
export const admissionBody = readFileSync(directory + 'title-revision-admission.sql', 'utf8')
if (!admissionBody.startsWith('\nDECLARE ') || !admissionBody.endsWith('\nEND\n') || sha(admissionBody) === predecessorAdmissionSha
  || admissionBody.includes('$admission_render$') || admissionBody.split('capture_page_closure_evidence(').length !== 2) throw Error('title_admission_successor_source_changed')

const metadataCheck = `NOT p.prosecdef OR p.proowner<>owner_id
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR p.provolatile<>'v' OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(runtime,owner_id,'EXECUTE',false)]
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(admissionSignature)} AND ${executableProjection('p')} IS NOT DISTINCT FROM h.contract)`

// Wrap a predecessor body renderer: the member body is replaced only when the
// predecessor renders the exact installed body. Every other routine renders unchanged.
export const admissionRendererSql = (name, predecessor) => `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $admission_render$
DECLARE body text;
BEGIN
 body:=pg_temp.${predecessor}(routine,parts,successor);
 IF routine=${q(admissionSignature)} THEN
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>${q(predecessorAdmissionSha)} THEN RAISE EXCEPTION 'title_admission_predecessor_changed';END IF;
  body:=${q(admissionBody)};
 END IF;
 RETURN body;
END $admission_render$;`

// Before installation: the installed member is the exact predecessor body with its
// reviewed metadata, its two-role ACL and its registry record.
export const admissionPredecessorSql = `DO $title_admission_predecessor$ DECLARE p pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);runtime oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + admissionSignature)});
 IF p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>${q(predecessorAdmissionSha)} OR ${metadataCheck}
  OR to_regprocedure('public.capture_page_closure_evidence(uuid,jsonb,uuid)') IS NULL
 THEN RAISE EXCEPTION 'title_admission_predecessor_changed';END IF;
END $title_admission_predecessor$;`

// After installation (and on every authentication): the exact successor body,
// its unchanged metadata and ACL, and its registry record.
export const admissionCheckSql = prefix => `DO $${prefix}title_admission$ DECLARE p pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);runtime oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + admissionSignature)});
 IF p.oid IS NULL OR (p.prosrc COLLATE "C") IS DISTINCT FROM (${q(admissionBody)} COLLATE "C") OR ${metadataCheck}
 THEN RAISE EXCEPTION 'installation_title_admission_changed';END IF;
END $${prefix}title_admission$;`
