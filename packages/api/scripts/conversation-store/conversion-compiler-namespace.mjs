// [COMP:api/native-turn-frame] Closed version-specific temporary compiler names.
// These source-only identities never rewrite runtime bodies, OIDs or hashes.
const complete = [
  "conversion_constraint",
  "conversion_contract_reference",
  "conversion_function_reference",
  "conversion_map_constraint",
  "conversion_map_relation",
  "conversion_map_type",
  "conversion_predecessor_body",
  "conversion_schema_snapshot",
  "conversion_source_body",
  "conversion_source_function_0",
  "conversion_source_function_1",
  "conversion_source_function_10",
  "conversion_source_function_2",
  "conversion_source_function_3",
  "conversion_source_function_4",
  "conversion_source_function_5",
  "conversion_source_function_6",
  "conversion_source_function_7",
  "conversion_source_function_8",
  "conversion_source_function_9",
  "conversion_trigger",
  "publication_assert_source_schema",
  "publication_attribute_semantics",
  "publication_authenticate_acl",
  "publication_body",
  "publication_default_profile_boolean_false",
  "publication_default_profile_boolean_false_jsonb_null",
  "publication_default_profile_integer_zero",
  "publication_default_profile_integer_zero_jsonb_null",
  "publication_default_profile_jsonb_null_jsonb_null",
  "publication_default_profile_uuid_null",
  "publication_json",
  "publication_map_reference_attributes",
  "publication_map_reference_constraint",
  "publication_map_reference_relation",
  "publication_reference_constraint_record",
  "publication_reference_schema",
  "publication_reference_trigger_record",
  "publication_relation_semantics",
  "publication_retained_guard_reference",
  "publication_schema_details",
  "publication_slot",
  "publication_source_body",
  "publication_table_snapshot"
]
const tables = [
  "conversion_affected_functions",
  "conversion_enrollment_reference_0",
  "conversion_enrollment_reference_1",
  "conversion_enrollment_reference_2",
  "conversion_enrollment_reference_3",
  "conversion_enrollment_reference_4",
  "conversion_enrollment_reference_5",
  "conversion_enrollment_reference_6",
  "conversion_source_added_triggers",
  "conversion_verified_runtime_snapshot",
  "conversion_verified_schema",
  "publication_argument_defaults",
  "publication_before_installer_details",
  "publication_before_installer_schema",
  "publication_compiled_expressions",
  "publication_expected_current",
  "publication_expression_source",
  "publication_historical_projections",
  "publication_legacy_acl_repairs",
  "publication_predecessor_table_snapshot",
  "publication_reviewed_contracts",
  "publication_successor_templates"
]
const schemas = [
  "conversion_source_reference",
  "publication_source_reference"
]
const authOnly = complete.filter(name => name.startsWith('publication_') || ['conversion_predecessor_body','conversion_function_reference'].includes(name))
export function versionCompilerFunctions(sql, { full, runtimeBodies }) {
  const observed = [...new Set([...sql.matchAll(/CREATE FUNCTION pg_temp\.([a-z0-9_]+)\(/g)].map(match => match[1]))].sort()
  if (JSON.stringify(observed) !== JSON.stringify(full ? complete : authOnly)) throw new Error('conversion_compiler_function_roster_changed')
  const observedTables = [...new Set([...sql.matchAll(/CREATE TEMP TABLE (?:pg_temp\.)?((?:publication|conversion)_[a-z0-9_]+)/g)].map(match => match[1]))].sort()
  const observedSchemas = [...new Set([...sql.matchAll(/CREATE SCHEMA ((?:publication|conversion)_[a-z0-9_]+)/g)].map(match => match[1]))].sort()
  if (JSON.stringify(observedTables) !== JSON.stringify(full ? tables : tables.filter(name => name.startsWith('publication_')))
    || JSON.stringify(observedSchemas) !== JSON.stringify(full ? schemas : ['publication_source_reference'])) throw new Error('conversion_compiler_relation_roster_changed')
  for (const name of [...observed, ...observedTables, ...observedSchemas]) {
    const site = new RegExp('\\b' + name + '\\b', 'g')
    if (runtimeBodies.some(body => site.test(body))) throw new Error('conversion_compiler_runtime_identifier_collision')
    const versioned = 'c8273_' + name
    if (versioned.length > 63) throw new Error('conversion_compiler_identifier_too_long')
    sql = sql.replace(site, versioned)
  }
  return sql
}
