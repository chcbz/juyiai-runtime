// Passive observation, never a response-size limit on the business stream. Only the
// allowlisted projection escapes this object; a missing category is not zero.
import { skillId } from './skill-executor.mjs'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const parse = text => JSON.parse(text, (_key, value, context) => typeof value === 'number' && !/^(0|[1-9][0-9]*)$/.test(context?.source ?? '') ? null : value)
const count = value => Number.isSafeInteger(value) && value >= 0
const fields = {input_tokens:null,output_tokens:null,total_tokens:null,input_tokens_details:['cached_tokens'],output_tokens_details:['reasoning_tokens']}
function quantities(raw, supported) {
  let unknown = false; const usage={}
  for(const [key,value] of Object.entries(object(raw)?raw:{})) {
    if(!Object.hasOwn(fields,key)) { unknown=true; continue }
    if(fields[key] === null) { if(count(value)) usage[key]=value; else unknown=true; continue }
    if(!object(value)) { unknown=true; continue }
    const detail={};for(const [k,n] of Object.entries(value)) {
      if(fields[key].includes(k) && count(n)) detail[k]=n; else unknown=true
    }
    if(Object.keys(detail).length) usage[key]=detail
  }
  const {input_tokens:i,output_tokens:o,total_tokens:t}=usage,c=usage.input_tokens_details?.cached_tokens,r=usage.output_tokens_details?.reasoning_tokens
  const valid=supported && !unknown && [i,o,t,c,r].every(count) && i+o===t && c<=i && r<=o
  return {reportedUsage:Object.keys(usage).length?usage:null, measuredQuantities:valid?{normalizationBasis:'RESPONSES_TEXT_TOKENS_V1',tokens:{INPUT:String(i-c),CACHED_INPUT:String(c),OUTPUT:String(o)},coverage:'COMPLETE'}:null}
}
export function observeResponse(contentType, status, windowBytes, supported) {
  const type=String(contentType).split(';')[0].trim().toLowerCase(),sse=type==='text/event-stream',json=type==='application/json'
  let id=null, terminal=false, usage=quantities(null,false), reason=null, line='', data=[], bytes=0, cr=false
  const decoder=new TextDecoder('utf-8',{fatal:true})
  const invalid=code=>{reason??=code; line='';data=[]}
  const observe=(response,complete)=>{
    if(!skillId(response?.id)) return invalid('RESPONSE_ID_INVALID')
    if(id && id!==response.id) { id=null;return invalid('RESPONSE_ID_CONFLICT') }
    id=response.id
    if(!complete) return
    if(terminal) return invalid('RESPONSE_TERMINAL_CONFLICT')
    terminal=true;usage=quantities(response.usage,supported)
    if(response.status!=='completed') invalid('RESPONSE_NOT_COMPLETED')
  }
  const event=()=>{if(data.length){const text=data.join('\n');if(text!=='[DONE]'){
    const e=parse(text);if(e.type==='response.created') observe(e.response,false)
    else if(['response.completed','response.failed','response.incomplete'].includes(e.type)) observe(e.response,true)
  }}data=[];bytes=0}
  const endLine=()=>{if(!line)event();else if(line==='data'||line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));line=''}
  function append(text){
    if(!sse){bytes+=Buffer.byteLength(text);if(bytes>windowBytes)return invalid('OBSERVATION_WINDOW_EXCEEDED');line+=text;return}
    for(const part of text.split(/([\r\n])/)) {if(!part||reason)continue
      if(part==='\n' && cr){cr=false;continue}cr=part==='\r'
      if(cr||part==='\n'){bytes++;if(bytes>windowBytes)invalid('OBSERVATION_WINDOW_EXCEEDED');else endLine()}
      else {bytes+=Buffer.byteLength(part);if(bytes>windowBytes)invalid('OBSERVATION_WINDOW_EXCEEDED');else line+=part}
    }
  }
  if(status!==200 || !(sse||json)) invalid('RESPONSE_PROTOCOL_UNSUPPORTED')
  return { push(chunk){if(!reason)try{append(decoder.decode(chunk,{stream:true}))}catch{invalid('RESPONSE_STREAM_INVALID')}},
    finish(ended){if(!reason)try{
      append(decoder.decode());if(!ended)invalid('RESPONSE_STREAM_TRUNCATED')
      else if(json&&!reason)observe(parse(line),true);else if(line||data.length)invalid('RESPONSE_STREAM_TRUNCATED')
    }catch{invalid('RESPONSE_STREAM_INVALID')}
    const complete=!reason&&terminal&&usage.measuredQuantities!==null
    return {providerResponseId:id,reportedUsage:usage.reportedUsage,measuredQuantities:complete?usage.measuredQuantities:null,
      actualBillingIdentity:null,reasonCodes:[...(id?['BILLING_IDENTITY_UNKNOWN']:[]),...(complete?[]:[reason||(!terminal?'MISSING_TERMINAL':!supported?'UNSUPPORTED_COST_SOURCE':'USAGE_INCOMPLETE')])]}
  }}
