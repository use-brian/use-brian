// [COMP:api/private-transcript] Source module for the private-transcript floor successor (8281).
// The private transcript parent checks the personal session's scope floor
// (clearance, Team and Project assignment) for the assistant that actually reads:
// the answering assistant pinned for the native operation (app.v2_assistant_id),
// or the session's bound assistant when none is pinned. Before, it always used the
// bound assistant's clearance, which department-v2 evaluates under the answering
// assistant's ceiling, so a legitimate answering assistant was refused there and
// admitted under legacy. Rows remain individually admitted under the reader's
// current ceiling. Not a canonical registry member and pinned by no contract.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'

const directory = fileURLToPath(new URL('./', import.meta.url))
const q = value => "'" + value.replaceAll("'", "''") + "'"
const sha = value => createHash('sha256').update(value).digest('hex')

export const floorSignature = 'private_session_display_parent(uuid,uuid,uuid,integer)'
// The exact body 8207 installed (read_native_session_recovery_parent with the
// display renames); unchanged through 8280.
export const predecessorFloorSha = '39a441067bfaad9a9a1bff7e423cb8464434a34bbe1c8e2ac560e36c2f34a59c'
export const floorBody = readFileSync(directory + 'private-transcript-floor.sql', 'utf8').replace(/\n$/, '')
if (!floorBody.startsWith('\nDECLARE ') || !floorBody.endsWith('\nEND ') || sha(floorBody) === predecessorFloorSha
  || floorBody.includes('$floor_body$')) throw Error('private_transcript_floor_source_changed')

const metadata = `NOT p.prosecdef OR p.proowner<>owner_id OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  OR p.provolatile<>'v' OR p.proparallel<>'u' OR p.proisstrict OR p.proleakproof OR p.procost<>100 OR p.prorettype<>'jsonb'::regtype
  OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR p.proargnames IS DISTINCT FROM ARRAY['w','i','device','version']
  OR p.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]`

// Before installation: the exact predecessor body and reviewed metadata, and no
// executable embedding the predecessor's catalog fingerprint (no pin consumer).
export const floorPredecessorSql = `DO $private_floor_predecessor$ DECLARE p pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);fingerprint text;unknown text;BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + floorSignature)});
 IF p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>${q(predecessorFloorSha)} OR ${metadata}
 THEN RAISE EXCEPTION 'private_transcript_floor_predecessor_changed';END IF;
 fingerprint:=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex');
 SELECT c.oid::regprocedure::text INTO unknown FROM pg_proc c JOIN pg_namespace n ON n.oid=c.pronamespace
 WHERE c.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(c.pronamespace)
  AND n.nspname NOT IN('pg_catalog','information_schema') AND strpos(c.prosrc,fingerprint)>0 LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'private_transcript_floor_unreviewed_pin_consumer: %',unknown;END IF;
 IF EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(floorSignature)})
 THEN RAISE EXCEPTION 'private_transcript_floor_unreviewed_registry_member';END IF;
END $private_floor_predecessor$;`

// The successor keeps the same signature, metadata and ACL (CREATE OR REPLACE).
export const floorSuccessorSql = `CREATE OR REPLACE FUNCTION public.private_session_display_parent(w uuid,i uuid,device uuid,version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $floor_body$${floorBody}$floor_body$;`

// After installation (and on every authentication): exact body and metadata.
export const floorCheckSql = prefix => `DO $${prefix}private_floor$ DECLARE p pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + floorSignature)});
 IF p.oid IS NULL OR (p.prosrc COLLATE "C") IS DISTINCT FROM (${q(floorBody)} COLLATE "C") OR ${metadata}
 THEN RAISE EXCEPTION 'installation_private_transcript_floor_changed';END IF;
END $${prefix}private_floor$;`
