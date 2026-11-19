/**
 * [COMP:platform/managed-postgres] Durable native lifetime authority.
 *
 * The stop disposition lives only in the bootstrap (`postgres`) database,
 * outside the application database, in one closed table whose definition is
 * authenticated against shipped source before any row is read.
 */
import type { ManagedInstance } from './instance.js'
import type { ManagedQueryable } from './types.js'

const TABLE = 'usebrian_native_control.instance_lifecycle'
const COLUMNS = `singleton boolean PRIMARY KEY CHECK(singleton),
 system_identifier text NOT NULL,data_directory text NOT NULL,postmaster_pid integer NOT NULL,postmaster_started_at timestamptz NOT NULL,
 stopping_nonce uuid,stop_requested_at timestamptz,
 CHECK((stopping_nonce IS NULL)=(stop_requested_at IS NULL))`
const SNAPSHOT = `SELECT jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attcollation,a.attnotnull,a.attidentity,a.attgenerated,
    (SELECT pg_catalog.pg_get_expr(d.adbin,d.adrelid) FROM pg_catalog.pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)) ORDER BY a.attnum)
   FROM pg_catalog.pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.contype,c.condeferrable,c.condeferred,c.convalidated,pg_catalog.pg_get_constraintdef(c.oid)) ORDER BY c.contype,pg_catalog.pg_get_constraintdef(c.oid))
   FROM pg_catalog.pg_constraint c WHERE c.conrelid=$1::regclass),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indisunique,i.indisprimary,i.indisexclusion,i.indisvalid,i.indisready,i.indimmediate,i.indkey::text,i.indclass::text,i.indcollation::text,i.indoption::text,
    pg_catalog.pg_get_expr(i.indexprs,i.indrelid),pg_catalog.pg_get_expr(i.indpred,i.indrelid)) ORDER BY i.indisprimary)
   FROM pg_catalog.pg_index i WHERE i.indrelid=$1::regclass)) AS definition`
const SAFE = `SELECT
   n.nspowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='brian_bootstrap')
   AND c.relowner=n.nspowner AND c.relkind='r' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND (SELECT array_agg(relname::text ORDER BY relname::text) FROM pg_catalog.pg_class WHERE relnamespace=n.oid)=ARRAY['instance_lifecycle','instance_lifecycle_pkey']::text[]
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace=n.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0 AND attisdropped)
   AND (SELECT d.datdba=n.nspowner AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(d.datacl,pg_catalog.acldefault('d',d.datdba))) a WHERE a.grantee<>d.datdba) FROM pg_catalog.pg_database d WHERE d.datname=current_database())
   AS safe FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname='instance_lifecycle'
   WHERE n.nspname='usebrian_native_control'`

type ControlRow = {
  system_identifier: string; data_directory: string; postmaster_pid: number
  started_at: string; stopping_nonce: string | null; stop_requested_at: Date | string | null
}

export async function prepareNativeControl(client: ManagedQueryable, instance: ManagedInstance): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(`REVOKE ALL ON DATABASE postgres FROM PUBLIC;CREATE SCHEMA usebrian_native_control AUTHORIZATION brian_bootstrap;
   REVOKE ALL ON SCHEMA usebrian_native_control FROM PUBLIC;
   CREATE TABLE ${TABLE}(${COLUMNS});REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC`)
    await client.query(
      `INSERT INTO ${TABLE}(singleton,system_identifier,data_directory,postmaster_pid,postmaster_started_at) VALUES(true,$1,$2,$3::integer,$4::timestamptz)`,
      [instance.systemId, instance.dataDirectory, instance.pid, instance.startedAt],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

/** Compile the closed table definition from shipped source before row reads. */
export async function authenticateNativeControl(client: ManagedQueryable): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(`CREATE TEMP TABLE usebrian_native_control_source_reference(${COLUMNS}) ON COMMIT DROP`)
    const expected = await client.query<{ definition: unknown }>(SNAPSHOT, ['pg_temp.usebrian_native_control_source_reference'])
    const actual = await client.query<{ definition: unknown }>(SNAPSHOT, [TABLE])
    if (JSON.stringify(expected.rows[0].definition) !== JSON.stringify(actual.rows[0].definition)) throw new Error('managed_native_control_definition_changed')
    if ((await client.query<{ safe: boolean }>(SAFE)).rows[0]?.safe !== true) throw new Error('managed_native_control_authority_changed')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export async function readNativeDisposition(
  client: ManagedQueryable,
  instance: ManagedInstance,
): Promise<{ stopping: true; nonce: string } | { stopping: false }> {
  const rows = (await client.query<ControlRow>(`SELECT system_identifier,data_directory,postmaster_pid,(postmaster_started_at AT TIME ZONE 'UTC')::text||'Z' AS started_at,stopping_nonce,stop_requested_at FROM ${TABLE} WHERE singleton`)).rows
  if (rows.length !== 1 || rows[0].system_identifier !== instance.systemId || rows[0].data_directory !== instance.dataDirectory) {
    throw new Error('managed_native_control_identity_changed')
  }
  const row = rows[0]
  if (row.stopping_nonce) {
    if (!row.stop_requested_at || !Number.isFinite(new Date(row.stop_requested_at).getTime())) throw new Error('managed_native_control_stop_time_invalid')
    if (row.postmaster_pid === instance.pid && row.started_at === instance.startedAt) return { stopping: true, nonce: row.stopping_nonce }
    // A different authenticated postmaster on the same locked data directory
    // proves old-instance death. A timeout alone never clears the disposition.
  }
  if (row.postmaster_pid !== instance.pid || row.started_at !== instance.startedAt || row.stopping_nonce) {
    await client.query(
      `UPDATE ${TABLE} SET postmaster_pid=$1::integer,postmaster_started_at=$2::timestamptz,stopping_nonce=NULL,stop_requested_at=NULL WHERE singleton`,
      [instance.pid, instance.startedAt],
    )
  }
  return { stopping: false }
}

export async function requestNativeStop(client: ManagedQueryable, instance: ManagedInstance, nonce: string): Promise<string> {
  await client.query('BEGIN')
  try {
    const row = (await client.query<ControlRow>(`SELECT system_identifier,data_directory,postmaster_pid,(postmaster_started_at AT TIME ZONE 'UTC')::text||'Z' AS started_at,stopping_nonce FROM ${TABLE} WHERE singleton FOR UPDATE`)).rows[0]
    if (
      !row || row.system_identifier !== instance.systemId || row.data_directory !== instance.dataDirectory ||
      row.postmaster_pid !== instance.pid || row.started_at !== instance.startedAt
    ) throw new Error('managed_native_stop_instance_changed')
    const effective = row.stopping_nonce ?? nonce
    if (!row.stopping_nonce) await client.query(`UPDATE ${TABLE} SET stopping_nonce=$1::uuid,stop_requested_at=clock_timestamp() WHERE singleton`, [nonce])
    await client.query('COMMIT')
    return effective
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}
