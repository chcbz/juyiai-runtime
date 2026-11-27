import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, existsSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { openBusinessSocket, BUSINESS_API_SOCKET } from '../execution-business-api.mjs'
import { skillConversationHttpScope } from '../../cyf-agent-runtime-v1/lib/runtime-client.mjs'
const run = promisify(execFile)
const query = (socketPath, method, path, data) => new Promise((ok, fail) => {
  const req = request({ socketPath, method, path, headers: {'Content-Type':'application/json'} }, res => { res.resume(); res.on('end', () => ok(res.statusCode)) }); req.on('error',fail); req.end(JSON.stringify(data))
})
test('real namespace: skill client sees only the mounted execution socket; closed execution cannot be reused', async t => {
  const parent = mkdtempSync(join(tmpdir(),'business-read-')); t.after(() => rmSync(parent,{recursive:true,force:true}))
  const calls = []; let denied = false
  const open = label => openBusinessSocket(parent, async (resource,data) => {
    if (denied) throw Object.assign(new Error('private'),{status:403}); calls.push([label,resource,data]); return {label}
  })
  const a = await open('a'), b = await open('b'); t.after(() => {a.dispose(); b.dispose()})
  const client = async sock => (await run('bwrap',['--unshare-all','--uid','65534','--gid','65534','--cap-drop','ALL','--ro-bind','/usr','/usr',...['lib','lib64','bin'].filter(p=>existsSync('/'+p)).flatMap(p=>['--ro-bind','/'+p,'/'+p]),'--proc','/proc','--dev','/dev','--ro-bind',fileURLToPath(new URL('../../skills/model-maintenance/scripts/lookup.py',import.meta.url)),'/lookup.py',...(sock?['--ro-bind',sock,BUSINESS_API_SOCKET]:[]),'--',realpathSync('/usr/bin/python3'),'-I','/lookup.py','price','sample'],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},timeout:8000})).stdout
  assert.equal(JSON.parse(await client(a.socket)).label,'a'); assert.equal(JSON.parse(await client(b.socket)).label,'b'); await assert.rejects(client(null))
  for(const [method,path,data,code] of [['GET','/model-prices/lookup',{},404],['POST','/other/write',{},404],['POST','/other/commit',{},404],['POST','/other/receipt',{},404],['POST','/other/lookup?x=1',{},404],['POST','/other/lookup',{fence:{}},400],['POST','/other/lookup',{snapshotSha256:'x'},400]]) assert.equal(await query(a.socket,method,path,data),code)
  denied = true; await assert.rejects(client(a.socket), /403/); a.dispose(); await assert.rejects(query(a.socket,'POST','/other/lookup',{})); assert.deepEqual(calls,['a','b'].map(label=>[label,'model-prices',{model:'sample'}]))
})
test('native policy permits POST lookups but not actions, encoded resources or queries', () => {
  const allowed = (method,suffix) => skillConversationHttpScope(new URL('https://example.invalid/internal/agent/executions/e/runs/r/business/'+suffix),{method})
  assert.equal(allowed('POST','any-resource/lookup'),true)
  for (const [m,s] of [['GET','any-resource/lookup'],['POST','r/update'],['POST','r/lookup?'],['POST','%72/lookup'],['POST','r/extra/lookup']]) assert.equal(allowed(m,s),false)
})

test('domain commit spools one bounded binary attachment and never forwards transport metadata',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'domain-attach-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const meta=Buffer.from(JSON.stringify({payload:{note:'测试'}})), bytes=Buffer.alloc(192*1024,170);let calls=0
  const s=await openBusinessSocket(dir,async(resource,data,signal,action,blob)=>{
    calls++;assert.deepEqual([resource,data,action],['any-resource',{payload:{note:'测试'}},'commit']);assert.deepEqual(Buffer.from(await blob.arrayBuffer()),bytes);return {ok:true}
  },{write:true});t.after(()=>s.dispose());
  const send=(action,m,len,parts)=>new Promise((ok,fail)=>{const q=request({method:'POST',socketPath:s.socket,path:'/any-resource/'+action,headers:{'content-type':'application/octet-stream','content-length':len,'x-cyf-metadata-length':m}},r=>{r.resume();r.on('end',()=>ok(r.statusCode))});q.on('error',fail);for(const p of parts)q.write(p);q.end()});
  assert.equal(await send('commit',meta.length,meta.length+bytes.length,[meta,bytes]),200);
  assert.equal(await send('lookup',2,3,['{}a']),415);assert.equal(await send('commit',2,16777219,[]),413);
  const forged=Buffer.from('{"fence":{}}');assert.equal(await send('commit',forged.length,forged.length+1,[forged,'a']),400);assert.equal(calls,1)
})

test('model-maintenance route CLI uses the existing authorized socket and preserves exact receipt input', async t => {
  const parent=mkdtempSync(join(tmpdir(),'route-admin-'));t.after(()=>rmSync(parent,{recursive:true,force:true}))
  const calls=[];const socket=await openBusinessSocket(parent,async(resource,data,signal,verb)=>{calls.push({resource,data,verb});return {recorded:true}},{write:true});t.after(()=>socket.dispose())
  const script=fileURLToPath(new URL('../../skills/model-maintenance/scripts/lookup.py',import.meta.url))
  const client=async(action,data,sock=socket.socket)=>run('bwrap',['--unshare-all','--uid','65534','--gid','65534','--cap-drop','ALL','--ro-bind','/usr','/usr',...['lib','lib64','bin'].filter(p=>existsSync('/'+p)).flatMap(p=>['--ro-bind','/'+p,'/'+p]),'--proc','/proc','--dev','/dev','--ro-bind',script,'/lookup.py','--ro-bind',sock,BUSINESS_API_SOCKET,'--',realpathSync('/usr/bin/python3'),'-I','/lookup.py',action,typeof data==='string'?data:JSON.stringify(data)],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},timeout:8000})
  const command=JSON.parse(readFileSync(new URL('./fixtures/cost-route-maintenance.json',import.meta.url),'utf8'))
  const {reference}=command
  for(const [action,data] of [['route-lookup',{reference}],['route-commit',command],['route-receipt',command]])assert.equal(JSON.parse((await client(action,data)).stdout).recorded,true)
  assert.deepEqual(calls,[{resource:'cost-route-bindings',data:{reference},verb:'lookup'},{resource:'cost-route-bindings',data:command,verb:'commit'},{resource:'cost-route-bindings',data:command,verb:'receipt'}])
  await assert.rejects(client('route-commit',{...command,fence:{}}));await assert.rejects(client('route-commit','{"reference":{},"reference":{}}'));assert.equal(calls.length,3)
  const readOnly=await openBusinessSocket(parent,async()=>{throw Error('must not dispatch mutation')});t.after(()=>readOnly.dispose())
  await assert.rejects(client('route-commit',command,readOnly.socket),/404/);assert.equal(calls.length,3)
})
