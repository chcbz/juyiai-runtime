// Incremental JSON grammar for the observation side only. Retain decoded member names
// for duplicate detection while their object is open, never string values outside
// the projection. Bounds exhaust the observer, not the forwarded HTTP stream.
const NUM = Symbol(), STR = Symbol(), IGNORE = Symbol()
const detail = Object.freeze({cached_tokens:NUM}), outputDetail = Object.freeze({reasoning_tokens:NUM})
const usage = {input_tokens:NUM,output_tokens:NUM,total_tokens:NUM,input_tokens_details:detail,output_tokens_details:outputDetail}
const response = {id:STR,status:STR,usage}, envelope = {type:STR,response}
const syntax = () => { throw Error('RESPONSE_STREAM_INVALID') }
const limit = () => { throw Error('OBSERVATION_WINDOW_EXCEEDED') }
const ws = c => c===' ' || c==='\t' || c==='\r' || c==='\n'
const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
export function projectedJson(event, budget, inspect=null) {
  const root={state:'value',schema:inspect?IGNORE:event?envelope:response},stack=[root]
  let token='',raw='',keep=false,role=null,escape=false,hex=0,held=0
  const top=()=>stack.at(-1)
  const schema=f=>f===root?f.schema:f.keys && f.schema && Object.hasOwn(f.schema,f.key)?f.schema[f.key]:IGNORE
  const visit=(f,kind)=>inspect?.value(f.role,f.keys?f.key:null,kind)
  function put(f,v) {
    if(f===root){f.value=v;f.state='done';return}
    if(f.out && Object.hasOwn(f.schema,f.key)) f.out[f.key]=v
    else if(f.out && [usage,detail,outputDetail].includes(f.schema)) f.out.unsupported=null
    f.state='after'
  }
  function endAtom(){const f=top(),s=schema(f);if(!['null','true','false'].includes(raw)&&!number.test(raw))syntax()
    put(f,s===NUM && /^(0|[1-9]\d*)$/.test(raw)?Number(raw):null);raw='';token=''}
  function open(c,f){const s=schema(f),obj=c==='{',out=obj && typeof s==='object'?Object.create(null):null
    if(stack.length>=Math.min(512,budget))limit()
    const role=visit(f,obj?'object':'array');put(f,out);stack.push({role,state:obj?'firstKey':'firstItem',schema:s,keys:obj?new Set():null,out,held:0})}
  function close(f,c){if((f.keys?'}':']')!==c)syntax();inspect?.close(f.role,f.keys);held-=f.held;stack.pop()}
  function stringChar(c,f){
    if(keep){if(held+raw.length+1>budget)limit();raw+=c}
    if(hex){if(!/[0-9A-Fa-f]/.test(c))syntax();hex--;return}
    if(escape){escape=false;if(c==='u')hex=4;else if(!'"\\/bfnrt'.includes(c))syntax();return}
    if(c==='\\'){escape=true;return}if(c<' ')syntax();if(c!=='"')return
    const value=keep?JSON.parse(raw):null
    if(token==='key') {if(f.keys.has(value))syntax();const cost=value.length+1;held+=cost;f.held+=cost;f.keys.add(value);f.key=value;f.state='colon'}
    else {inspect?.scalar(role,value);put(f,value)}
    token='';raw=''
  }
  return {push(text){for(let i=0;i<text.length;i++) {const c=text[i],f=top()
    if(token==='key'||token==='string'){stringChar(c,f);continue}
    if(token==='atom'){if(/[\w.+-]/.test(c)){if(raw.length>=budget)limit();raw+=c;continue}endAtom()}
    if(ws(c))continue
    if(f.state==='done')syntax()
    if(f.state==='after'){if(c===','){f.state=f.keys?'key':'value';continue}close(f,c);continue}
    if(f.state==='firstKey'||f.state==='key'){if(f.state==='firstKey'&&c==='}'){close(f,c);continue}if(c!=='"')syntax();token='key';keep=true;raw='"';continue}
    if(f.state==='colon'){if(c!==':')syntax();f.state='value';continue}
    if(f.state==='firstItem'&&c===']'){close(f,c);continue}
    if(c==='{'||c==='['){open(c,f);continue}
    if(c==='"'){token='string';role=visit(f,'string');keep=schema(f)===STR||inspect?.read(role);raw=keep?'"':'';continue}
    if(!/[-0-9ntf]/.test(c))syntax();visit(f,'atom');token='atom';raw=c
  }},finish(){if(token==='atom')endAtom();if(token||stack.length!==1||root.state!=='done')syntax();return root.value}}
}
