// Actual outgoing wire shape, not the selected model's advertised capabilities.
// Descriptions and JSON schemas of client-side functions are text, not provider
// tool invocations. Their actual execution still needs its own dispatch/source policy.
import { projectedJson } from './metered-response-json.mjs'
const harmlessScalar=new Set(['model','instructions','stream','store','parallel_tool_calls','max_output_tokens','prompt_cache_key','service_tier','temperature','top_p','truncation'])
export function requestCostScope(budget) {
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
    } else if(parent==='tools'&&kind==='object')return 'tool'
    else if(parent==='tool'){
      if(key==='type'&&kind==='string')return 'toolType'
      return 'skip' // sibling fields cannot identify the tool class; its type is mandatory
    } else if(parent==='input'&&kind==='object')return 'item'
    else if(parent==='item'){
      if(key==='type'&&kind==='string')return 'itemType'
      if(key==='content'&&kind==='string')return 'skip'
      if(key==='content'&&kind==='array')return 'content'
      if(['role','id','status','phase'].includes(key)&&kind==='string')return 'skip'
    } else if(parent==='content'&&kind==='object')return 'part'
    else if(parent==='part'){
      if(key==='type'&&kind==='string')return 'partType'
      if(key==='text'&&kind==='string')return 'skip'
      if(['image_url','file_id','file_data','audio'].includes(key)){flags.add('REQUEST_NON_TEXT_INPUT');return 'skip'}
    } else if(parent==='reasoningOptions'&&['effort','summary'].includes(key)&&kind==='string')return 'skip'
    else if(parent==='textOptions'&&key==='verbosity'&&kind==='string')return 'skip'
    else if(parent==='includes'&&kind==='string')return 'include'
    unknown();return 'skip'
  }
  const enums=new Set(['choice','toolType','itemType','partType','include'])
  const inspect={value,read:role=>enums.has(role),scalar(role,v){
    if(role==='choice'&&!['auto','none','required'].includes(v))unknown()
    if(role==='toolType'&&!['custom','function'].includes(v))flags.add('REQUEST_PROVIDER_TOOL_OR_UNKNOWN')
    if(role==='itemType'&&v!=='message')unknown()
    if(role==='partType'&&!['input_text','output_text'].includes(v))flags.add('REQUEST_NON_TEXT_INPUT')
    if(role==='include'&&v!=='reasoning.encrypted_content')unknown()
  },close(role,keys){
    if(role==='request'&&(!keys.has('input')||!keys.has('model')))unknown()
    if(role==='item'&&(!keys.has('role')||!keys.has('content')))unknown()
    if((role==='tool'||role==='part')&&!keys.has('type'))unknown()
  }}
  parser=projectedJson(false,budget,inspect)
  return {push(chunk){if(!broken)try{parser.push(decoder.decode(chunk,{stream:true}))}catch{broken=true;parser=null}},finish(ended){
    if(!broken&&ended)try{parser.push(decoder.decode());parser.finish()}catch{broken=true}
    if(broken||!ended)unknown();return [...flags].sort()
  }}
}
