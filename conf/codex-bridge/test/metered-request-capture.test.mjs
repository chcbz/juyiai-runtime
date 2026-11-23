import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMeteredRoot } from '../metered-request-capture.mjs'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { skillDigest } from '../skill-executor.mjs'

const openRoot = async (t, options = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'metered-'))
  t.after(() => rm(directory, {recursive:true, force:true}))
  const store = new SkillExecutionStore({rootDirectory:directory,scope:{tenant:'t',owner:'o'},
    command:{executionProtocolVersion:6,executionId:'exec1',runId:'run1',usageMode:'RESPONSE_V2',captureProtocol:'METERED_CAPTURE_V2',snapshotDigest:'a'.repeat(64)}})
  const args = { executionId:'exec1',runId:'run1',executionConfigSha256:'c'.repeat(64),engineVersion:'engine1',
    coveragePolicyVersion:'TEST_MODEL_ONLY',rootSourceId:'source_model',channelNamespace:'test_gateway',adapterVersion:'FIXTURE',checkActive:()=>{}, ...options }
  const capture = await startMeteredRoot(store, args)
  const dir = join(store.directory, `usage-capture-${capture.captureId}`)
  const read = async key => JSON.parse(await readFile(join(dir, `${key}.json`)))
  return {capture, store, args, dir, read}
}
test('concurrent sends see private, durable PENDING observations linked to the original run', async t => {
  const {capture,dir,read} = await openRoot(t)
  const plan=await read('plan'), source=await read('source-0')
  assert.equal(plan.captureId,skillDigest(['CAPTURE_V2','exec1','run1']))
  assert.equal(source.observation.sourceId,plan.observation.rootSourceId)
  const ids=await Promise.all(Array.from({length:8},()=>capture.dispatch(async request=>{
    const r=await read(`request-${request.sequence}-1`)
    assert.deepEqual(await read(`reserved-${request.sequence}`),{sequence:request.sequence})
    assert.equal(r.observation.resolution,'PENDING'); assert.equal(r.observation.sourceAttemptId,null)
    assert.equal(r.recordId,skillDigest(['USAGE_RECORD_V2',plan.captureId,'REQUEST',['source_model','0',request.sequence]]))
    const {receiptId,expectedRevision,evidenceSha256,...evidence}=r
    assert.equal(skillDigest(evidence),request.evidenceSha256); assert.equal(request.attemptId,r.observation.attemptId)
    return request.attemptId
  })))
  assert.equal(new Set(ids).size,8)
  for(const name of await readdir(dir)) assert.equal((await lstat(join(dir,name))).mode & 0o777,0o600)
})
test('failed REQUEST prewrite keeps reservation, sends nothing and cannot reopen as a fresh run',async t=>{
  const {capture,dir,read,store,args}=await openRoot(t); let sends=0
  await mkdir(join(dir,'request-1-1.json')) // actual rename failure after watermark is durable
  await assert.rejects(capture.dispatch(()=>sends++)); assert.equal(sends,0)
  assert.deepEqual(await read('reserved-1'),{sequence:'1'})
  await assert.rejects(capture.dispatch(()=>sends++),{code:'METERED_CAPTURE_ADMISSION_CLOSED'})
  await assert.rejects(startMeteredRoot(store,args),{code:'EEXIST'}); assert.equal(sends,0)
})
test('revoked after prewrite leaves unresolved evidence and cannot call upstream',async t=>{
  let checks=0,sends=0; const {capture,read}=await openRoot(t,{checkActive:()=>{if(++checks===4)throw Error('revoked')}})
  await assert.rejects(capture.dispatch(()=>sends++),/revoked/); assert.equal(sends,0)
  assert.equal((await read('request-1-1')).observation.resolution,'PENDING')
})

test('does not invent a plan for another run or a legacy command',async t=>{
  const {store,args}=await openRoot(t)
  await assert.rejects(startMeteredRoot(store,{...args,runId:'other'}),{code:'METERED_CAPTURE_BINDING_INVALID'})
  await assert.rejects(startMeteredRoot({directory:store.directory,command:{executionId:'exec1',runId:'run1'}},args),{code:'METERED_CAPTURE_BINDING_INVALID'})
})

// Real socket + TLS + filesystem, simulated namespace attestation (not a netns test).
import { RestrictedProviderEgress } from '../typed-inspection-network.mjs'
import { createServer as createHttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'

test('restricted metered listener: authenticated POST only, durable before TLS upstream, no model CONNECT or redirects', {timeout:15000}, async t=>{
  const {capture,dir,read}=await openRoot(t)
  const tlsDir=await mkdtemp(join(tmpdir(),'fake-provider-'));t.after(()=>rm(tlsDir,{force:true,recursive:true}))
  const certPath=join(tlsDir,'cert'),keyPath=join(tlsDir,'key')
  execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'})
  const ca=await readFile(certPath), requests=[]
  const upstream=createHttpsServer({key:await readFile(keyPath),cert:ca},async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk)
    requests.push({path:req.url,headers:req.headers,body:Buffer.concat(chunks).toString(),pending:(await read(`request-${requests.length+1}-1`)).observation.resolution})
    if(requests.length===2){res.writeHead(307,{Location:'https://invalid.example/'});res.end();return}
    res.writeHead(200,{'Content-Type':'text/event-stream','Set-Cookie':'private=fixture'});res.write('data: ');res.end('fixture\n\n')
  });await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>upstream.close(resolve)))
  const dest=`127.0.0.1:${upstream.address().port}`, origin=`https://${dest}`
  const eg=new RestrictedProviderEgress({providerBaseUrl:`${origin}/custom`,networkConnectTimeoutMs:1000,additionalOrigins:[origin],
    meteredResponses:{capture,ca,getProviderKey:()=>'only-upstream'}});await eg.start();t.after(()=>eg.dispose())
  const token=eg.meteredRoute.sandboxToken(), host=`10.0.2.2:${eg.port}`
  const post=({method='POST',path='/v1/responses',headers={}}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:eg.port,path,method,headers:{host,authorization:`Bearer ${token}`,'content-type':'application/json','x-secret-fixture':'do-not-forward',...headers}},async res=>{
      const chunks=[];for await(const chunk of res)chunks.push(chunk);resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),headers:res.headers})
    });req.once('error',reject);req.end('{"fixture":"正文"}')
  })
  const tunnel=await new Promise((resolve,reject)=>{const sock=connect(eg.port,'127.0.0.1',()=>sock.write(`CONNECT ${dest} HTTP/1.1\r\nHost: ${dest}\r\n\r\n`));sock.once('error',reject);sock.once('data',buf=>{sock.destroy();resolve(buf.toString())})});assert.match(tunnel,/^HTTP\/1.1 403/)
  assert.equal((await post()).status,502);eg.attestation={measured:true};eg._assertOwner=async()=>{}
  for(const args of [{method:'GET'},{headers:{host:dest}},{path:`http://${host}/v1/responses`},{path:'/v1/other'}]) assert.equal((await post(args)).status,400)
  assert.equal((await post({headers:{authorization:'Bearer other'}})).status,403);assert.equal(requests.length,0)
  const ok=await post();assert.equal(ok.body,'data: fixture\n\n');assert.equal(ok.headers['set-cookie'],undefined)
  assert.equal(requests[0].pending,'PENDING');assert.equal(requests[0].path,'/custom/responses');assert.equal(requests[0].headers.authorization,'Bearer only-upstream');assert.equal(requests[0].headers['x-secret-fixture'],undefined);assert.equal(requests[0].body,'{"fixture":"正文"}')
  const redirect=await post();assert.equal(redirect.status,502);assert.equal(redirect.headers.location,undefined)
  await mkdir(join(dir,'request-3-1.json'));assert.equal((await post()).status,502);assert.equal(requests.length,2)
  for(const name of (await readdir(dir)).filter(n=>!n.startsWith('request-3-'))) {const text=await readFile(join(dir,name),'utf8');for(const secret of [token,'only-upstream','正文']) assert.equal(text.includes(secret),false)}
  await eg.dispose();assert.throws(()=>eg.meteredRoute.sandboxToken(),/CLOSED/)
})
