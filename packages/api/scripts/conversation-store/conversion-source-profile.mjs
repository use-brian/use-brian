// [COMP:api/native-turn-frame] Finite SQL source units for successor references.
// This parses maintained source declarations; it never introspects a target DB.
export function conversionSourceProfile(source) {
  const statements=[];let statement='',quote=null,line=false,block=0
  for(let at=0;at<source.length;at++){
    const c=source[at],next=source[at+1]
    if(line){if(c==='\n'){line=false;statement+='\n'}continue}
    if(block){if(c==='/'&&next==='*'){block++;at++}else if(c==='*'&&next==='/'){block--;at++}continue}
    if(quote){statement+=c
      if(quote==="'"){if(c==="'"&&next==="'"){statement+=next;at++}else if(c==="'")quote=null}
      else if(c==='$'&&source.startsWith(quote,at)){statement+=quote.slice(1);at+=quote.length-1;quote=null}
      continue
    }
    if(c==='-'&&next==='-'){line=true;at++;continue}
    if(c==='/'&&next==='*'){block=1;at++;continue}
    if(c==="'"){quote="'";statement+=c;continue}
    if(c==='$'){const tag=source.slice(at).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];if(tag){quote=tag;statement+=tag;at+=tag.length-1;continue}}
    statement+=c
    if(c===';'){if(statement.trim())statements.push(statement.trim());statement=''}
  }
  if(quote||block||statement.trim())throw Error('conversion_source_unterminated_statement')
  const functions=[],tables=[],triggers=[],privileges=[]
  for(const sql of statements){
    if(/^CREATE FUNCTION public\./.test(sql)){
      const match=sql.match(/^CREATE FUNCTION public\.([a-z_]+)\(([\s\S]*?)\)\s+RETURNS ([\s\S]*?)\s+LANGUAGE (plpgsql|sql)([\s\S]*?)AS (\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)([\s\S]*)\6;$/)
      if(!match)throw Error('conversion_source_function_profile_changed')
      const [,name,args,returns,language,options,tag,body]=match
      functions.push({name,args,returns,language,options,body,sql,reference:index=>sql.replace('public.'+name+'(',`pg_temp.conversion_source_function_${index}(`)})
    }else if(/^(CREATE TYPE|CREATE TABLE|ALTER TABLE) public\.native_conversation_/.test(sql))tables.push(sql)
    else if(/^CREATE TRIGGER native_conversation_/.test(sql))triggers.push(sql)
    else if(/^REVOKE ALL ON/.test(sql))privileges.push(sql)
    else throw Error('conversion_source_unreviewed_statement: '+sql.slice(0,80))
  }
  if(functions.length!==11||tables.filter(x=>x.startsWith('CREATE TABLE')).length!==5||tables.filter(x=>x.startsWith('CREATE TYPE')).length!==2||triggers.length!==8||privileges.length!==3)
    throw Error('conversion_source_declaration_roster_changed')
  if(new Set(functions.map(x=>x.name)).size!==functions.length)throw Error('conversion_source_function_duplicate')
  return {functions,tables,triggers,privileges}
}
