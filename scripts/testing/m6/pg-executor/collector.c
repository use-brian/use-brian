/* Fixture-only PG18.7 executor feasibility collector. No tree rewrites. */
#include "postgres.h"
#include "access/xact.h"
#include "fmgr.h"
#include "m6_primitive.h"
#include "executor/executor.h"
#include "executor/execExpr.h"
#include "nodes/nodeFuncs.h"
#include "nodes/print.h"
#include "optimizer/planner.h"
#include "utils/builtins.h"
#include "utils/json.h"
#include "utils/lsyscache.h"
#include "utils/memutils.h"
#include "commands/defrem.h"
#include "jit/jit.h"
#include "utils/guc.h"
#include <fcntl.h>
#include <unistd.h>

PG_MODULE_MAGIC;
PG_FUNCTION_INFO_V1(m6_probe_arm);
PG_FUNCTION_INFO_V1(m6_probe_result);
PGDLLEXPORT void _PG_init(void);

#define MAX_COUNTERS 2048
#define MAX_NODES 512
#define MAX_SCOPE_DEPTH 64
typedef enum { EXECUTION, PLANNING, REWRITE } ProbePhase;
typedef struct
{
    struct { const char *kind; int unit; uint64 calls; ProbePhase phase; } items[MAX_COUNTERS];
    int used;
    bool overflow;
} CounterSet;
static CounterSet executor_counters, preparation_counters;
static struct { int tag; Oid index; uint64 calls; } nodes[MAX_NODES];
static int node_used;
static bool requested, active, overflow, jit_seen;
static bool capture_queries;
static char *output_file;
static QueryDesc *root;
static char *chosen_plan;
static const char *release_owner;
static uint64 nested_executor_starts;
static ProbePhase scope_stack[MAX_SCOPE_DEPTH];
static int scope_depth;
static bool scope_active;
static const char *scope_owner;
static planner_hook_type previous_planner;
static ExecutorStart_hook_type previous_start;
static ExecutorEnd_hook_type previous_end;

static const char *phase_name(ProbePhase phase)
{
    switch (phase)
    {
        case EXECUTION: return "execution";
        case PLANNING: return "planning";
        case REWRITE: return "rewrite";
    }
    return "unknown";
}

/* Report names from the exercised protocol, never the statement or arguments. */
static const char *owner_for_statement(const char *statement)
{
    if (!statement) return NULL;
    if (strstr(statement, "public.admit_native_turn_conversation_records(") != NULL)
        return "admit_native_turn_conversation_records";
    if (strstr(statement, "public.capture_native_turn_conversation_record(") != NULL)
        return "capture_native_turn_conversation_record";
    if (strstr(statement, "capture_conversation_evidence(") != NULL)
        return "capture_conversation_evidence";
    return NULL;
}

static bool should_capture(const char *statement)
{
    return statement && (capture_queries || strncmp(statement, "/* m6-measure */", 16) == 0);
}

static void append_counters(StringInfo json, const CounterSet *counters)
{
    int i;
    appendStringInfoChar(json, '[');
    for (i = 0; i < counters->used; i++)
    {
        if (i) appendStringInfoChar(json, ',');
        appendStringInfoString(json, "{\"kind\":"); escape_json(json, counters->items[i].kind);
        appendStringInfo(json, ",\"unit\":%d,\"calls\":%llu,\"phase\":", counters->items[i].unit,
                         (unsigned long long)counters->items[i].calls);
        escape_json(json, phase_name(counters->items[i].phase));
        appendStringInfoChar(json, '}');
    }
    appendStringInfoChar(json, ']');
}

static void write_capture(const char *text)
{
    char *line;
    int fd;
    if (!output_file || !output_file[0]) return;
    line = psprintf("%s\n", text);
    fd = open(output_file, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd < 0 || write(fd, line, strlen(line)) != strlen(line))
        ereport(WARNING, (errmsg("m6 fixture primitive output incomplete")));
    if (fd >= 0) close(fd);
    pfree(line);
}

static void begin_scope(ProbePhase phase, const char *statement)
{
    if (scope_depth == 0)
    {
        scope_active = root ? active : should_capture(statement) && (requested || capture_queries);
        scope_owner = root ? release_owner : owner_for_statement(statement);
        if (!root && scope_active && capture_queries)
        {
            preparation_counters.used = 0;
            preparation_counters.overflow = false;
        }
    }
    if (scope_depth < MAX_SCOPE_DEPTH) scope_stack[scope_depth] = phase;
    else if (scope_active) (root ? &executor_counters : &preparation_counters)->overflow = true;
    scope_depth++;
}

static void end_scope(bool succeeded)
{
    if (scope_depth <= 0 || --scope_depth != 0) return;
    if (!root && scope_active && capture_queries)
    {
        StringInfoData json;
        initStringInfo(&json);
        appendStringInfoString(&json, "{\"collectorEnabled\":true,\"phase\":");
        escape_json(&json, phase_name(scope_stack[0]));
        appendStringInfoString(&json, ",\"releaseOwner\":");
        if (scope_owner) escape_json(&json, scope_owner);
        else appendStringInfoString(&json, "null");
        appendStringInfo(&json, ",\"overflow\":%s,\"succeeded\":%s,\"counters\":",
                         preparation_counters.overflow ? "true" : "false", succeeded ? "true" : "false");
        append_counters(&json, &preparation_counters);
        appendStringInfoChar(&json, '}');
        write_capture(json.data);
        pfree(json.data);
    }
    scope_active = false;
}

static void finish_transaction(XactEvent event, void *arg)
{
    /* An aborted top-level statement need not call ExecutorEnd. */
    if (event == XACT_EVENT_ABORT || event == XACT_EVENT_PARALLEL_ABORT)
    {
        root = NULL;
        active = false;
        scope_depth = 0;
        scope_active = false;
    }
}

static void primitive(const char *kind, int unit, const void *context)
{
    int i;
    ProbePhase phase;
    CounterSet *counters;
    if (strcmp(kind, "scope:rewrite:start") == 0) { begin_scope(REWRITE, context); return; }
    if (strcmp(kind, "scope:rewrite:end") == 0) { end_scope(true); return; }
    if (strcmp(kind, "scope:rewrite:error") == 0) { end_scope(false); return; }
    if (scope_depth)
    {
        if (!scope_active || scope_depth > MAX_SCOPE_DEPTH) return;
        if (strncmp(kind, "permission:", 11) && strncmp(kind, "planner:", 8)) return;
        phase = scope_stack[scope_depth - 1];
    }
    else
    {
        if (!active) return;
        phase = EXECUTION;
    }
    counters = root ? &executor_counters : &preparation_counters;
    if (strcmp(kind, "plan-node") == 0)
    {
        const PlanState *state = context;
        const Plan *plan = state->plan;
        Oid index = InvalidOid;
        if (IsA(plan, IndexScan)) index = ((const IndexScan *)plan)->indexid;
        if (IsA(plan, IndexOnlyScan)) index = ((const IndexOnlyScan *)plan)->indexid;
        if (IsA(plan, BitmapIndexScan)) index = ((const BitmapIndexScan *)plan)->indexid;
        for (i = 0; i < node_used; i++) if (nodes[i].tag == nodeTag(plan) && nodes[i].index == index) break;
        if (i == MAX_NODES) { overflow = true; return; }
        if (i == node_used) { nodes[i].tag = nodeTag(plan); nodes[i].index = index; nodes[i].calls = 0; node_used++; }
        nodes[i].calls++;
        return;
    }
    for (i = 0; i < counters->used; i++)
        if (counters->items[i].unit == unit && counters->items[i].phase == phase && strcmp(counters->items[i].kind, kind) == 0) break;
    if (i == MAX_COUNTERS) { counters->overflow = true; return; }
    if (i == counters->used)
    {
        counters->items[i].kind = kind;
        counters->items[i].unit = unit;
        counters->items[i].calls = 0;
        counters->items[i].phase = phase;
        counters->used++;
    }
    counters->items[i].calls++;
}

static PlannedStmt *plan(Query *parse, const char *query_string, int cursor_options, ParamListInfo bound_params)
{
    PlannedStmt *result;
    begin_scope(PLANNING, query_string);
    PG_TRY();
    {
        result = previous_planner ? previous_planner(parse, query_string, cursor_options, bound_params)
                                  : standard_planner(parse, query_string, cursor_options, bound_params);
    }
    PG_CATCH();
    {
        end_scope(false);
        PG_RE_THROW();
    }
    PG_END_TRY();
    end_scope(true);
    return result;
}

static void start(QueryDesc *desc, int flags)
{
    if (root != NULL && active && scope_depth == 0)
        nested_executor_starts++;
    else if (root == NULL && scope_depth == 0 && should_capture(desc->sourceText))
    {
        if (!capture_queries)
        {
            MemoryContext old = MemoryContextSwitchTo(TopMemoryContext);
            if (chosen_plan) pfree(chosen_plan);
            chosen_plan = nodeToString(desc->plannedstmt);
            MemoryContextSwitchTo(old);
        }
        executor_counters.used = node_used = 0;
        executor_counters.overflow = overflow = jit_seen = false;
        nested_executor_starts = 0;
        release_owner = owner_for_statement(desc->sourceText);
        root = desc; active = requested || capture_queries;
    }
    if (previous_start) previous_start(desc, flags); else standard_ExecutorStart(desc, flags);
}

static void end(QueryDesc *desc)
{
    if (root == desc)
    {
        if (desc->estate->es_jit && desc->estate->es_jit->instr.created_functions) jit_seen = true;
        active = false; root = NULL;
        if (capture_queries)
        {
            Datum value = m6_probe_result(NULL);
            char *text = DatumGetCString(DirectFunctionCall1(jsonb_out, value));
            write_capture(text);
            pfree(text);
        }
    }
    if (previous_end) previous_end(desc); else standard_ExecutorEnd(desc);
}

static const char *plan_name(int tag)
{
    switch (tag)
    {
        case T_Result: return "Result";
        case T_SeqScan: return "SeqScan";
        case T_IndexScan: return "IndexScan";
        case T_IndexOnlyScan: return "IndexOnlyScan";
        case T_BitmapHeapScan: return "BitmapHeapScan";
        case T_BitmapIndexScan: return "BitmapIndexScan";
        case T_Hash: return "Hash";
        case T_HashJoin: return "HashJoin";
        case T_MergeJoin: return "MergeJoin";
        case T_NestLoop: return "NestLoop";
        case T_Sort: return "Sort";
        case T_Material: return "Material";
        case T_Limit: return "Limit";
        case T_Agg: return "Agg";
        case T_Append: return "Append";
        case T_CteScan: return "CteScan";
        case T_FunctionScan: return "FunctionScan";
        case T_Gather: return "Gather";
        case T_GatherMerge: return "GatherMerge";
        case T_Group: return "Group";
        case T_IncrementalSort: return "IncrementalSort";
        case T_LockRows: return "LockRows";
        case T_Memoize: return "Memoize";
        case T_ModifyTable: return "ModifyTable";
        case T_ProjectSet: return "ProjectSet";
        case T_RecursiveUnion: return "RecursiveUnion";
        case T_SetOp: return "SetOp";
        case T_SubqueryScan: return "SubqueryScan";
        case T_Unique: return "Unique";
        case T_ValuesScan: return "ValuesScan";
        case T_WorkTableScan: return "WorkTableScan";
        default: return NULL;
    }
}

/* A node can be named in the inventory without complete primitive calibration. */
static bool calibrated_node(int tag)
{
    switch (tag)
    {
        case T_Result: case T_SeqScan: case T_IndexScan: case T_IndexOnlyScan:
        case T_BitmapHeapScan: case T_BitmapIndexScan: case T_Hash: case T_HashJoin:
        case T_MergeJoin: case T_NestLoop: case T_Sort: case T_Material: case T_Limit:
            return true;
        default:
            return false;
    }
}

Datum m6_probe_arm(PG_FUNCTION_ARGS)
{
    requested = PG_GETARG_BOOL(0);
    preparation_counters.used = 0;
    preparation_counters.overflow = false;
    PG_RETURN_VOID();
}

Datum m6_probe_result(PG_FUNCTION_ARGS)
{
    StringInfoData json;
    int i;
    bool complete = (requested || capture_queries) && !overflow && !executor_counters.overflow
                    && !jit_seen && node_used > 0;
    initStringInfo(&json);
    appendStringInfoString(&json, "{\"chosenPlan\":");
    escape_json(&json, chosen_plan ? chosen_plan : "");
    appendStringInfoString(&json, ",\"releaseOwner\":");
    if (release_owner) escape_json(&json, release_owner);
    else appendStringInfoString(&json, "null");
    appendStringInfo(&json, ",\"nestedExecutorStarts\":%llu", (unsigned long long)nested_executor_starts);
    appendStringInfo(&json, ",\"phase\":\"execution\",\"collectorEnabled\":%s,\"overflow\":%s,\"executedJit\":%s,\"counters\":",
        requested || capture_queries ? "true" : "false", overflow || executor_counters.overflow ? "true" : "false", jit_seen ? "true" : "false");
    append_counters(&json, &executor_counters);
    if (!capture_queries)
    {
        appendStringInfo(&json, ",\"preparationOverflow\":%s,\"preparationCounters\":", preparation_counters.overflow ? "true" : "false");
        append_counters(&json, &preparation_counters);
    }
    appendStringInfoString(&json, ",\"executedNodes\":[");
    for (i = 0; i < node_used; i++)
    {
        const char *name = plan_name(nodes[i].tag);
        char *am = OidIsValid(nodes[i].index) ? get_am_name(get_rel_relam(nodes[i].index)) : NULL;
        bool calibrated = calibrated_node(nodes[i].tag) && (!am || strcmp(am, "btree") == 0);
        if (!calibrated) complete = false;
        if (i) appendStringInfoChar(&json, ',');
        appendStringInfoString(&json, "{\"node\":"); escape_json(&json, name ? name : "unsupported");
        appendStringInfo(&json, ",\"tag\":%d,\"calls\":%llu,\"am\":", nodes[i].tag, (unsigned long long)nodes[i].calls);
        if (am) escape_json(&json, am); else appendStringInfoString(&json, "null");
        appendStringInfo(&json, ",\"calibrated\":%s", calibrated ? "true" : "false");
        appendStringInfoChar(&json, '}');
    }
    appendStringInfo(&json, "],\"calibrationCoverageComplete\":%s,\"physicalPermissionCoverageComplete\":false}", complete ? "true" : "false");
    PG_RETURN_DATUM(DirectFunctionCall1(jsonb_in, CStringGetDatum(json.data)));
}

void _PG_init(void)
{
    DefineCustomBoolVariable("m6_probe.capture", "Capture owned fixture query inventory", NULL, &capture_queries, false, PGC_SUSET, 0, NULL, NULL, NULL);
    DefineCustomStringVariable("m6_probe.output", "Owned fixture query inventory output", NULL, &output_file, "", PGC_SUSET, 0, NULL, NULL, NULL);
    if (m6_primitive_hook) ereport(ERROR, (errmsg("Another fixture primitive collector is installed")));
    m6_primitive_hook = primitive;
    previous_planner = planner_hook; planner_hook = plan;
    previous_start = ExecutorStart_hook; ExecutorStart_hook = start;
    previous_end = ExecutorEnd_hook; ExecutorEnd_hook = end;
    RegisterXactCallback(finish_transaction, NULL);
}
