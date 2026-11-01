/* [COMP:crm/permission-budget] Disposable PostgreSQL 18 CRM regression instrumentation. Never install in a product DB.
 * Count function entries (including SQL bodies that would otherwise inline), explicit
 * digest calls and evaluated RLS qualifications. No arguments or results are retained.
 * Public entries conservatively include business helpers. Direct predicate coverage
 * is partial and its wrappers can change plans: this is not a ceiling certificate.
 */
#include "postgres.h"
#include "fmgr.h"
#include "catalog/pg_namespace_d.h"
#include "catalog/pg_proc.h"
#include "catalog/pg_type_d.h"
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
PG_FUNCTION_INFO_V1(crm_probe_hash);
PG_FUNCTION_INFO_V1(crm_probe_rls);
PG_FUNCTION_INFO_V1(crm_probe_predicate);
PG_FUNCTION_INFO_V1(crm_probe_direct);

#define MAX_ENTRIES 8192
static struct {Oid oid; uint64 calls;} entries[MAX_ENTRIES];
static int used;
static uint64 hashes, privileges, predicates, application_predicates, direct_predicates;
static bool enabled;
static needs_fmgr_hook_type previous_needs;
static fmgr_hook_type previous_hook;
static planner_hook_type previous_planner;
static Oid rls_oid, direct_oid;
#define MAX_BUILTINS 256
static struct {Oid original; Oid replacement; bool hash;} hash_map[MAX_BUILTINS];
static int builtin_count;


static bool probe_needs(Oid oid) {
 /* pg_catalog's C fast path cannot use fmgr_hook. Explicit hash calls are
  * replaced below with identical C dispatch. SQL/public functions use the hook. */
 return true;
}
static void probe_hook(FmgrHookEventType event,FmgrInfo *flinfo,Datum *arg) {
 if (enabled && event==FHET_START && get_func_namespace(flinfo->fn_oid)==PG_PUBLIC_NAMESPACE) {
  int i; for(i=0;i<used;i++) if(entries[i].oid==flinfo->fn_oid) break;
  if(i==MAX_ENTRIES) ereport(ERROR,(errmsg("CRM permission probe capacity exceeded")));
  if(i==used) {entries[used].oid=flinfo->fn_oid;entries[used++].calls=0;}
  entries[i].calls++;
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
static PlannedStmt *probe_planner(Query *parse,const char *text,int options,ParamListInfo params) {
 /* Install once before preparing measured statements. Hooks stay present after
  * end(), so a prepared plan cannot silently lose counters on the next operation. */
 if(rls_oid) parse=(Query*)probe_expression((Node*)parse,NULL);
 return previous_planner?previous_planner(parse,text,options,params):standard_planner(parse,text,options,params);
}
void _PG_init(void) {
 previous_needs=needs_fmgr_hook;needs_fmgr_hook=probe_needs;
 previous_hook=fmgr_hook;fmgr_hook=probe_hook;
 previous_planner=planner_hook;planner_hook=probe_planner;
}
Datum crm_probe_begin(PG_FUNCTION_ARGS) {
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
 used=0;hashes=0;privileges=0;predicates=0;application_predicates=0;direct_predicates=0;enabled=true;PG_RETURN_VOID();
}
Datum crm_probe_end(PG_FUNCTION_ARGS) {
 StringInfoData out;enabled=false;initStringInfo(&out);
 appendStringInfo(&out,"{\"hashes\":%llu,\"privileges\":%llu,\"rls\":%llu,\"applicationPredicates\":%llu,\"directPredicates\":%llu,\"functions\":[",(unsigned long long)hashes,(unsigned long long)privileges,(unsigned long long)predicates,(unsigned long long)application_predicates,(unsigned long long)direct_predicates);
 for(int i=0;i<used;i++) {
  if(i) appendStringInfoChar(&out,',');
  appendStringInfo(&out,"{\"oid\":%u,\"calls\":%llu}",entries[i].oid,(unsigned long long)entries[i].calls);
 }
 appendStringInfoString(&out,"]}");
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
 if(enabled) direct_predicates++;
 if(PG_ARGISNULL(0)) PG_RETURN_NULL();
 PG_RETURN_BOOL(PG_GETARG_BOOL(0));
}
