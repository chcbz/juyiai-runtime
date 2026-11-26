// Actual outgoing wire shape, not the selected model's advertised capabilities.
// Descriptions and JSON schemas of client-side functions are text, not provider
// tool invocations. Their actual execution still needs its own dispatch/source policy.
import { projectedJson } from './metered-response-json.mjs'
const harmlessScalar=new Set(['model','instructions','stream','store','parallel_tool_calls','max_output_tokens','prompt_cache_key','service_tier','temperature','top_p','truncation'])
export function requestCostScope(budget,localArtifactCall) {
  const flags=new Set(),decoder=new TextDecoder('utf-8',{fatal:true});let parser,broken=false
  const unknown=()=>flags.add('REQUEST_COST_SCOPE_UNKNOWN')
  function value(parent,key,kind){
    if(!parent){if(kind==='object')return 'request';unknown();return 'skip'}
    if(parent==='skip')return 'skip'
    if(parent==='request'){
      if(key==='input'&&kind==='string')return 'skip'
      if((key==='input'||key==='tools')&&kind==='array')return key
      if(key==='tool_choice'&&kind==='string')return 'choice'
      if(key==='text'&&kind==='object')return 'textOptions'
      if(key==='reasoning'&&kind==='object')return 'reasoningOptions'
      if(key==='include'&&kind==='array')return 'includes'
      if(key==='client_metadata'&&kind==='object')return 'skip'
      if(harmlessScalar.has(key)&&!['object','array'].includes(kind))return 'skip'
    } else if(parent==='tools'&&kind==='object')return {tool:true,namespace:false}
    else if(parent.tool){
      if(['type','execution'].includes(key)&&kind==='string')return {toolField:key,toolOwner:parent}
      if(key==='tools'&&kind==='array')return 'tools' // validate every nested declaration, regardless of member order
      if(['name','description'].includes(key)&&kind==='string'||key==='strict'&&kind==='atom'||['parameters','format'].includes(key)&&kind==='object')return 'skip'
    } else if(parent==='input'&&kind==='object')return {item:true}
    else if(parent.item){
      if(key==='tools'&&kind==='array')return 'tools' // additional_tools must pass the same nested declaration checks
      if(['type','call_id','name','role'].includes(key)&&kind==='string')return {itemField:key,itemOwner:parent}
      if(['content','output'].includes(key)&&kind==='array')return 'content'
      if(['id','status','phase','arguments','output','content'].includes(key)&&kind==='string')return 'skip'
    } else if(parent==='content'&&kind==='object')return 'part'
    else if(parent==='part'){
      if(key==='type'&&kind==='string')return 'partType'
      if(key==='text'&&kind==='string')return 'skip'
      if(['image_url','file_id','file_data','audio'].includes(key)){flags.add('REQUEST_NON_TEXT_INPUT');return 'skip'}
    } else if(parent==='reasoningOptions'&&['effort','summary'].includes(key)&&kind==='string')return 'skip'
    else if(parent==='reasoningOptions'&&key==='context'&&kind==='string')return 'reasoningContext'
    else if(parent==='textOptions'&&key==='verbosity'&&kind==='string')return 'skip'
    else if(parent==='includes'&&kind==='string')return 'include'
    unknown();return 'skip'
  }
  const enums=new Set(['choice','partType','include','reasoningContext'])
  const inspect={value,read:role=>!!role?.toolOwner||!!role?.itemOwner||enums.has(role),scalar(role,v){
    if(role==='reasoningContext'&&v!=='all_turns')unknown()
    if(role==='choice'&&!['auto','none','required'].includes(v))unknown()
    if(role?.toolOwner){role.toolOwner[role.toolField]=v;role.toolOwner.namespace=role.toolOwner.type==='namespace'}
    if(role?.itemOwner)role.itemOwner[role.itemField]=v
    if(role==='partType'&&!['input_text','output_text'].includes(v))flags.add('REQUEST_NON_TEXT_INPUT')
    if(role==='include'&&v!=='reasoning.encrypted_content')unknown()
  },close(role,keys){
    if(role==='request'&&(!keys.has('input')||!keys.has('model')))unknown()
    if(role?.item){
      const allow=(...fields)=>[...keys].every(k=>fields.includes(k))
      if(role.type==null||role.type==='message'){
        if(!allow('type','id','role','status','phase','content')||!keys.has('role')||!keys.has('content'))unknown()
      } else if(role.type==='additional_tools'){
        if(role.role!=='developer'||!keys.has('tools')||!allow('type','id','role','tools'))unknown()
      } else if(role.type==='function_call'||role.type==='function_call_output'){
        const call=role.type==='function_call',name=role.call_id&&localArtifactCall?.(role.call_id)
        if(!name||(call?name!==role.name||!keys.has('arguments')||!allow('type','id','call_id','name','arguments','status'):
          !keys.has('output')||!allow('type','id','call_id','output','status')))flags.add('REQUEST_TOOL_HISTORY_UNBOUND')
      } else unknown()
    }
    if(role?.tool){
      if(!keys.has('type')||role.namespace!==keys.has('tools'))unknown()
      // Client search is a local discovery declaration, not a hosted provider
      // invocation. Its actual call/output still fails closed as unknown history.
      if(!['namespace','custom','function'].includes(role.type)&&!(role.type==='tool_search'&&role.execution==='client'))flags.add('REQUEST_PROVIDER_TOOL_OR_UNKNOWN')
      if(keys.has('execution')&&role.type!=='tool_search')unknown()
    }
    if(role==='part'&&!keys.has('type'))unknown()
  }}
  parser=projectedJson(false,budget,inspect)
  return {push(chunk){if(!broken)try{parser.push(decoder.decode(chunk,{stream:true}))}catch{broken=true;parser=null}},finish(ended){
    if(!broken&&ended)try{parser.push(decoder.decode());parser.finish()}catch{broken=true}
    if(broken||!ended)unknown();return [...flags].sort()
  }}
}
