// [COMP:api/native-turn-frame] Source module for the query-domain visibility successor (8280).
// A frozen native query domain records the assistant visibility of the reader
// that captured it. That label is capture metadata, never authority: a later
// reader is admitted to the domain only when every frozen point is unscoped or
// visible to it, and the existing rescan then reproduces every candidate and
// point from that reader's own current admission (or the domain is refused).
// Everything here is source text: the generator writes it into 8280 and the
// installation authenticator renders the same text. No authorization is stored.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {executableProjection} from './executable-record.mjs'

const directory = fileURLToPath(new URL('./', import.meta.url))
const q = value => "'" + value.replaceAll("'", "''") + "'"
const sha = value => createHash('sha256').update(value).digest('hex')

// An existing registry member. Its successor body replaces only the exact 8269
// body (graph.sql); every other field of its record is unchanged.
export const domainSignature = 'conversation_dag_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb[])'
export const predecessorDomainSha = '46e977d09bff6fdc6f43c4708ceeeae18b5d87f861d0bb58d585802440b754b6'
export const domainBody = readFileSync(directory + 'query-domain-visibility.sql', 'utf8').replace(/\n$/, '')
if (!domainBody.startsWith('\nDECLARE ') || !domainBody.endsWith('\nEND ') || sha(domainBody) === predecessorDomainSha
  || domainBody.includes('$domain_render$')) throw Error('query_domain_successor_source_changed')

// Wrap a predecessor body renderer: the domain body is replaced only when the
// predecessor renders the exact 8269 body. Every other routine renders unchanged.
export const domainRendererSql = (name, predecessor) => `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $domain_render$
DECLARE body text;
BEGIN
 body:=pg_temp.${predecessor}(routine,parts,successor);
 IF routine=${q(domainSignature)} THEN
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>${q(predecessorDomainSha)} THEN RAISE EXCEPTION 'query_domain_predecessor_changed';END IF;
  body:=${q(domainBody)};
 END IF;
 RETURN body;
END $domain_render$;`

// Before installation: the installed member is the exact 8269 body with its
// reviewed metadata (owner-only SECURITY DEFINER, normalized search_path).
export const domainPredecessorSql = `DO $query_domain_predecessor$ DECLARE p pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + domainSignature)});
 IF p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>${q(predecessorDomainSha)} OR NOT p.prosecdef OR p.proowner<>owner_id
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR p.provolatile<>'v' OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(domainSignature)} AND ${executableProjection('p')} IS NOT DISTINCT FROM h.contract)
 THEN RAISE EXCEPTION 'query_domain_predecessor_changed';END IF;
END $query_domain_predecessor$;`

// After installation (and on every authentication): the exact successor body,
// its unchanged metadata and ACL, and its registry record.
export const domainCheckSql = prefix => `DO $${prefix}query_domain$ DECLARE p pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + domainSignature)});
 IF p.oid IS NULL OR (p.prosrc COLLATE "C") IS DISTINCT FROM (${q(domainBody)} COLLATE "C") OR NOT p.prosecdef OR p.proowner<>owner_id
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR p.provolatile<>'v' OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(domainSignature)} AND ${executableProjection('p')} IS NOT DISTINCT FROM h.contract)
 THEN RAISE EXCEPTION 'installation_query_domain_changed';END IF;
END $${prefix}query_domain$;`
