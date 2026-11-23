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

import { writeFile } from 'node:fs/promises'
import { NativeExecutionProfileRuntime } from '../native-execution-runtime.mjs'
import { measureMinimalNativeExecutionToolchain } from '../native-execution-profile.mjs'

test('real metered Codex native turn uses sealed temporary HOME, measured namespace and one durable request at the TLS fixture',
  {skip:process.env.CYF_NATIVE_EXECUTION_ISOLATION_PROBE !== '1',timeout:60000}, async t=>{
  const {capture,read,store}=await openRoot(t,{engineVersion:'codex-cli-0.167.0',adapterVersion:'RESPONSES_TEXT_TOKENS_V1',coveragePolicyVersion:'TEXT_MODEL_ONLY_V1'}), root=await mkdtemp(join(tmpdir(),'mrt-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const privateDir=async name=>{const path=join(root,name);await mkdir(path,{mode:0o700});return path}
  const sourceHome=await privateDir('home'),stateRoot=await privateDir('state'),materializerRoot=await privateDir('materials')
  await writeFile(join(sourceHome,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'upstream-fixture-only'}),{mode:0o600})
  const cert=join(root,'cert'),key=join(root,'key');execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'})
  const calls=[];const upstream=createHttpsServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
    for await(const _ of req){};calls.push({path:req.url,auth:req.headers.authorization,pending:(await read(`request-${calls.length+1}-1`)).observation.resolution})
    res.writeHead(200,{'Content-Type':'text/event-stream'});for(const event of [{type:'response.created',response:{id:'resp-1'}},{type:'response.output_item.done',output_index:0,item:{id:'msg-1',type:'message',role:'assistant',content:[{type:'output_text',text:'fixture complete'}]}},{type:'response.completed',response:{id:'resp-1',status:'completed',usage:{input_tokens:10,output_tokens:2,total_tokens:12,input_tokens_details:{cached_tokens:3},output_tokens_details:{reasoning_tokens:1}}}}])res.write(`data: ${JSON.stringify(event)}\n\n`);res.end()
  });await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>upstream.close(resolve)))
  const runtime=new NativeExecutionProfileRuntime({profile:{profileId:'metered-test',agentId:'agent',codexBin:process.env.CYF_CODEX_BIN,codexHome:sourceHome,typedInspectionProviderNetwork:'restricted-proxy',typedInspectionProviderId:'fixture',typedInspectionProviderBaseUrl:`https://127.0.0.1:${upstream.address().port}/custom`,typedInspectionNetworkConnectTimeoutMs:2000,typedInspectionCaBundlePath:cert},materializerRoot,stateRoot,nativeToolchain:measureMinimalNativeExecutionToolchain()})
  const spawn=runtime._spawnAdapter.bind(runtime);let inspected=false
  runtime._spawnAdapter=async args=>{const staged=JSON.parse(await readFile(args.engineState.authPath));assert.match(staged.OPENAI_API_KEY,/^[a-f0-9]{64}$/);assert.notEqual(staged.OPENAI_API_KEY,'upstream-fixture-only');inspected=true;return spawn(args)}
  const binding={schemaVersion:1,requestKey:'metered-request',authorizationId:'exec1',manifestDigest:'manifest-1',requestId:'req-1',turnId:'turn-1',inputPolicyDigest:'policy-1'}
  try {
    const adapter=await runtime.openNativeExecutionAdapter(join(store.directory,'inputs'),binding.requestKey,binding,{scratchDirectory:join(store.directory,'scratch'),draftsDirectory:join(store.directory,'drafts'),nativeExecution:{executionId:'exec1',tools:[],checkActive(){},callTool(){}},meteredCapture:capture})
    assert.ok(inspected);assert.ok(adapter.readback.credentialIsolation.bootstrapCredentialRemoved);assert.ok(adapter.nativeExecutionIsolation.network.nftDefaultDropReadback)
    const policy={cwd:'/execution',model:'gpt-5.4'},thread=await adapter.startOrResumeThread(null,policy)
    await adapter.runTurn({threadId:thread.threadId,clientUserMessageId:'fixture-message',policy,input:[{type:'text',text:'fixture'}]})
    assert.deepEqual(calls,[{path:'/custom/responses',auth:'Bearer upstream-fixture-only',pending:'PENDING'}])
    await capture.stopAndDrain()
    const linked=await read('request-1-2'), response=await read(`response-${linked.observation.sourceAttemptId}-1`)
    assert.equal(linked.previousEvidenceSha256,(await read('request-1-1')).evidenceSha256);assert.equal(linked.observation.resolution,'RESPONSE')
    assert.equal(response.expectedRevision,'0');assert.equal(response.observation.actualBillingIdentity,null)
    assert.deepEqual(response.observation.measuredQuantities.tokens,{INPUT:'7',CACHED_INPUT:'3',OUTPUT:'2'})
    await runtime.releaseAdapter(binding.requestKey,{requestBinding:binding})
    const sourceFinal=await read('source-final-1'),captureFinal=await read('capture-final-1')
    assert.equal(sourceFinal.observation.closeState,'DRAINED');assert.equal(sourceFinal.observation.requestCount,'1')
    const tuple=r=>[r.recordId,r.sourceRevision,r.evidenceSha256]
    assert.equal(sourceFinal.observation.recordsSha256,skillDigest([await read('source-0'),linked,response].map(tuple).sort(([a],[b])=>a<b?-1:1)))
    assert.equal(captureFinal.observation.sourcesSha256,skillDigest([tuple(sourceFinal)]));assert.equal((await read('usage-capture-finalized')).closeState,'DRAINED')
  } finally {await runtime.dispose()}
})

import { observeResponse } from '../metered-response-observation.mjs'
test('UTF-8 CRLF streaming keeps only numeric usage; unknown/missing/truncated evidence cannot normalize',()=>{
  const raw={id:'response_1',status:'completed',output:'绝不保存正文',usage:{input_tokens:5,output_tokens:4,total_tokens:9,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:1}}}
  const observe=(r,ended=true,supported=true)=>{const o=observeResponse('text/event-stream',200,4096,supported);for(const b of Buffer.from(`data: ${JSON.stringify({type:'response.completed',response:r})}\r\n\r\n`))o.push(Buffer.from([b]));return o.finish(ended)}
  const v=observe(raw);assert.equal(v.providerResponseId,'response_1');assert.deepEqual(v.measuredQuantities.tokens,{INPUT:'3',CACHED_INPUT:'2',OUTPUT:'4'});assert.ok(!JSON.stringify(v).includes(raw.output))
  for(const v of [observe(raw,false),observe(raw,true,false),observe({...raw,usage:null}),observe({...raw,usage:{...raw.usage,adversarial:raw.output}})]){assert.equal(v.measuredQuantities,null);assert.ok(!JSON.stringify(v).includes(raw.output))}
  const o=observeResponse('application/json',200,4096,true);o.push(Buffer.from(JSON.stringify(raw).replace('"input_tokens":5','"input_tokens":4.9999999999999999999')));assert.equal(o.finish(true).measuredQuantities,null)
  const bounded=observeResponse('text/event-stream',200,24,true);bounded.push(Buffer.alloc(128,65));assert.ok(bounded.finish(true).reasonCodes.includes('OBSERVATION_WINDOW_EXCEEDED'))
})
test('duplicate provider identity never overwrites a response and an unresolved request revises its own pending record',async t=>{
  const {capture,dir,read}=await openRoot(t), observe=observeResponse('application/json',200,4096,false)
  observe.push(Buffer.from('{"id":"resp_shared","status":"completed"}'));const evidence=observe.finish(true)
  await Promise.all([1,2].map(()=>capture.dispatch((_req,finish)=>finish(evidence))))
  await capture.dispatch((_req,finish)=>finish(observeResponse('application/json',503,4096,false).finish(false)))
  await capture.stopAndDrain();const keys=await readdir(dir),duplicates=keys.filter(x=>x.startsWith('duplicate-'));assert.equal(duplicates.length,1)
  assert.equal(keys.filter(x=>/^response-[a-f0-9]+-1\.json$/.test(x)).length,1)
  const a=await read('request-1-2'),b=await read('request-2-2');assert.equal(a.observation.sourceAttemptId,b.observation.sourceAttemptId);assert.ok([a,b].some(x=>x.observation.reasonCodes.includes('DUPLICATE_RESPONSE_ID')))
  const u=await read('request-3-2');assert.equal(u.observation.resolution,'UNRESOLVED');assert.equal(u.observation.sourceAttemptId,null)
})

import { recoverStoppedMeteredRoot } from '../metered-capture-closure.mjs'
test('quiesced source recovery reuses immutable FINAL, repairs missing marker, never sends or calls pending free',async t=>{
  const {capture,dir,store,read}=await openRoot(t);let sent=0
  await capture.dispatch(()=>sent++);await capture.stopAndDrain()
  await assert.rejects(recoverStoppedMeteredRoot(store,()=>{throw Error('not quiesced')}),/quiesced/)
  const closed=await recoverStoppedMeteredRoot(store,()=>{});assert.equal(closed.closeState,'SEALED_INCOMPLETE')
  const one=await read('source-final-1'),two=await read('capture-final-1')
  assert.equal(one.observation.reservedSequenceHighWatermark,'1');assert.equal(one.observation.responseCount,'0')
  assert.ok(one.observation.reasonCodes.includes('UNRESOLVED_REQUEST'));assert.ok(one.observation.reasonCodes.includes('PRODUCER_WATERMARK_UNCONFIRMED'))
  await rm(join(dir,'usage-capture-finalized.json'));assert.deepEqual(await recoverStoppedMeteredRoot(store,()=>{}),closed)
  assert.deepEqual(await capture.sealStopped(()=>{}),closed);assert.deepEqual(await read('source-final-1'),one);assert.deepEqual(await read('capture-final-1'),two);assert.equal(sent,1)
  const altered=await read('request-1-1');altered.observation.attemptId='other';await writeFile(join(dir,'request-1-1.json'),JSON.stringify(altered));await assert.rejects(recoverStoppedMeteredRoot(store,()=>{}),{code:'METERED_CAPTURE_SOURCE_CONFLICT'})
})
test('a reservation without a persisted REQUEST seals incomplete with high water one and request count zero',async t=>{
  const {dir,capture,read}=await openRoot(t);await mkdir(join(dir,'request-1-1.json'));await assert.rejects(capture.dispatch(()=>assert.fail('sent')))
  await rm(join(dir,'request-1-1.json'),{recursive:true});const closed=await capture.sealStopped(()=>{});assert.equal(closed.closeState,'SEALED_INCOMPLETE')
  const source=(await read('source-final-1')).observation;assert.equal(source.reservedSequenceHighWatermark,'1');assert.equal(source.requestCount,'0');assert.ok(source.reasonCodes.includes('SEQUENCE_GAP'))
})

import { SkillUsageDelivery } from '../skill-usage-delivery.mjs'
test('stopped delivery discovers completed scoped V2 without replay, legacy upload, or false ACK on missing PLAN',async t=>{
  const rootDir=await mkdtemp(join(tmpdir(),'v2-flush-'));t.after(()=>rm(rootDir,{recursive:true,force:true}))
  const scope={agentId:'agent',tenantId:'tenant',ownerJiacn:'owner'},apiOrigin='https://fixture.invalid'
  const config={rootDir,apiOrigin,scope,agentId:'agent',runtimeInstanceId:'rt',getRuntimeHeaders:()=>assert.fail('unexpected auth'),fetchFn:()=>assert.fail('unexpected delivery')}
  const command={executionProtocolVersion:6,executionId:'exec1',runId:'run1',scope:{kind:'TASK',taskId:'task',conversationId:'conv',conversationGeneration:'1'},commandId:'cmd',messageId:'msg',skills:[],snapshotDigest:'a'.repeat(64),parameters:{},instruction:'fixture',inputRefs:[],outputs:{dataSchema:null,mimeTypes:[],multiple:false,artifactsRequired:false},toolPolicyRef:'NATIVE_LOCAL_FILES_V1',usageMode:'RESPONSE_V2',captureProtocol:'METERED_CAPTURE_V2'}
  const store=new SkillExecutionStore({rootDirectory:join(rootDir,'skill-runs'),scope:{...scope,apiOrigin},command});store.write('attempt',{started:true});store.write('receipt',{done:true})
  const lane=new SkillUsageDelivery(config);assert.deepEqual(lane.pendingCommands(),[])
  const missing=await lane.flush();assert.equal(missing.confirmed,false);assert.equal(missing.pending,1);assert.ok(missing.errors.length)
  const foreign=new SkillUsageDelivery({...config,scope:{...scope,tenantId:'other'}});assert.equal((await foreign.flush()).pending,0)
  await startMeteredRoot(store,{executionId:'exec1',runId:'run1',executionConfigSha256:'c'.repeat(64),engineVersion:'fixture',coveragePolicyVersion:'fixture',rootSourceId:'root',channelNamespace:'fixture',adapterVersion:'fixture',checkActive(){}})
  const report=await lane.flush();assert.deepEqual(report,{confirmed:false,captureStates:[{executionId:'exec1',captureState:'FINALIZED',closeState:'SEALED_INCOMPLETE',deliveryState:'PENDING_ACK'}],pending:1,errors:[]});assert.deepEqual(await lane.flush(),report)
})
test('stopped seal waits for in-flight response persistence and closes admission first',async t=>{
  const {capture,dir,read}=await openRoot(t),entered=Promise.withResolvers(),resume=Promise.withResolvers()
  const work=capture.dispatch(async(_request,finish)=>{entered.resolve();await resume.promise;await finish(observeResponse('application/json',503,512,false).finish(false))})
  await entered.promise;capture.stopAdmission();const seal=capture.sealStopped(()=>{})
  try { await assert.rejects(capture.dispatch(()=>assert.fail()),{code:'METERED_CAPTURE_ADMISSION_CLOSED'});assert.ok(!(await readdir(dir)).includes('producer-stopped.json')) } finally {resume.resolve()}
  await work;await seal;assert.equal((await read('request-1-2')).observation.resolution,'UNRESOLVED');assert.equal((await read('source-final-1')).observation.closeState,'SEALED_INCOMPLETE')
})
