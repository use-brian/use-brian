/** Declared-cell query compiler and sort-aware keyset cursors. [COMP:api/application-records] */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ApplicationPlatformError } from '@use-brian/shared'
import type { DocEntityFilter, DocEntitySort, DocEntityType, PropertyDef } from '@use-brian/core'
import { validApplicationDate } from '@use-brian/core'

const cursorSchema=z.object({v:z.literal(1),typeId:z.string().uuid(),schemaVersion:z.number().int(),signature:z.string(),
  values:z.array(z.union([z.null(),z.string(),z.number().finite(),z.boolean()])).max(10)}).strict()
function invalid():never {throw new ApplicationPlatformError('invalid_value','The declared query or cursor is invalid.')}

export function compileApplicationRecordQuery(schema:DocEntityType,filters:DocEntityFilter[]=[],sort:DocEntitySort[]=[],limit=50,cursor?:string) {
  if(filters.length>32||sort.length>8||!Number.isSafeInteger(limit)||limit<1||limit>100)invalid()
  const values:unknown[]=[schema.workspaceId,schema.id],clauses=['workspace_id = $1','entity_type_id = $2']
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`}
  const fields=new Map(schema.properties.map(field=>[field.name,field]))
  const expressions=new Map<string,{sql:string;cast:string;property:PropertyDef}>()
  function expression(name:string) {
    const prior=expressions.get(name);if(prior)return prior
    const property=fields.get(name);if(!property)invalid()
    const kind=property.config.kind
    const system:Record<string,string>={created_time:'created_at',last_edited_time:'last_edited_at',created_by:'created_by::text',last_edited_by:'last_edited_by::text'}
    const param=system[kind]?undefined:`${bind(name)}::text`
    const cast=kind==='number'?'numeric':kind==='date'||kind==='created_time'||kind==='last_edited_time'?'timestamptz':kind==='checkbox'?'boolean':'text'
    const sql=system[kind]??(kind==='date'?`(data->${param}->'value'->>'start')::timestamptz`
      :kind==='number'||kind==='checkbox'?`(data->${param}->>'value')::${cast}`:`data->${param}->>'value'`)
    const result={sql,cast,property};expressions.set(name,result);return result
  }
  function checkValue(property:PropertyDef,value:unknown) {
    if(value===null)return
    const config=property.config
    if(config.kind==='number') {if(typeof value!=='number'||!Number.isFinite(value))invalid();return}
    if(config.kind==='checkbox') {if(typeof value!=='boolean')invalid();return}
    if(typeof value!=='string')invalid()
    if(['date','created_time','last_edited_time'].includes(config.kind)&&!validApplicationDate(value))invalid()
    if(config.kind==='select'&&!config.options.some(option=>option.id===value))invalid()
    if(config.kind==='status'&&!config.groups.some(group=>group.options.some(option=>option.id===value)))invalid()
  }
  for(const filter of filters) {
    const field=expression(filter.field),kind=field.property.config.kind
    if(filter.op==='contains') {
      if(kind==='multi_select') {
        const selected=Array.isArray(filter.value)?filter.value:[filter.value]
        const config=field.property.config
        if(selected.length>128||config.kind!=='multi_select'||selected.some(value=>typeof value!=='string'||!config.options.some(option=>option.id===value)))invalid()
        clauses.push(`(${field.sql})::jsonb @> ${bind(JSON.stringify(selected))}::jsonb`)
      } else if(kind==='text'&&typeof filter.value==='string') clauses.push(`strpos(lower(${field.sql}),lower(${bind(filter.value)}))>0`)
      else invalid()
      continue
    }
    if(['files','multi_select'].includes(kind))invalid()
    if(filter.op==='in') {
      if(!Array.isArray(filter.value)||filter.value.length>100)invalid()
      filter.value.forEach(value=>{if(value===null)invalid();checkValue(field.property,value)})
      clauses.push(`${field.sql}=ANY(${bind(filter.value)}::${field.cast}[])`);continue
    }
    checkValue(field.property,filter.value)
    const operators={eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='} as const
    if(!Object.hasOwn(operators,filter.op))invalid()
    if(filter.value===null) {
      if(filter.op!=='eq'&&filter.op!=='neq')invalid()
      clauses.push(`${field.sql} IS ${filter.op==='neq'?'NOT ':''}NULL`)
    } else clauses.push(`${field.sql} ${operators[filter.op as keyof typeof operators]} ${bind(filter.value)}::${field.cast}`)
  }
  const order=sort.map(item=>{
    if(item.direction!=='asc'&&item.direction!=='desc')invalid()
    const field=expression(item.field)
    if(['files','multi_select'].includes(field.property.config.kind))invalid()
    return {sql:field.sql,cast:field.cast,direction:item.direction}
  })
  order.push({sql:'created_at',cast:'timestamptz',direction:'desc'},{sql:'id::text',cast:'text',direction:'desc'})
  const signature=createHash('sha256').update(JSON.stringify({filters,sort})).digest('hex')
  if(cursor) {
    let raw:unknown
    try {raw=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'))}catch {
      const legacy=Buffer.from(cursor,'base64url').toString('utf8').split('|')
      if(sort.length||legacy.length!==2||!validApplicationDate(legacy[0])||!z.string().uuid().safeParse(legacy[1]).success)invalid()
      raw={v:1,typeId:schema.id,schemaVersion:schema.schemaVersion,signature,values:legacy}
    }
    const parsed=cursorSchema.safeParse(raw)
    if(!parsed.success||parsed.data.typeId!==schema.id||parsed.data.schemaVersion!==schema.schemaVersion||parsed.data.signature!==signature||parsed.data.values.length!==order.length)invalid()
    const prefixes:string[]=[],after:string[]=[]
    for(const [index,item]of order.entries()) {
      const value=parsed.data.values[index],parameter=`${bind(value)}::${item.cast}`
      if(value!==null)after.push(`(${[...prefixes,`(${item.sql} ${item.direction==='asc'?'>':'<'} ${parameter} OR ${item.sql} IS NULL)`].join(' AND ')})`)
      prefixes.push(`${item.sql} IS NOT DISTINCT FROM ${parameter}`)
    }
    clauses.push(after.length?`(${after.join(' OR ')})`:'false')
  }
  const limitParameter=bind(limit+1)
  return {values,where:clauses.join(' AND '),orderBy:order.map(item=>`${item.sql} ${item.direction.toUpperCase()} NULLS LAST`).join(', '),
    sortSelect:order.map((item,index)=>`${item.sql} AS "__sort${index}"`).join(', '),limitParameter,
    cursorFor:(row:Record<string,unknown>)=>Buffer.from(JSON.stringify({v:1,typeId:schema.id,schemaVersion:schema.schemaVersion,signature,
      values:order.map((_,index)=>row[`__sort${index}`])})).toString('base64url')}
}
