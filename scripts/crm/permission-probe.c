/* [COMP:crm/permission-budget] Disposable PostgreSQL 18 CRM regression instrumentation. Never install in a product DB.
 * Count function entries (including SQL bodies that would otherwise inline), explicit
 * digest calls and evaluated RLS qualifications. No arguments or results are retained.
 * Public entries conservatively include business helpers. Direct predicate coverage
 * is partial and its wrappers can change plans: this is not a ceiling certificate.
 */
#include "postgres.h"
#include "common/cryptohash.h"
#include "fmgr.h"
#include "catalog/pg_namespace_d.h"
#include "catalog/pg_proc.h"
#include "catalog/pg_type_d.h"
#include "catalog/pg_language_d.h"
#include "nodes/plannodes.h"
#include "access/transam.h"
#include "nodes/nodeFuncs.h"
#include "nodes/makefuncs.h"
#include "parser/parsetree.h"
#include "optimizer/planner.h"
#include "parser/parse_func.h"
#include "utils/builtins.h"
#include "utils/fmgroids.h"
#include "utils/lsyscache.h"
#include "utils/syscache.h"
#include "lib/stringinfo.h"
#include "utils/jsonb.h"
#include "executor/spi.h"

PG_MODULE_MAGIC;
PG_FUNCTION_INFO_V1(crm_probe_begin);
PG_FUNCTION_INFO_V1(crm_probe_end);
PG_FUNCTION_INFO_V1(crm_probe_plan_begin);
PG_FUNCTION_INFO_V1(crm_probe_observe_begin);
PG_FUNCTION_INFO_V1(crm_probe_hash);
PG_FUNCTION_INFO_V1(crm_probe_rls);
PG_FUNCTION_INFO_V1(crm_probe_predicate);
PG_FUNCTION_INFO_V1(crm_probe_direct);

#define MAX_ENTRIES 8192
static struct {Oid oid; uint64 calls;} entries[MAX_ENTRIES];
static int used;
#define MAX_EDGES 4096
#define MAX_DEPTH 1024
static struct {Oid root; Oid caller; Oid callee; uint64 calls;} edges[MAX_EDGES];
static Oid call_stack[MAX_DEPTH];
static int edge_count, call_depth;
static struct {Oid root;Oid caller;uint64 calls;} direct_edges[MAX_EDGES];
static int direct_edge_count;
static uint64 hashes, privileges, predicates, application_predicates, direct_predicates;
static bool enabled;
static bool preserve_plans, observe_only;
#define MAX_PLANS 4096
static struct {char hash[65];uint64 calls;} plans[MAX_PLANS];
static int plan_count;
static int planning_depth;
static uint64 unobserved_index_quals, unobserved_join_keys, unsupported_plans, unobserved_sql_functions;
static needs_fmgr_hook_type previous_needs;
static fmgr_hook_type previous_hook;
static planner_hook_type previous_planner;
static Oid rls_oid, direct_oid;
#define MAX_BUILTINS 256
static struct {Oid original; Oid replacement; bool hash;} hash_map[MAX_BUILTINS];
static int builtin_count;


static bool probe_needs(Oid oid) {
 if(observe_only)return previous_needs?previous_needs(oid):false;
 /* pg_catalog's C fast path cannot use fmgr_hook. Explicit hash calls are
  * replaced below with identical C dispatch. SQL/public functions use the hook. */
 if(preserve_plans && planning_depth>0) {
  HeapTuple tuple=SearchSysCache1(PROCOID,ObjectIdGetDatum(oid));
  if(!HeapTupleIsValid(tuple)) return previous_needs?previous_needs(oid):false;
  Form_pg_proc proc=(Form_pg_proc)GETSTRUCT(tuple);
  bool sql=proc->prolang==SQLlanguageId;
  ReleaseSysCache(tuple);
  /* Keep normal SQL inlining while the planner runs. Executor initialization
   * happens afterward, when actual non-inlined SQL calls can use fmgr_hook. */
  if(sql) {if(enabled)unobserved_sql_functions++;return previous_needs?previous_needs(oid):false;}
 }
 return true;
}
static void probe_hook(FmgrHookEventType event,FmgrInfo *flinfo,Datum *arg) {
 if (enabled && !observe_only && get_func_namespace(flinfo->fn_oid)==PG_PUBLIC_NAMESPACE) {
  if(event==FHET_START) {
  int i; for(i=0;i<used;i++) if(entries[i].oid==flinfo->fn_oid) break;
  if(i==MAX_ENTRIES) {enabled=false;ereport(ERROR,(errmsg("CRM permission probe capacity exceeded")));}
  if(i==used) {entries[used].oid=flinfo->fn_oid;entries[used++].calls=0;}
  entries[i].calls++;
  Oid caller=call_depth?call_stack[call_depth-1]:InvalidOid;
  Oid root=call_depth?call_stack[0]:flinfo->fn_oid;
  int edge;for(edge=0;edge<edge_count;edge++) if(edges[edge].root==root && edges[edge].caller==caller && edges[edge].callee==flinfo->fn_oid) break;
  if(edge==MAX_EDGES || call_depth==MAX_DEPTH) {enabled=false;ereport(ERROR,(errmsg("CRM permission probe call graph capacity exceeded")));}
  if(edge==edge_count) {edges[edge].root=root;edges[edge].caller=caller;edges[edge].callee=flinfo->fn_oid;edges[edge_count++].calls=0;}
  edges[edge].calls++;call_stack[call_depth++]=flinfo->fn_oid;
  } else if(event==FHET_END || event==FHET_ABORT) {
   if(call_depth==0 || call_stack[call_depth-1]!=flinfo->fn_oid) {enabled=false;ereport(ERROR,(errmsg("CRM permission probe call stack mismatch")));}
   call_depth--;
  }
 }
 if(previous_hook) previous_hook(event,flinfo,arg);
}
static Oid probe_oid(const char *name,int n,Oid *args) {
 return LookupFuncName(list_make2(makeString("crm_permission_probe"),makeString(pstrdup(name))),n,args,false);
}
/* Explicit relational version/hold/authority checks in the CRM proof path.
 * Keep this feed separate: it demonstrates why function-entry totals alone
 * cannot certify the whole permission budget. Index/planning changes caused by
 * the volatile identity wrapper are checked against an unhooked result. */
static bool direct_var(Node *node,void *context) {
 if(!node || !context) return false;
 if(IsA(node,Query)) return false;
 if(IsA(node,Var)) {
  Var *var=(Var*)node; Query *query=(Query*)context;
  if(var->varlevelsup || var->varno<=0 || var->varno>list_length(query->rtable) || var->varattno<=0) return false;
  RangeTblEntry *rte=rt_fetch(var->varno,query->rtable);
  if(rte->rtekind!=RTE_RELATION) return false;
  char *table=get_rel_name(rte->relid),*column=get_attname(rte->relid,var->varattno,false);
  if(!table || !column) return false;
  if(strcmp(table,"workspace_members")==0 || strcmp(table,"scope_resource_states")==0
   || strcmp(table,"scope_derivations")==0 || strcmp(table,"scope_derivation_sources")==0
   || strncmp(table,"application_field_",18)==0 || strcmp(table,"application_query_domains")==0
   || strcmp(table,"application_native_resource_owners")==0) return true;
  if(strcmp(table,"entities")==0 || strcmp(table,"scope_rows")==0) {
   const char *names[]={"scope_version","scope_held","user_id","assistant_id","sensitivity","compartments","project_ids","valid_to","retracted_at","superseded_by",NULL};
   for(int i=0;names[i];i++) if(strcmp(column,names[i])==0) return true;
  }
  return false;
 }
 return expression_tree_walker(node,direct_var,context);
}
static Node *direct_wrap(Node *node) {
 return (Node*)makeFuncExpr(direct_oid,BOOLOID,list_make1(node),InvalidOid,InvalidOid,COERCE_EXPLICIT_CALL);
}
static Node *probe_expression(Node *node,void *context) {
 if(!node) return NULL;
 if(IsA(node,Query)) {
  Query *input=(Query*)copyObject(node);List *saved=NIL;ListCell *entry;
  foreach(entry,input->rtable) {RangeTblEntry *rte=lfirst_node(RangeTblEntry,entry);saved=lappend(saved,rte->securityQuals);rte->securityQuals=NIL;}
  Query *copy=query_tree_mutator(input,probe_expression,input,0);
  int index=0;foreach(entry,copy->rtable) {RangeTblEntry *rte=lfirst_node(RangeTblEntry,entry);rte->securityQuals=list_nth(saved,index++);}
  ListCell *item;
  foreach(item,copy->rtable) {
   RangeTblEntry *rte=lfirst_node(RangeTblEntry,item); List *quals=NIL;ListCell *qual;
   foreach(qual,rte->securityQuals) {
    FuncExpr *wrapped=makeNode(FuncExpr);
    wrapped->funcid=rls_oid;wrapped->funcresulttype=BOOLOID;wrapped->funcretset=false;
    wrapped->funcvariadic=false;wrapped->funcformat=COERCE_EXPLICIT_CALL;
    wrapped->args=list_make1(probe_expression(lfirst(qual),NULL));wrapped->location=-1;
    quals=lappend(quals,wrapped);
   }
   rte->securityQuals=quals;
  }
  return (Node*)copy;
 }
 if(direct_oid && context && ((IsA(node,OpExpr) && ((OpExpr*)node)->opresulttype==BOOLOID)
  || IsA(node,NullTest) || IsA(node,ScalarArrayOpExpr) || (IsA(node,Var) && ((Var*)node)->vartype==BOOLOID)) && direct_var(node,context)) {
  /* One raw predicate invocation, without also counting its inner operands. */
  return direct_wrap(expression_tree_mutator(node,probe_expression,NULL));
 }
 if(IsA(node,FuncExpr)) {
  FuncExpr *copy=(FuncExpr*)expression_tree_mutator(node,probe_expression,context);
  for(int i=0;i<builtin_count;i++) if(copy->funcid==hash_map[i].original) {
   copy->funcid=hash_map[i].replacement;break;
  }
  return (Node*)copy;
 }
 return expression_tree_mutator(node,probe_expression,context);
}
/* Post-planner calibration mode. No raw Query mutation and no changed scan or
 * join keys. Missing key/function coverage is explicit, never a passing count.
 * This mode is intentionally a diagnostic until all uncovered feeds are proved. */
static Node *probe_planned_expression(Node *node,void *context) {
 if(!node)return NULL;
 /* Hashed SubPlans compile their testexpr as an operator-key descriptor,
  * not as an ordinary Boolean expression. Preserve it like HashJoin keys. */
 if(IsA(node,SubPlan) && ((SubPlan*)node)->useHashTable) {
  SubPlan *copy=(SubPlan*)copyObject(node);
  unobserved_join_keys++;
  copy->args=(List*)probe_planned_expression((Node*)copy->args,NULL);
  return (Node*)copy;
 }
 bool predicate=(IsA(node,OpExpr) && ((OpExpr*)node)->opresulttype==BOOLOID)
  || IsA(node,NullTest) || IsA(node,BooleanTest) || IsA(node,ScalarArrayOpExpr);
 Node *copy=expression_tree_mutator(node,probe_planned_expression,NULL);
 if(predicate)return direct_wrap(copy);
 if(IsA(copy,FuncExpr)) {
  FuncExpr *function=(FuncExpr*)copy;
  for(int i=0;i<builtin_count;i++)if(function->funcid==hash_map[i].original){function->funcid=hash_map[i].replacement;break;}
 }
 return copy;
}
static void probe_plan(Plan *plan) {
 if(!plan)return;
 plan->targetlist=(List*)probe_planned_expression((Node*)plan->targetlist,NULL);
 plan->qual=(List*)probe_planned_expression((Node*)plan->qual,NULL);
 #define REWRITE(field) field=(__typeof__(field))probe_planned_expression((Node*)field,NULL)
 #define CHILDREN(items) do{ListCell *item;foreach(item,items)probe_plan(lfirst_node(Plan,item));}while(0)
 switch(nodeTag(plan)) {
 case T_Result: REWRITE(((Result*)plan)->resconstantqual);break;
 case T_Append: CHILDREN(((Append*)plan)->appendplans);break;
 case T_MergeAppend: CHILDREN(((MergeAppend*)plan)->mergeplans);break;
 case T_BitmapAnd: CHILDREN(((BitmapAnd*)plan)->bitmapplans);break;
 case T_BitmapOr: CHILDREN(((BitmapOr*)plan)->bitmapplans);break;
 case T_SubqueryScan: probe_plan(((SubqueryScan*)plan)->subplan);break;
 case T_IndexScan: unobserved_index_quals+=list_length(((IndexScan*)plan)->indexqual);break;
 case T_IndexOnlyScan: unobserved_index_quals+=list_length(((IndexOnlyScan*)plan)->indexqual);break;
 case T_BitmapIndexScan: unobserved_index_quals+=list_length(((BitmapIndexScan*)plan)->indexqual);break;
 case T_BitmapHeapScan: REWRITE(((BitmapHeapScan*)plan)->bitmapqualorig);break;
 case T_NestLoop: REWRITE(((NestLoop*)plan)->join.joinqual);break;
 case T_HashJoin:
  REWRITE(((HashJoin*)plan)->join.joinqual);
  unobserved_join_keys+=list_length(((HashJoin*)plan)->hashclauses);break;
 case T_MergeJoin:
  REWRITE(((MergeJoin*)plan)->join.joinqual);
  unobserved_join_keys+=list_length(((MergeJoin*)plan)->mergeclauses);break;
 case T_FunctionScan: REWRITE(((FunctionScan*)plan)->functions);break;
 case T_ValuesScan: REWRITE(((ValuesScan*)plan)->values_lists);break;
 case T_Limit: REWRITE(((Limit*)plan)->limitCount);REWRITE(((Limit*)plan)->limitOffset);break;
 case T_Hash: REWRITE(((Hash*)plan)->hashkeys);break;
 case T_Memoize: REWRITE(((Memoize*)plan)->param_exprs);break;
 case T_SeqScan: case T_Material: case T_Sort: case T_IncrementalSort:
 case T_Unique: case T_Group: case T_CteScan: case T_WorkTableScan:
 case T_LockRows: case T_ProjectSet: case T_RecursiveUnion: break;
 case T_Agg: CHILDREN(((Agg*)plan)->chain);break;
 default: unsupported_plans++;break;
 }
 probe_plan(plan->lefttree);probe_plan(plan->righttree);
 #undef REWRITE
 #undef CHILDREN
}
/* Retain only digests of the unmodified chosen plans, never SQL or constants.
 * Comparing these within the same warmed fixture detects plan changes beneath
 * nested PL/pgSQL and SQL calls, not merely the outer SELECT FunctionScan. */
static void remember_plan(PlannedStmt *plan) {
 char *serialized=nodeToString(plan);uint8 digest[32];char hex[65];
 pg_cryptohash_ctx *context=pg_cryptohash_create(PG_SHA256);
 if(!context || pg_cryptohash_init(context)<0 || pg_cryptohash_update(context,(uint8*)serialized,strlen(serialized))<0 || pg_cryptohash_final(context,digest,sizeof(digest))<0)
  ereport(ERROR,(errmsg("CRM plan fingerprint failed")));
 pg_cryptohash_free(context);pfree(serialized);
 for(int i=0;i<32;i++)sprintf(hex+i*2,"%02x",digest[i]);hex[64]='\0';
 int i;for(i=0;i<plan_count;i++)if(strcmp(plans[i].hash,hex)==0)break;
 if(i==MAX_PLANS){enabled=false;ereport(ERROR,(errmsg("CRM plan fingerprint capacity exceeded")));}
 if(i==plan_count){strcpy(plans[i].hash,hex);plans[plan_count++].calls=0;}
 plans[i].calls++;
}
static PlannedStmt *probe_planner(Query *parse,const char *text,int options,ParamListInfo params) {
 if(rls_oid && !preserve_plans)parse=(Query*)probe_expression((Node*)parse,NULL);
 PlannedStmt *result;
 planning_depth++;
 PG_TRY();{result=previous_planner?previous_planner(parse,text,options,params):standard_planner(parse,text,options,params);}
 PG_FINALLY();{planning_depth--;}
 PG_END_TRY();
 if(enabled && preserve_plans)remember_plan(result);
 if(rls_oid && preserve_plans && !observe_only) {
  probe_plan(result->planTree);
  ListCell *item;foreach(item,result->subplans)probe_plan(lfirst_node(Plan,item));
  if(result->parallelModeNeeded || result->partPruneInfos!=NIL)unsupported_plans++;
 }
 return result;
}
void _PG_init(void) {
 previous_needs=needs_fmgr_hook;needs_fmgr_hook=probe_needs;
 previous_hook=fmgr_hook;fmgr_hook=probe_hook;
 previous_planner=planner_hook;planner_hook=probe_planner;
}
static Datum start_probe(bool plan_mode,bool observer) {
 preserve_plans=plan_mode;observe_only=observer;
 Oid boolean=BOOLOID;
 if(!rls_oid) {
  rls_oid=probe_oid("rls",1,&boolean);direct_oid=probe_oid("direct",1,&boolean);
  SPI_connect();
  if(SPI_execute("SELECT oid,substring(proname FROM 3)::oid original FROM pg_catalog.pg_proc WHERE pronamespace='crm_permission_probe'::regnamespace AND proname ~ '^f_[0-9]+$' ORDER BY oid",true,0)!=SPI_OK_SELECT)
   ereport(ERROR,(errmsg("Cannot enumerate CRM probe builtins")));
  if(SPI_processed>MAX_BUILTINS) ereport(ERROR,(errmsg("CRM probe builtin capacity exceeded")));
  builtin_count=(int)SPI_processed;
  for(int i=0;i<builtin_count;i++) {
   bool isnull; char *name;
   hash_map[i].replacement=DatumGetObjectId(SPI_getbinval(SPI_tuptable->vals[i],SPI_tuptable->tupdesc,1,&isnull));
   hash_map[i].original=DatumGetObjectId(SPI_getbinval(SPI_tuptable->vals[i],SPI_tuptable->tupdesc,2,&isnull));
   name=get_func_name(hash_map[i].original);
   hash_map[i].hash=strncmp(name,"md5",3)==0 || strncmp(name,"sha",3)==0 || strncmp(name,"hashtext",8)==0;
  }
  SPI_finish();
 }
 unobserved_index_quals=0;unobserved_join_keys=0;unsupported_plans=0;unobserved_sql_functions=0;
 plan_count=0;used=0;edge_count=0;direct_edge_count=0;call_depth=0;hashes=0;privileges=0;predicates=0;application_predicates=0;direct_predicates=0;enabled=true;PG_RETURN_VOID();
}
Datum crm_probe_begin(PG_FUNCTION_ARGS) {return start_probe(false,false);}
Datum crm_probe_plan_begin(PG_FUNCTION_ARGS) {return start_probe(true,false);}
Datum crm_probe_observe_begin(PG_FUNCTION_ARGS) {return start_probe(true,true);}
Datum crm_probe_end(PG_FUNCTION_ARGS) {
 StringInfoData out;enabled=false;initStringInfo(&out);
 appendStringInfo(&out,"{\"hashes\":%llu,\"privileges\":%llu,\"rls\":%llu,\"applicationPredicates\":%llu,\"directPredicates\":%llu,\"functions\":[",(unsigned long long)hashes,(unsigned long long)privileges,(unsigned long long)predicates,(unsigned long long)application_predicates,(unsigned long long)direct_predicates);
 for(int i=0;i<used;i++) {
  if(i) appendStringInfoChar(&out,',');
  appendStringInfo(&out,"{\"oid\":%u,\"calls\":%llu}",entries[i].oid,(unsigned long long)entries[i].calls);
 }
 appendStringInfoString(&out,"],\"callEdges\":[");
 for(int i=0;i<edge_count;i++) {
  if(i) appendStringInfoChar(&out,',');
  appendStringInfo(&out,"{\"root\":%u,\"caller\":%u,\"callee\":%u,\"calls\":%llu}",edges[i].root,edges[i].caller,edges[i].callee,(unsigned long long)edges[i].calls);
 }
 appendStringInfoString(&out,"],\"directEdges\":[");
 for(int i=0;i<direct_edge_count;i++) {
  if(i)appendStringInfoChar(&out,',');
  appendStringInfo(&out,"{\"root\":%u,\"caller\":%u,\"calls\":%llu}",direct_edges[i].root,direct_edges[i].caller,(unsigned long long)direct_edges[i].calls);
 }
 appendStringInfoString(&out,"],\"plans\":[");
 for(int i=0;i<plan_count;i++) {
  if(i)appendStringInfoChar(&out,',');
  appendStringInfo(&out,"{\"hash\":\"%s\",\"calls\":%llu}",plans[i].hash,(unsigned long long)plans[i].calls);
 }
 appendStringInfo(&out,"],\"openFrames\":%d,\"postPlanningMode\":%s,\"coverageComplete\":false,\"unobservedIndexQuals\":%llu,\"unobservedJoinKeys\":%llu,\"unsupportedPlans\":%llu,\"unobservedSqlHookRequests\":%llu}",call_depth,preserve_plans?"true":"false",(unsigned long long)unobserved_index_quals,(unsigned long long)unobserved_join_keys,(unsigned long long)unsupported_plans,(unsigned long long)unobserved_sql_functions);
 PG_RETURN_DATUM(DirectFunctionCall1(jsonb_in,CStringGetDatum(out.data)));
}
Datum crm_probe_hash(PG_FUNCTION_ARGS) {
 for(int i=0;i<builtin_count;i++) if(fcinfo->flinfo->fn_oid==hash_map[i].replacement) {
  FmgrInfo original;
  LOCAL_FCINFO(call, FUNC_MAX_ARGS);
  if(enabled) {if(hash_map[i].hash) hashes++; else privileges++;}
  fmgr_info(hash_map[i].original,&original);
  InitFunctionCallInfoData(*call,&original,PG_NARGS(),fcinfo->fncollation,fcinfo->context,fcinfo->resultinfo);
  for(int arg=0;arg<PG_NARGS();arg++) call->args[arg]=fcinfo->args[arg];
  Datum result=FunctionCallInvoke(call);
  fcinfo->isnull=call->isnull;
  return result;
 }
 ereport(ERROR,(errmsg("Unknown CRM probe digest")));PG_RETURN_NULL();
}
Datum crm_probe_rls(PG_FUNCTION_ARGS) {
 if(enabled) predicates++;
 if(PG_ARGISNULL(0)) PG_RETURN_NULL();
 PG_RETURN_BOOL(PG_GETARG_BOOL(0));
}

Datum crm_probe_predicate(PG_FUNCTION_ARGS) {
 if(enabled) application_predicates++;
 if(PG_ARGISNULL(0)) PG_RETURN_NULL();
 PG_RETURN_BOOL(PG_GETARG_BOOL(0));
}

Datum crm_probe_direct(PG_FUNCTION_ARGS) {
 if(enabled) {
  direct_predicates++;
  Oid root=call_depth?call_stack[0]:InvalidOid,caller=call_depth?call_stack[call_depth-1]:InvalidOid;
  int i;for(i=0;i<direct_edge_count;i++)if(direct_edges[i].root==root && direct_edges[i].caller==caller)break;
  if(i==MAX_EDGES){enabled=false;ereport(ERROR,(errmsg("CRM direct-predicate attribution capacity exceeded")));}
  if(i==direct_edge_count){direct_edges[i].root=root;direct_edges[i].caller=caller;direct_edges[direct_edge_count++].calls=0;}
  direct_edges[i].calls++;
 }
 if(PG_ARGISNULL(0)) PG_RETURN_NULL();
 PG_RETURN_BOOL(PG_GETARG_BOOL(0));
}
