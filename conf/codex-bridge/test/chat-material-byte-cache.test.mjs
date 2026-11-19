import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile, readdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TypedInspectionMaterializer } from '../typed-inspection-runtime.mjs'
import { ChatMaterialByteCache } from '../chat-material-byte-cache.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'material-cache-')); t.after(() => rm(root,{recursive:true,force:true}))
  const cacheDir = join(root,'cache'), calls = [], scope = {tenantId:'0',clientId:'client',ownerJiacn:'owner',taskId:'task'}
  let n = 0, mode = 'allow', content = Buffer.from('draft')
  const m = new TypedInspectionMaterializer({rootDir:join(root,'turns'), cacheDir, apiOrigin:'https://api.example', agentId:'agent',runtimeInstanceId:'runtime',
    getRuntimeHeaders:()=>({Authorization:`AgentRuntime rts1_${'a'.repeat(64)}`, 'X-Agent-Id':'agent','X-Agent-Runtime-Id':'runtime','X-Agent-Installation-Id':'install','X-Agent-Host-Id':'host','X-Agent-Session-Generation':'1'}),
    fetchFn:async (url,{headers})=>{
      const tag = headers['If-None-Match']; calls.push({tag,manifest:headers['X-Materials-Manifest-Digest']})
      if(mode==='network') throw new Error('offline')
      if(mode==='revoked') return {status:403}
      if(tag) return {url,status:304,headers:{etag:mode==='bad-tag'?'wrong':tag},arrayBuffer:()=>assert.fail('304 body read')}
      return {url,status:200,headers:{'content-type':'text/plain','content-length':String(content.length)},body:content}
    }})
  const round = async () => {
    n++; const message = {...scope,requestId:`r${n}`,turnId:`t${n}`}, digest = createHash('sha256').update(content).digest('hex')
    const source = {sourceRefId:'s',sha256:digest,byteLength:String(content.length),mimeType:'text/plain',carrier:'LOCAL_FILE',downloadUrl:`/internal/agent/chat/requests/r${n}/turns/t${n}/materials/inputs/s/content`}
    const typed = {authorizationId:`a${n}`,manifestDigest:`manifest-${n}`,manifest:{sources:[source]}}
    const result = await m.materialize({message,typed,contract:'materials'})
    assert.deepEqual(await readFile(result.sources[0].path),content); m.cleanup({message,typed})
    return `"${digest}"`
  }
  return {round,calls,scope,cacheDir,mode:value=>mode=value,content:value=>content=Buffer.from(value)}
}
test('two turns use their own authorization; only the first transfers the original bytes',async t=>{
  const f = await fixture(t), tag = await f.round(); await f.round()
  assert.deepEqual(f.calls,[{tag:undefined,manifest:'manifest-1'},{tag,manifest:'manifest-2'}])
  for (const field of Object.keys(f.scope)) { f.scope[field]+='2'; await f.round(); assert.equal(f.calls.at(-1).tag,undefined) }
  f.content('replacement'); await f.round(); assert.equal(f.calls.at(-1).tag,undefined)
})
test('corrupt cache triggers exactly one unconditional read; auth/network/invalid validators never use cached bytes',async t=>{
  const f = await fixture(t), tag = await f.round(); const [name] = await readdir(f.cacheDir)
  await writeFile(join(f.cacheDir,name),'wrong'); await f.round(); assert.deepEqual(f.calls.map(c=>c.tag),[undefined,tag,undefined])
  for(const mode of ['network','revoked','bad-tag']) { f.mode(mode); const n=f.calls.length; await assert.rejects(f.round()); assert.equal(f.calls.length,n+1); assert.equal(f.calls.at(-1).tag,tag) }
  f.mode('allow'); await rm(f.cacheDir,{recursive:true}); await f.round(); assert.equal(f.calls.at(-1).tag,undefined)
})
test('cache capacity and age evict entries without touching unrelated files',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'byte-retention-')); t.after(()=>rm(dir,{recursive:true,force:true}))
  const c=new ChatMaterialByteCache(dir,{maxBytes:3,maxAge:60000}), a='a'.repeat(64), b='b'.repeat(64)
  await c.put(a,Buffer.from('123')); await utimes(join(dir,a),new Date(),new Date(Date.now()-5000)); await c.put(b,Buffer.from('456')); await writeFile(join(dir,'other'),'untouched'); await c.prune()
  assert.deepEqual((await readdir(dir)).sort(),[b,'other']); await utimes(join(dir,b),new Date(0),new Date(0)); assert.equal(await c.has(b),false); await c.prune(); assert.deepEqual(await readdir(dir),['other'])
})
