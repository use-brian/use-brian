// [COMP:api/page-closure-adapter] Source module for the Page-root successor of the Page adapter (8287).
// A doc-thread turn reads its current Page directly, so the Page receipt is a root
// of the turn's evidence. The 8278 adapter declined Page roots, which sent every
// such admission (preparation, every delivery audience check, publication) to the
// generic validator, whose cost grows multiplicatively with the thread (M5Q-16).
// The successor admits Page roots under exactly the rules it already applies to
// Page receipts reached through derivation edges, reads lineage in chunks of 100
// roots, and declines (instead of raising) for a login outside the two-role model.
// Everything else in the member is byte-identical. Everything here is source text; no authorization is stored.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {executableProjection} from './executable-record.mjs'
import {memberCreate} from './page-closure.mjs'

const directory = fileURLToPath(new URL('./', import.meta.url))
const q = value => "'" + value.replaceAll("'", "''") + "'"
const sha = value => createHash('sha256').update(value).digest('hex')

export const rootsSignature = 'capture_page_closure_evidence(uuid,jsonb,uuid)'
const create = memberCreate('capture_page_closure_evidence')
export const rootsHead = create.slice(0, create.indexOf(' AS $body$'))
export const predecessorRootsBody = create.slice(create.indexOf(' AS $body$') + ' AS $body$'.length, create.lastIndexOf('$body$;'))
export const predecessorRootsSha = '8a2340dc72661e38eadefe048308bfdc0ca8784d311bbef54aa48268041c51a7'
export const rootsBody = readFileSync(directory + 'page-closure-roots.sql', 'utf8')
if (sha(predecessorRootsBody) !== predecessorRootsSha || !rootsBody.startsWith('\nDECLARE ') || !rootsBody.endsWith('\nEND ')
  || sha(rootsBody) === predecessorRootsSha || rootsBody.includes('$body$') || rootsBody.includes('$roots_body$')
  || !rootsBody.includes("AND NOT root->>'kind'=ANY(page_kinds)) THEN RETURN NULL;END IF;") || rootsBody.includes("'access_unavailable'")) throw Error('page_roots_successor_source_changed')

const metadataCheck = `NOT p.prosecdef OR p.proowner<>owner_id
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR p.provolatile<>'v' OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(runtime,owner_id,'EXECUTE',false)]
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(rootsSignature)} AND ${executableProjection('p')} IS NOT DISTINCT FROM h.contract)`
const declare = `DECLARE p pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);runtime oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');`

// Before installation: the exact 8278 body with its metadata, two-role ACL and
// registry record, and no catalog body that pins any form of its fingerprint.
export const rootsPredecessorSql = `DO $page_roots_predecessor$ ${declare}BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + rootsSignature)});
 IF p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>${q(predecessorRootsSha)} OR ${metadataCheck}
 THEN RAISE EXCEPTION 'page_roots_predecessor_changed';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc c WHERE c.oid<>p.oid AND (strpos(c.prosrc,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'))>0
  OR strpos(c.prosrc,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))>0 OR strpos(c.prosrc,md5(p.prosrc))>0))
 THEN RAISE EXCEPTION 'page_roots_unreviewed_pin_consumer';END IF;
END $page_roots_predecessor$;`

// The successor: same declaration, new body; then its typed registry record.
export const rootsInstallSql = `${rootsHead.replace('CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.')} AS $roots_body$${rootsBody}$roots_body$;
DO $page_roots_record$ DECLARE p pg_proc;BEGIN
 SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + rootsSignature)});
 UPDATE native_turn_contract_helpers SET contract=${executableProjection('p')} WHERE signature=${q(rootsSignature)};
 IF NOT FOUND THEN RAISE EXCEPTION 'page_roots_record_missing';END IF;
END $page_roots_record$;`

// After installation (and on every authentication): the exact successor body,
// unchanged metadata and ACL, and the matching registry record.
export const rootsCheckSql = prefix => `DO $${prefix}page_roots$ ${declare}BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + rootsSignature)});
 IF p.oid IS NULL OR (p.prosrc COLLATE "C") IS DISTINCT FROM (${q(rootsBody)} COLLATE "C") OR ${metadataCheck}
 THEN RAISE EXCEPTION 'installation_page_roots_changed';END IF;
END $${prefix}page_roots$;`

// The 8278 member check in every predecessor recipe compiles the member from the
// 8278 source text; the successor recipe compiles the successor body instead.
export const predecessorReferenceLiteral = q(predecessorRootsBody)
export const successorReferenceLiteral = q(rootsBody)
