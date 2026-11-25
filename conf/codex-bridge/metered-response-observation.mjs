// Passive observation, never a response-size limit on the business stream. Only the
// allowlisted projection escapes this object; a missing category is not zero.
import { skillId } from './skill-executor.mjs'
import { projectedJson } from './metered-response-json.mjs'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const fields = {input_tokens:null,output_tokens:null,total_tokens:null,input_tokens_details:['cached_tokens','cache_write_tokens','cache_write_tokens_details'],output_tokens_details:['reasoning_tokens']}
function quantities(raw, supported) {
  let unknown = false; const usage={}
  for(const [key,value] of Object.entries(object(raw)?raw:{})) {
    if(!Object.hasOwn(fields,key)) { unknown=true; continue }
    if(fields[key] === null) { if(count(value)) usage[key]=value; else unknown=true; continue }
    if(!object(value)) { unknown=true; continue }
    const detail={};for(const [k,n] of Object.entries(value)) {
      if(k==='cache_write_tokens_details' && key==='input_tokens_details') {
        if(!object(n)||Object.keys(n).length!==2||!['ttl_12h_tokens','ttl_30m_tokens'].every(x=>Object.hasOwn(n,x)&&n[x]===0))unknown=true
        // Storage contract intentionally retains only cached/reasoning details.
      } else if(fields[key].includes(k) && count(n)) {if(k==='cache_write_tokens'){if(n!==0)unknown=true}else detail[k]=n}
      else unknown=true
    }
    if(Object.keys(detail).length) usage[key]=detail
  }
  if(object(raw?.input_tokens_details)&&Object.hasOwn(raw.input_tokens_details,'cache_write_tokens_details')&&raw.input_tokens_details.cache_write_tokens!==0)unknown=true
  const {input_tokens:i,output_tokens:o,total_tokens:t}=usage,c=usage.input_tokens_details?.cached_tokens,r=usage.output_tokens_details?.reasoning_tokens
  const valid=supported && !unknown && [i,o,t,c,r].every(count) && i+o===t && c<=i && r<=o
  return {reportedUsage:Object.keys(usage).length?usage:null, measuredQuantities:valid?{normalizationBasis:'RESPONSES_TEXT_TOKENS_V1',tokens:{INPUT:String(i-c),CACHED_INPUT:String(c),OUTPUT:String(o)},coverage:'COMPLETE'}:null}
}
export function observeResponse(contentType, status, windowBytes, supported) {
  const type=String(contentType).split(';')[0].trim().toLowerCase(),sse=type==='text/event-stream',json=type==='application/json'
  let id=null, terminal=false, usage=quantities(null,false), reason=null
  const decoder=new TextDecoder('utf-8',{fatal:true})
  const invalid=code=>{reason??=code; parser=null}
  const observe=(response,complete)=>{
    if(!skillId(response?.id)) return invalid('RESPONSE_ID_INVALID')
    if(id && id!==response.id) { id=null;return invalid('RESPONSE_ID_CONFLICT') }
    id=response.id
    if(!complete) return
    if(terminal) return invalid('RESPONSE_TERMINAL_CONFLICT')
    terminal=true;usage=quantities(response.usage,supported)
    if(response.status!=='completed') invalid('RESPONSE_NOT_COMPLETED')
  }
  // A line's optional leading space is framing. JSON data continues across HTTP
  // chunks; separate SSE data fields are joined by exactly one LF.
  let parser=json?projectedJson(false,windowBytes):null, prefix='', mode='field', probe='', started=false, cr=false
  const payload=part=>{
    if(!parser){const n=Math.min(6-probe.length,part.length);probe+=part.slice(0,n);part=part.slice(n)
      if('[DONE]'.startsWith(probe)&&!part)return
      parser=projectedJson(true,windowBytes);parser.push(probe);probe=''}
    parser.push(part)
  }
  const startData=()=>{if(started)payload('\n');started=true;mode='space'}
  const fragment=part=>{
    if(mode==='field'){
      const colon=part.indexOf(':'),field=colon<0?part:part.slice(0,colon)
      if(prefix.length+field.length>windowBytes)throw Error('OBSERVATION_WINDOW_EXCEEDED')
      prefix+=field;if(colon<0)return
      mode='ignore';if(prefix==='data')startData();part=part.slice(colon+1)
    }
    if(mode==='space'&&part){if(part[0]===' ')part=part.slice(1);mode='data'}
    if(mode==='data'&&part)payload(part)
  }
  const endLine=()=>{
    if(mode==='field'&&prefix==='data')startData()
    else if(mode==='field'&&!prefix&&started){
      if(parser||probe!=='[DONE]'){
        if(!parser)throw Error('RESPONSE_STREAM_INVALID');const e=parser.finish()
        if(!object(e))throw Error('RESPONSE_STREAM_INVALID')
        if(e.type==='response.created')observe(e.response,false)
        else if(['response.completed','response.failed','response.incomplete'].includes(e.type)){
          observe(e.response,true);if(e.type!=='response.completed')invalid('RESPONSE_NOT_COMPLETED')
        }
      }
      parser=null;probe='';started=false
    }
    mode='field';prefix=''
  }
  function append(text){
    if(json){parser.push(text);return}
    let from=0
    for(const match of text.matchAll(/[\r\n]/g)){
      if(reason)return
      const i=match.index;if(i>from){fragment(text.slice(from,i));cr=false}
      if(!(match[0]==='\n'&&cr))endLine();cr=match[0]==='\r';from=i+1
    }
    if(from<text.length&&!reason){cr=false;fragment(text.slice(from))}
  }
  if(status!==200 || !(sse||json)) invalid('RESPONSE_PROTOCOL_UNSUPPORTED')
  return { push(chunk){if(!reason)try{append(decoder.decode(chunk,{stream:true}))}catch(error){invalid(error.message==='OBSERVATION_WINDOW_EXCEEDED'?error.message:'RESPONSE_STREAM_INVALID')}},
    finish(ended){if(!reason)try{
      append(decoder.decode());if(!ended)invalid('RESPONSE_STREAM_TRUNCATED')
      else if(json&&!reason)observe(parser.finish(),true);else if(prefix||mode!=='field'||started)invalid('RESPONSE_STREAM_TRUNCATED')
    }catch(error){invalid(error.message==='OBSERVATION_WINDOW_EXCEEDED'?error.message:'RESPONSE_STREAM_INVALID')}
    const complete=!reason&&terminal&&usage.measuredQuantities!==null
    return {providerResponseId:id,reportedUsage:usage.reportedUsage,measuredQuantities:complete?usage.measuredQuantities:null,
      actualBillingIdentity:null,reasonCodes:[...(id?['BILLING_IDENTITY_UNKNOWN']:[]),...(complete?[]:[reason||(!terminal?'MISSING_TERMINAL':!supported?'UNSUPPORTED_COST_SOURCE':'USAGE_INCOMPLETE')])]}
  }}
}
