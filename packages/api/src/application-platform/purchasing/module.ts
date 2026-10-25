/** Deployed purchase workflow over canonical schemas. [COMP:examples/application-references] */
import type { ApplicationModuleDefinition, ApplicationOperationContext, ApplicationRegisteredCommand } from '@use-brian/brian-app/module'
import type { PoolClient } from 'pg'
import type { ApplicationRecordProjection, ApplicationResourceRef, ApplicationResourceDefinition } from '@use-brian/brian-app/application'
import type { PropertyDef } from '@use-brian/core'
import type { CellValue } from '@use-brian/core'
type CanonicalApplicationRecordMutation = {operation:'create'|'patch'|'delete';type:string;id:string;expectedVersion?:string;data:Record<string,CellValue>}

type Context = ApplicationOperationContext<PoolClient>
type Create = { id: string; title: string; companyId: string; budget: string; lines: Array<{id:string;title:string;quantity:number;unitCost:string}> }
type Change = { id: string; orderId?: string }
export type PurchaseSchemaIds = { requestTypeId:string;lineItemTypeId:string;orderTypeId:string }
export interface PurchaseModuleOptions extends PurchaseSchemaIds {
  lockRecords(context:Context,ids:readonly string[]):Promise<void>
  genericModule: ApplicationModuleDefinition<PoolClient>
  resourceForSchema(schema:{id:string;schemaVersion:number;properties:PropertyDef[]}):ApplicationResourceDefinition
  jsonInput: ApplicationRegisteredCommand<PoolClient>['input']
  error(code:'invalid_value'|'access_unavailable'|'record_version_conflict',message:string):Error
  /** Bind to current canonical module role facts; never a cached/local role map. */
  authorizeRole(context:Context,role:'requester'|'manager'):Promise<void>
}
class PurchaseValidationError extends Error {constructor(readonly code:'invalid_value'|'access_unavailable',message:string){super(message)}}
function invalid():never {throw new PurchaseValidationError('invalid_value','The purchase command is invalid.')}
function unavailable():never {throw new PurchaseValidationError('access_unavailable','The purchase is unavailable.')}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function object(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))invalid();return value as Record<string,unknown>}
function id(value:unknown):string {if(typeof value!=='string'||!uuid.test(value))invalid();return value}
function title(value:unknown):string {if(typeof value!=='string'||!value.trim()||value.length>256)invalid();return value}
/** Positive decimal strings, with at most eighteen fractional digits; never Number(cost). */
export function decimalUnits(value:unknown):bigint {if(typeof value!=='string'||value.length>80||!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value))invalid();const[whole,fraction='']=value.split('.');return BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'))}
export function decimalString(units:bigint):string {const whole=units/10n**18n,fraction=(units%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return whole.toString()+(fraction?'.'+fraction:'')}
function createInput(raw:unknown):Create {const input=object(raw,['id','title','companyId','budget','lines']);id(input.id);title(input.title);id(input.companyId);decimalUnits(input.budget);if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>98)invalid();const seen=new Set<string>([input.id as string]);for(const line of input.lines){const item=object(line,['id','title','quantity','unitCost']);id(item.id);title(item.title);decimalUnits(item.unitCost);if(!Number.isSafeInteger(item.quantity)||Number(item.quantity)<1||Number(item.quantity)>1_000_000||seen.has(item.id as string))invalid();seen.add(item.id as string)}return input as unknown as Create}
function changeInput(raw:unknown,approve=false):Change {const input=object(raw,approve?['id','orderId']:['id']);id(input.id);if(approve){id(input.orderId);if(input.id===input.orderId)invalid()}return input as Change}
const text=(value:string)=>({kind:'text' as const,value}),relation=(value:string|null)=>({kind:'relation' as const,value})
function value(record:ApplicationRecordProjection,key:string):unknown {const cell=record.values[key];if(!cell||typeof cell!=='object'||!('value'in cell))unavailable();return cell.value}
function version(context:Context):string {if(!context.expectedVersion||!/^[1-9]\d*$/.test(context.expectedVersion))invalid();return context.expectedVersion}

/** Schema data is created through the canonical schema service by the deployment. */
export function purchaseProperties(ids:PurchaseSchemaIds):Record<'request'|'lineItem'|'order',PropertyDef[]> {
 const company:PropertyDef={name:'company',required:true,config:{kind:'relation',targetEntityTypeRef:{kind:'builtin',name:'company'}}}
 const request:PropertyDef={name:'request',required:true,config:{kind:'relation',targetEntityTypeRef:{kind:'user_defined',entityTypeId:ids.requestTypeId}}}
 const field=(name:string,required=true):PropertyDef=>({name,required,config:{kind:'text'}})
 return{request:[field('title'),company,field('budget'),field('state'),field('total',false)],
 lineItem:[field('title'),request,{name:'quantity',required:true,config:{kind:'number',minimum:1,maximum:1_000_000}},field('unitCost')],
 order:[request,company,field('total'),field('state')]}
}
export function createPurchaseOperationsModule(options:PurchaseModuleOptions):ApplicationModuleDefinition<PoolClient> {
 if(!options||typeof options.authorizeRole!=='function'||typeof options.lockRecords!=='function'||!options.genericModule||typeof options.resourceForSchema!=='function'||!options.jsonInput||typeof options.error!=='function')unavailable()
 const inputSchema=(validate:(raw:unknown)=>unknown)=>options.jsonInput.refine(raw=>{try{validate(raw);return true}catch{return false}},'Invalid purchase input')
 const ids=[options.requestTypeId,options.lineItemTypeId,options.orderTypeId].map(id)
 if(new Set(ids).size!==3)invalid()
 const types=ids.map(id=>'record.'+id),[requestType,lineType,orderType]=types
 const base=options.genericModule,batch=base.commands.record_batch
 if(!batch||!base.queries.get||!base.queries.query)unavailable()
 const properties=purchaseProperties(options)
 const resources=[properties.request,properties.lineItem,properties.order].map((properties,index)=>options.resourceForSchema({id:ids[index],schemaVersion:1,properties}))
 const checkType=(raw:unknown)=>{const input=raw as {type?:unknown};if(!types.includes(String(input?.type)))unavailable()}
 const queries=Object.fromEntries(Object.entries(base.queries).map(([key,query])=>[key,{...query,authorize:async(context:Context,raw:unknown)=>{try{checkType(raw)}catch(error){if(error instanceof PurchaseValidationError)throw options.error(error.code,error.message);throw error}await query.authorize(context,raw)}}]))
 async function read(context:Context,type:string,id:string){const query=base.queries.get,raw={type,id};await query.authorize(context,raw);const result=await query.execute(context,raw) as ApplicationRecordProjection;await query.authorizeResult?.(context,result);return result}
 async function readLines(context:Context,requestId:string){const query=base.queries.query,raw={type:lineType,query:{filters:[{field:'request',op:'eq',value:requestId}],sort:[],aggregate:[],limit:99}};await query.authorize(context,raw);const result=await query.execute(context,raw) as {records:ApplicationRecordProjection[];nextCursor?:string};await query.authorizeResult?.(context,result);if(result.nextCursor||!result.records.length||result.records.length>98)invalid();return result}
 async function lock(context:Context,records:ApplicationRecordProjection[]){const ids=records.map(record=>record.ref.id).sort();await options.lockRecords(context,ids);for(const record of records){const fresh=await read(context,record.ref.typeKey,record.ref.id);if(fresh.ref.version!==record.ref.version)throw options.error('record_version_conflict','A purchase record changed.')}}
 const batchContexts=new WeakMap<Context,Context>()
 // The semantic envelope owns expectedVersion; normalized batch entries carry it individually.
 // Preserve exact execution and transaction objects while reusing one child for all admission/replay ports.
 function batchContext(context:Context):Context{let child=batchContexts.get(context);if(!child){const{expectedVersion:_semanticVersion,...normalized}=context;child=normalized;batchContexts.set(context,child)}return child}
 const authorizeInputs=new WeakMap<Context,CanonicalApplicationRecordMutation[]>()
 function skeleton(context:Context,key:string,raw:unknown):CanonicalApplicationRecordMutation[]{
  if(key==='create_request'){const input=createInput(raw);if(context.expectedVersion!==undefined)invalid();return[{operation:'create',type:requestType,id:input.id,data:{title:text(input.title),company:relation(input.companyId),budget:text(input.budget),state:text('draft')}},...input.lines.map(line=>({operation:'create' as const,type:lineType,id:line.id,data:{title:text(line.title),request:relation(input.id),quantity:{kind:'number' as const,value:line.quantity},unitCost:text(line.unitCost)}}))]}
  const input=changeInput(raw,key==='approve_order'),expectedVersion=version(context)
  if(key==='submit_request')return[{operation:'patch',type:requestType,id:input.id,expectedVersion,data:{state:text('submitted')}}]
  return[{operation:'patch',type:requestType,id:input.id,expectedVersion,data:{state:text('ordered'),total:text('0')}},{operation:'create',type:orderType,id:input.orderId!,data:{request:relation(input.id),company:relation(null),total:text('0'),state:text('ordered')}}]
 }
 function command(key:'create_request'|'submit_request'|'approve_order'):ApplicationRegisteredCommand<PoolClient>{return{
  input:inputSchema(raw=>key==='create_request'?createInput(raw):changeInput(raw,key==='approve_order')),eventKey:'purchasing.changed',
  async authorize(context,raw){try{await options.authorizeRole(context,key==='approve_order'?'manager':'requester');const inputs=skeleton(context,key,raw);await batch.authorize(batchContext(context),{operations:inputs});authorizeInputs.set(context,inputs)}catch(error){if(error instanceof PurchaseValidationError)throw options.error(error.code,error.message);throw error}},
  async execute(context,raw){try{let inputs=authorizeInputs.get(context);if(!inputs)unavailable()
   if(key!=='create_request'){const input=changeInput(raw,key==='approve_order');let request=await read(context,requestType,input.id);const lines=key==='approve_order'?await readLines(context,input.id):undefined;await lock(context,[request,...(lines?.records??[])]);request=await read(context,requestType,input.id);if(request.ref.version!==version(context))throw options.error('record_version_conflict','The purchase changed.');const state=value(request,'state');if(state!==(key==='submit_request'?'draft':'submitted'))invalid()
    if(key==='approve_order'){let total=0n;for(const line of lines!.records){const quantity=value(line,'quantity');if(!Number.isSafeInteger(quantity)||Number(quantity)<1||Number(quantity)>1_000_000)invalid();total+=decimalUnits(value(line,'unitCost'))*BigInt(quantity as number)}if(total>decimalUnits(value(request,'budget')))throw options.error('invalid_value','The purchase exceeds its budget.');const exact=decimalString(total),company=id(value(request,'company'));inputs=[{...inputs[0],data:{state:text('ordered'),total:text(exact)}} as CanonicalApplicationRecordMutation,{...inputs[1],data:{request:relation(input.id),company:relation(company),total:text(exact),state:text('ordered')}} as CanonicalApplicationRecordMutation]}
   }
   await batch.authorize(batchContext(context),{operations:inputs});authorizeInputs.set(context,inputs);return await batch.execute(batchContext(context),{operations:inputs})}catch(error){if(error instanceof PurchaseValidationError)throw options.error(error.code,error.message);throw error}
  },
  async authorizeResult(context,refs:ApplicationResourceRef[]){await options.authorizeRole(context,key==='approve_order'?'manager':'requester');await batch.authorizeResult(batchContext(context),refs)},
 }}
 return{key:'purchasing',defaultState:'enabled',application:{version:'1',dependencies:['records','native'],resources,queries:Object.keys(queries),commands:['create_request','submit_request','approve_order'],events:['purchasing.changed'],policyCapabilities:['canonical_generic','canonical_module_roles'],backgroundHandlers:[],uiContributions:[]},resolveResources:async()=>resources,queries,commands:{create_request:command('create_request'),submit_request:command('submit_request'),approve_order:command('approve_order')}}
}


export interface WorkspacePurchaseModuleOptions extends Omit<PurchaseModuleOptions,keyof PurchaseSchemaIds> {
 /** Deployment-owned current configuration reader. Schema IDs are data, never a user-selected module. */
 resolveSchemaIds(context:Context):Promise<PurchaseSchemaIds>
}
/** Same canonical module per invocation; no schema/authority cache crosses executions. */
export function createWorkspacePurchaseOperationsModule(options:WorkspacePurchaseModuleOptions):ApplicationModuleDefinition<PoolClient> {
 if(!options||typeof options.resolveSchemaIds!=='function')unavailable()
 const instances=new WeakMap<Context,Promise<ApplicationModuleDefinition<PoolClient>>>()
 function implementation(context:Context){let module=instances.get(context);if(!module){module=Promise.resolve(options.resolveSchemaIds(context)).then(ids=>createPurchaseOperationsModule({...options,requestTypeId:ids.requestTypeId,lineItemTypeId:ids.lineItemTypeId,orderTypeId:ids.orderTypeId}));instances.set(context,module)}return module}
 const queryKeys=['get','query','history'],commandKeys=['create_request','submit_request','approve_order'] as const
 const queries=Object.fromEntries(queryKeys.map(key=>[key,{input:options.genericModule.queries[key].input,
  async authorize(context:Context,input:unknown){await(await implementation(context)).queries[key].authorize(context,input)},
  async execute(context:Context,input:unknown){return(await implementation(context)).queries[key].execute(context,input)},
  async authorizeResult(context:Context,result:unknown){await(await implementation(context)).queries[key].authorizeResult?.(context,result)},
 }]))
 const commands=Object.fromEntries(commandKeys.map(key=>[key,{input:options.jsonInput.refine(raw=>{try{key==='create_request'?createInput(raw):changeInput(raw,key==='approve_order');return true}catch{return false}},'Invalid purchase input'),eventKey:'purchasing.changed',
  async authorize(context:Context,input:unknown){await(await implementation(context)).commands[key].authorize(context,input)},
  async execute(context:Context,input:unknown){return(await implementation(context)).commands[key].execute(context,input)},
  async authorizeResult(context:Context,refs:ApplicationResourceRef[]){await(await implementation(context)).commands[key].authorizeResult(context,refs)},
 }]))
 return{key:'purchasing',defaultState:'enabled',application:{version:'1',dependencies:['records','native'],resources:[],queries:queryKeys,commands:[...commandKeys],events:['purchasing.changed'],policyCapabilities:['canonical_generic','canonical_module_roles'],backgroundHandlers:[],uiContributions:[]},
  async resolveResources(context){const module=await implementation(context);return module.resolveResources!(context)},queries,commands}
}
