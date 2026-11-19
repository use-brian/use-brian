#!/usr/bin/env python3
"""Apply only to a disposable pristine PostgreSQL18.7 source directory."""
import argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
args = parser.parse_args()
root = args.source.resolve()
if 'AC_INIT([PostgreSQL], [18.7]' not in (root / 'configure.ac').read_text():
    raise SystemExit('Exact PostgreSQL18.7 source required')

def edit(path, before, after, count=1):
    file = root / path
    data = file.read_text()
    if data.count(before) != count:
        raise SystemExit(f'Patch boundary mismatch: {path}: {before[:70]}')
    file.write_text(data.replace(before, after))

header = '''/* Fixture-only post-optimization primitive hook, never a release patch. */
#ifndef M6_PRIMITIVE_H
#define M6_PRIMITIVE_H
typedef void (*m6_primitive_hook_type)(const char *, int, const void *);
extern PGDLLIMPORT m6_primitive_hook_type m6_primitive_hook;
static inline void m6_primitive_emit(const char *kind, int unit, const void *context)
{
    if (m6_primitive_hook) m6_primitive_hook(kind, unit, context);
}
#define M6_BT_COMPARE(info, coll, left, right) \\
 (m6_primitive_emit("btree-comparator", 0, (info)), FunctionCall2Coll(info, coll, left, right))
#endif
'''
(root / 'src/include/m6_primitive.h').write_text(header)
for path in ['src/backend/executor/execExprInterp.c', 'src/backend/access/nbtree/nbtsearch.c',
             'src/backend/access/nbtree/nbtutils.c', 'src/backend/executor/execProcnode.c',
             'src/backend/executor/nodeHash.c', 'src/backend/executor/nodeSubplan.c',
             'src/backend/optimizer/util/clauses.c', 'src/backend/tcop/postgres.c',
             'src/backend/utils/adt/acl.c', 'src/backend/utils/misc/rls.c',
             'src/backend/utils/fmgr/fmgr.c']:
    edit(path, '#include "postgres.h"', '#include "postgres.h"\n#include "m6_primitive.h"')
path = 'src/backend/executor/execExprInterp.c'
edit(path, '#define EEO_CASE(name)\t\tCASE_##name:', '#define EEO_CASE(name)\t\tCASE_##name: if (m6_primitive_hook && ExecEvalStepOp(state, op) == name) m6_primitive_emit("expression:" #name, name, op);')
edit(path, '#define EEO_CASE(name)\t\tcase name:', '#define EEO_CASE(name)\t\tcase name: if (m6_primitive_hook && (ExprEvalOp) op->opcode == name) m6_primitive_emit("expression:" #name, name, op);')
edit(path, 'static Datum ExecInterpExpr(ExprState *state, ExprContext *econtext, bool *isnull);',
     'm6_primitive_hook_type m6_primitive_hook = NULL;\n\nstatic Datum ExecInterpExpr(ExprState *state, ExprContext *econtext, bool *isnull);')
data = (root / path).read_text()
import re
functions = re.findall(r'\n(ExecJust\w+)\(([^;]*?)\)\n\{', data, re.S)
if len(functions) < 20:
    raise SystemExit('Specialized evaluator inventory unexpectedly small')
for name, params in functions:
    before = f'\n{name}({params})\n{{'
    after = before + f'\n\tm6_primitive_emit("specialized:{name}", 0, state);'
    edit(path, before, after)

# These evaluator branches call the operator directly through fn_addr, so the
# generic function-manager hook cannot distinguish their executed callbacks.
for kind, call in [
    ('linear-compare', 'thisresult = fcinfo->flinfo->fn_addr(fcinfo);'),
    ('hash-key', 'hash = elements_tab->hash_finfo.fn_addr(fcinfo);'),
    ('hash-equality', 'result = elements_tab->op->d.hashedscalararrayop.finfo->fn_addr(fcinfo);'),
    ('hash-null-compare', 'result = op->d.hashedscalararrayop.finfo->fn_addr(fcinfo);'),
]:
    data = (root / path).read_text()
    dispatches = re.findall(rf'^(\t+){re.escape(call)}$', data, re.M)
    if len(dispatches) != 1:
        raise SystemExit(f'Scalar array dispatch boundary mismatch: {kind}')
    indent = dispatches[0]
    edit(path, indent + call, f'{indent}m6_primitive_emit("scalar-array:{kind}", fcinfo->flinfo->fn_oid, fcinfo);\n{indent}{call}')

for path in ['src/backend/access/nbtree/nbtsearch.c', 'src/backend/access/nbtree/nbtutils.c']:
    file = root / path
    # Instrument actual comparison dispatch, including short-circuited array/row
    # key branches. C assertions remain assertions and do not run in this build.
    data = file.read_text()
    if 'FunctionCall2Coll(' not in data:
        raise SystemExit(f'No btree comparator sites: {path}')
    file.write_text(data.replace('FunctionCall2Coll(', 'M6_BT_COMPARE('))

for path in ['src/include/executor/executor.h', 'src/include/utils/sortsupport.h', 'src/include/fmgr.h']:
    file = root / path
    data = file.read_text()
    at = data.find('\n#include ')
    if at < 0:
        guard = re.search(r'^#define [A-Z_]+_H\s*$', data, re.M)
        if not guard:
            raise SystemExit(f'Header include boundary missing: {path}')
        at = guard.end()
    file.write_text(data[:at] + '\n#include "m6_primitive.h"' + data[at:])
edit('src/include/executor/executor.h', '\treturn node->ExecProcNode(node);',
     '\tm6_primitive_emit("plan-node", nodeTag(node), node);\n\treturn node->ExecProcNode(node);')
edit('src/backend/executor/execProcnode.c', 'MultiExecProcNode(PlanState *node)\n{\n\tNode\t   *result;',
     'MultiExecProcNode(PlanState *node)\n{\n\tNode\t   *result;\n\tm6_primitive_emit("plan-node", nodeTag(node), node);')
sort_header = 'src/include/utils/sortsupport.h'
edit(sort_header, '''ApplySortComparator(Datum datum1, bool isNull1,
					Datum datum2, bool isNull2,
					SortSupport ssup)''', '''ApplyObservedSortComparator(Datum datum1, bool isNull1,
					Datum datum2, bool isNull2,
					SortSupport ssup, const char *unit)''')
edit(sort_header, '\t\tcompare = ssup->comparator(datum1, datum2, ssup);',
     '\t\tm6_primitive_emit(unit, 0, ssup);\n\t\tcompare = ssup->comparator(datum1, datum2, ssup);')
edit(sort_header, 'static inline int\nApplyUnsignedSortComparator', '''static inline int
ApplySortComparator(Datum datum1, bool isNull1, Datum datum2, bool isNull2, SortSupport ssup)
{
	return ApplyObservedSortComparator(datum1, isNull1, datum2, isNull2, ssup, "sort-comparator");
}

static inline int
ApplyUnsignedSortComparator''')
edit(sort_header, '\t\tcompare = datum1 < datum2 ? -1 : datum1 > datum2 ? 1 : 0;',
     '\t\tm6_primitive_emit("sort-unsigned-comparison", 0, ssup);\n\t\tcompare = datum1 < datum2 ? -1 : datum1 > datum2 ? 1 : 0;')
edit(sort_header, '\t\tcompare = DatumGetInt64(datum1) < DatumGetInt64(datum2) ? -1 :',
     '\t\tm6_primitive_emit("sort-signed-comparison", 0, ssup);\n\t\tcompare = DatumGetInt64(datum1) < DatumGetInt64(datum2) ? -1 :')
edit(sort_header, '\t\tcompare = DatumGetInt32(datum1) < DatumGetInt32(datum2) ? -1 :',
     '\t\tm6_primitive_emit("sort-int32-comparison", 0, ssup);\n\t\tcompare = DatumGetInt32(datum1) < DatumGetInt32(datum2) ? -1 :')
edit(sort_header, '\t\tcompare = ssup->abbrev_full_comparator(datum1, datum2, ssup);',
     '\t\tm6_primitive_emit("sort-abbrev-full-comparator", 0, ssup);\n\t\tcompare = ssup->abbrev_full_comparator(datum1, datum2, ssup);')
edit('src/backend/executor/nodeMergejoin.c', '''result = ApplySortComparator(clause->ldatum, clause->lisnull,
									 clause->rdatum, clause->risnull,
									 &clause->ssup);''', '''result = ApplyObservedSortComparator(clause->ldatum, clause->lisnull,
									 clause->rdatum, clause->risnull,
									 &clause->ssup, "merge-join-key-comparator");''')
edit('src/backend/executor/nodeHash.c', '\t\t\tif (ExecQualAndReset(hjclauses, econtext))',
     '\t\t\tm6_primitive_emit("hash-join-tuple-qualification", 0, hjstate);\n\t\t\tif (ExecQualAndReset(hjclauses, econtext))', count=2)
edit('src/backend/executor/nodeSubplan.c', '\t\tif (!DatumGetBool(FunctionCall2Coll(&eqfunctions[i],',
     '\t\tm6_primitive_emit("hashed-subplan-null-key-comparator", eqfunctions[i].fn_oid, &eqfunctions[i]);\n\t\tif (!DatumGetBool(FunctionCall2Coll(&eqfunctions[i],')
edit('src/include/fmgr.h', '#define FunctionCallInvoke(fcinfo)\t((* (fcinfo)->flinfo->fn_addr) (fcinfo))',
     '#define FunctionCallInvoke(fcinfo) (m6_primitive_emit("fmgr-invoke", (fcinfo)->flinfo->fn_oid, (fcinfo)), ((* (fcinfo)->flinfo->fn_addr) (fcinfo)))')

# A folded function executes before ExecutorStart. Distinguish actual evaluation
# from estimator-only evaluations, successful inline expansion, and NULL folding
# that executes no function. The expression event also covers non-function folds.
clauses = 'src/backend/optimizer/util/clauses.c'
edit(clauses, '\tif (funcform->proisstrict && has_null_input)\n\t\treturn (Expr *) makeNullConst(result_type, result_typmod,\n\t\t\t\t\t\t\t\t\t  result_collid);', '''
	if (funcform->proisstrict && has_null_input)
	{
		m6_primitive_emit("planner:strict-null-elision", funcid, NULL);
		return (Expr *) makeNullConst(result_type, result_typmod, result_collid);
	}'''.lstrip('\n'))
edit(clauses, '\treturn evaluate_expr((Expr *) newexpr, result_type, result_typmod,\n\t\t\t\t\t\t result_collid);',
     '\tm6_primitive_emit(context->estimate ? "planner:estimator-function" : "planner:constant-function", funcid, NULL);\n\treturn evaluate_expr((Expr *) newexpr, result_type, result_typmod,\n\t\t\t\t\t\t result_collid);')
edit(clauses, '''	if (!newexpr && allow_non_const)
		newexpr = inline_function(funcid, result_type, result_collid,
								  input_collid, args, funcvariadic,
								  func_tuple, context);''', '''	if (!newexpr && allow_non_const)
	{
		newexpr = inline_function(funcid, result_type, result_collid,
								  input_collid, args, funcvariadic,
								  func_tuple, context);
		if (newexpr)
			m6_primitive_emit("planner:sql-inline", funcid, NULL);
	}''')
edit(clauses, '\tconst_val = ExecEvalExprSwitchContext(exprstate,',
     '\tm6_primitive_emit("planner:constant-expression-eval", nodeTag(expr), NULL);\n\tconst_val = ExecEvalExprSwitchContext(exprstate,')

tcop = 'src/backend/tcop/postgres.c'
edit(tcop, '/*\n * Given a raw parsetree (gram.y output),', '''static List *
m6_profile_query_rewrite(Query *query, const char *query_string)
{
	List *result;

	if (!m6_primitive_hook)
		return pg_rewrite_query(query);
	m6_primitive_emit("scope:rewrite:start", 0, query_string);
	PG_TRY();
	{
		result = pg_rewrite_query(query);
	}
	PG_CATCH();
	{
		m6_primitive_emit("scope:rewrite:error", 0, NULL);
		PG_RE_THROW();
	}
	PG_END_TRY();
	m6_primitive_emit("scope:rewrite:end", 0, NULL);
	return result;
}

/*
 * Given a raw parsetree (gram.y output),''')
edit(tcop, '\tquerytree_list = pg_rewrite_query(query);',
     '\tquerytree_list = m6_profile_query_rewrite(query, query_string);', count=3)

# Observe real permission decisions/data visits in previously opaque engine
# routines. No relation, principal or grant IDs enter the captured inventory.
acl = 'src/backend/utils/adt/acl.c'
acl_source = (root / acl).read_text()
start, end = acl_source.index('\naclmask(const Acl'), acl_source.index('\naclmask_direct(const Acl')
section = acl_source[start:end]
visit = '\t\tAclItem    *aidata = &aidat[i];'
if section.count(visit) != 2:
    raise SystemExit('ACL entry visit boundary mismatch')
direct = visit + '\n\n\t\tm6_primitive_emit("permission:acl-direct-entry", 0, NULL);'
indirect = visit + '\n\n\t\tm6_primitive_emit("permission:acl-inherited-entry", 0, NULL);'
first, second, tail = section.split(visit)
(root / acl).write_text(acl_source[:start] + first + direct + second + indirect + tail + acl_source[end:])
edit(acl, '''	if (cached_role[type] == roleid && !OidIsValid(admin_of) &&
		OidIsValid(cached_role[type]))
		return cached_roles[type];''', '''	if (cached_role[type] == roleid && !OidIsValid(admin_of) &&
		OidIsValid(cached_role[type]))
	{
		m6_primitive_emit("permission:role-cache-hit", type, NULL);
		return cached_roles[type];
	}''')
edit(acl, '\t\t\tOid\t\t\totherid = form->roleid;\n\n\t\t\t/*',
     '\t\t\tOid\t\t\totherid = form->roleid;\n\n\t\t\tm6_primitive_emit("permission:role-membership-grant-visit", type, NULL);\n\t\t\t/*')
edit(acl, '''has_privs_of_role(Oid member, Oid role)
{
	/* Fast path for simple case */''', '''has_privs_of_role(Oid member, Oid role)
{
	List *roles;
	ListCell *cell;

	m6_primitive_emit("permission:role-self-compare", 0, NULL);
	/* Fast path for simple case */''')
edit(acl, '''	return list_member_oid(roles_is_member_of(member, ROLERECURSE_PRIVS,
											  InvalidOid, NULL),
						   role);''', '''	roles = roles_is_member_of(member, ROLERECURSE_PRIVS, InvalidOid, NULL);
	if (!m6_primitive_hook)
		return list_member_oid(roles, role);
	foreach(cell, roles)
	{
		m6_primitive_emit("permission:role-inherited-compare", 0, NULL);
		if (lfirst_oid(cell) == role)
			return true;
	}
	return false;''')

rls = 'src/backend/utils/misc/rls.c'
edit(rls, '\t\treturn RLS_NONE;', '\t\treturn (m6_primitive_emit("permission:rls-not-applicable", 0, NULL), RLS_NONE);', count=3)
edit(rls, '\t\treturn RLS_NONE_ENV;', '\t\treturn (m6_primitive_emit("permission:rls-bypassed", 0, NULL), RLS_NONE_ENV);', count=2)
edit(rls, '\treturn RLS_ENABLED;', '\treturn (m6_primitive_emit("permission:rls-applied", 0, NULL), RLS_ENABLED);')
edit('src/backend/utils/fmgr/fmgr.c', '\t\tpgstat_init_function_usage(fcinfo, &fcusage);\n\n\t\tresult = FunctionCallInvoke(fcinfo);',
     '\t\tpgstat_init_function_usage(fcinfo, &fcusage);\n\n\t\tif (OidIsValid(fcache->userid))\n\t\t\tm6_primitive_emit("permission:definer-body-entry", 0, NULL);\n\t\tresult = FunctionCallInvoke(fcinfo);')
print(f'Patched {root}; specialized evaluator entry sites: {len(functions)}')
