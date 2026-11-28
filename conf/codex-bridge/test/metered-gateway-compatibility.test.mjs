import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {observeResponse} from '../metered-response-observation.mjs'
import {requestCostScope} from '../metered-request-scope.mjs'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/metered-gateway-usage-zero-cache-write.json',import.meta.url)))
function observation(usage,sse=false){
 const response={id:'response_fixture',status:'completed',usage},o=observeResponse(sse?'text/event-stream':'application/json',200,16384,true)
 const bytes=Buffer.from(sse?'data: '+JSON.stringify({type:'response.completed',response})+'\n\n':JSON.stringify(response))
 for(let i=0;i<bytes.length;i+=13)o.push(bytes.subarray(i,i+13))
 return o.finish(true)
}
test('observed gateway zero-write breakdown does not double count or retain item IDs',()=>{
 for(const sse of [false,true]){
  const o=observation(fixture,sse)
  assert.deepEqual(o.measuredQuantities.tokens,{INPUT:'2833',CACHED_INPUT:'0',OUTPUT:'69'})
  assert.deepEqual(o.reportedUsage,{input_tokens:2833,input_tokens_details:{cached_tokens:0},output_tokens:69,output_tokens_details:{reasoning_tokens:0},total_tokens:2902});
  assert.deepEqual(o.reasonCodes,['BILLING_IDENTITY_UNKNOWN']);assert.equal(o.actualBillingIdentity,null)
  assert.ok(!JSON.stringify(o).includes('item_'));assert.ok(!JSON.stringify(o).includes('attribution'))
 }
})
test('unknown billing categories, cache writes and malformed attribution remain incomplete',()=>{
 const mutations=[
  x=>x.input_tokens_details.cache_write_tokens=1,
  x=>x.input_tokens_details.cache_write_tokens_details.ttl_12h_tokens=1,
  x=>x.input_tokens_details.cache_write_tokens_details.unrecognized=0,
  x=>delete x.input_tokens_details.cache_write_tokens_details.ttl_30m_tokens,
  x=>delete x.input_tokens_details.cache_write_tokens,
  x=>x.input_tokens_details.audio_tokens=0,
  x=>x.attribution.items.item_0.cache_write_tokens=1,
  x=>x.attribution.items.item_0.cached_tokens=999999,
  x=>x.attribution.items.item_0.output_tokens='0',
  x=>x.attribution.items.item_0.output_tokens=Number.MAX_SAFE_INTEGER+1,
  x=>x.attribution.items.item_0.content[0].cache_write_tokens=1,
  x=>x.attribution.items.item_0.content[0].unknown_tokens=0,
  x=>x.attribution.items.item_0.content[0].content=[],
  x=>delete x.attribution.items.item_0.input_tokens,
  x=>delete x.attribution.request_fields,
  x=>x.attribution.unknown_category={},
  x=>x.attribution.items=[],
  x=>x.attribution.items.item_0=null,
  x=>x.attribution=null,
  x=>x.new_charge=0
 ]
 for(const mutate of mutations){const usage=structuredClone(fixture);mutate(usage);const o=observation(usage);assert.equal(o.measuredQuantities,null,String(mutate));assert.ok(o.reasonCodes.includes('USAGE_INCOMPLETE'))}
})
test('client discovery declaration is not a hosted tool; execution still needs bound history',()=>{
 function check(tools,input='fixture'){const o=requestCostScope(2048);const bytes=Buffer.from(JSON.stringify({model:'fixture',tools,input}));for(let i=0;i<bytes.length;i+=7)o.push(bytes.subarray(i,i+7));return o.finish(true)}
 const tool={type:'tool_search',execution:'client',description:'local tool discovery',parameters:{type:'object'}}
 assert.deepEqual(check([tool]),[]);assert.deepEqual(check([{execution:'client',type:'tool_search'}]),[])
 for(const execution of [undefined,'server','unknown',null,{}])assert.ok(check([{...tool,execution}]).includes('REQUEST_PROVIDER_TOOL_OR_UNKNOWN'))
 assert.ok(check([{type:'web_search'}]).includes('REQUEST_PROVIDER_TOOL_OR_UNKNOWN'))
 assert.ok(check([{type:'function',execution:'client'}]).includes('REQUEST_COST_SCOPE_UNKNOWN'))
 assert.ok(check([tool],[{type:'tool_search_call',call_id:'unbound',arguments:'{}'}]).includes('REQUEST_COST_SCOPE_UNKNOWN'))
})

test('native developer tool catalogue is text only when every nested declaration and reasoning-context selector is understood',()=>{
  const tool={type:'namespace',name:'test',description:'fixture',tools:[{type:'function',name:'result_propose',description:'fixture',strict:false,parameters:{type:'object'}}]}
  const item={tools:[tool],id:'fixture',role:'developer',type:'additional_tools'}
  const scope=(input,reasoning={context:'all_turns',effort:'medium'})=>{const p=requestCostScope(16384);const b=Buffer.from(JSON.stringify({model:'fixture',input,reasoning}));for(let i=0;i<b.length;i+=11)p.push(b.subarray(i,i+11));return p.finish(true)}
  assert.deepEqual(scope([item]),[])
  for(const x of [{...item,role:'user'},{...item,type:'message'},{...item,tools:{}},{...item,unexpected:true}])assert.ok(scope([x]).includes('REQUEST_COST_SCOPE_UNKNOWN'))
  assert.ok(scope([{...item,tools:[{...tool,tools:[{type:'web_search'}]}]}]).includes('REQUEST_PROVIDER_TOOL_OR_UNKNOWN'))
  assert.ok(scope([item],{context:'unknown'}).includes('REQUEST_COST_SCOPE_UNKNOWN'))
  assert.ok(scope([item,{role:'user',content:[{type:'input_image',image_url:'fixture'}]}]).includes('REQUEST_NON_TEXT_INPUT'))
})


test('structured text output schemas do not hide unbound tools, attachments or unknown output modalities',()=>{
  const check=(format,extra={})=>{const p=requestCostScope(4096);const bytes=Buffer.from(JSON.stringify({model:'fixture',input:'text',text:{format},...extra}));for(let i=0;i<bytes.length;i+=7)p.push(bytes.subarray(i,i+7));return p.finish(true)}
  const format={type:'json_schema',name:'answer',strict:true,schema:{type:'object',properties:{input_image:{type:'string'},tools:{type:'array',items:{type:'string'}}},additionalProperties:false}}
  assert.deepEqual(check(format),[]);assert.deepEqual(check({type:'text'}),[]);assert.deepEqual(check({type:'json_object'}),[])
  for(const f of [{...format,type:'audio'},{...format,type:'text'},{...format,schema:[]},{...format,schema:undefined},{...format,type:undefined},{...format,providerMode:'unknown'}])assert.ok(check(f).includes('REQUEST_COST_SCOPE_UNKNOWN'))
  assert.ok(check(format,{input:[{role:'user',content:[{type:'input_image',image_url:'private'}]}]}).includes('REQUEST_NON_TEXT_INPUT'))
  assert.ok(check(format,{tools:[{type:'web_search'}]}).includes('REQUEST_PROVIDER_TOOL_OR_UNKNOWN'))
  assert.ok(check(format,{input:[{type:'function_call_output',call_id:'unknown',output:'text'}]}).includes('REQUEST_TOOL_HISTORY_UNBOUND'))
})
