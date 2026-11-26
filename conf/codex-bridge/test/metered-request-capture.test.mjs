import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMeteredRoot } from '../metered-request-capture.mjs'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { skillDigest } from '../skill-executor.mjs'

const openRoot = async (t, options = {}, deferred = false) => {
  const directory = await mkdtemp(join(tmpdir(), 'metered-'))
  t.after(() => rm(directory, {recursive:true, force:true}))
  const store = new SkillExecutionStore({rootDirectory:directory,scope:{tenant:'t',owner:'o'},
    command:{executionProtocolVersion:6,executionId:'exec1',runId:'run1',messageId:'fixture-message',toolPolicyRef:'NATIVE_LOCAL_FILES_V1',usageMode:'RESPONSE_V2',captureProtocol:'METERED_CAPTURE_V2',snapshotDigest:'a'.repeat(64)}})
  const args = { executionId:'exec1',runId:'run1',executionConfigSha256:'c'.repeat(64),engineVersion:'engine1',
    coveragePolicyVersion:'TEST_MODEL_ONLY',rootSourceId:'source_model',channelNamespace:'test_gateway',adapterVersion:'FIXTURE',checkActive:()=>{}, ...options }
  const capture = deferred ? null : await startMeteredRoot(store, args)
  const dir = join(store.directory, `usage-capture-${skillDigest(['CAPTURE_V2','exec1','run1'])}`)
  const read = async key => JSON.parse(await readFile(join(dir, `${key}.json`)))
  return {capture, store, args, dir, read}
}
test('concurrent sends see private, durable PENDING observations linked to the original run', async t => {
  const {capture,dir,read} = await openRoot(t)
  const plan=await read('plan'), source=await read('source-0')
  assert.equal(plan.captureId,skillDigest(['CAPTURE_V2','exec1','run1']))
  assert.equal(plan.observation.snapshotSha256,'a'.repeat(64));assert.equal(source.observation.sourceId,plan.observation.rootSourceId)
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
  const {capture,dir,read}=await openRoot(t,{engineVersion:'codex-cli-0.167.0',adapterVersion:'RESPONSES_TEXT_TOKENS_V1',coveragePolicyVersion:'TEXT_MODEL_ONLY_V1'})
  const tlsDir=await mkdtemp(join(tmpdir(),'fake-provider-'));t.after(()=>rm(tlsDir,{force:true,recursive:true}))
  const certPath=join(tlsDir,'cert'),keyPath=join(tlsDir,'key')
  execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'})
  const ca=await readFile(certPath), requests=[]
  const upstream=createHttpsServer({key:await readFile(keyPath),cert:ca},async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk)
    requests.push({path:req.url,headers:req.headers,body:Buffer.concat(chunks).toString(),pending:(await read(`request-${requests.length+1}-1`)).observation.resolution})
    if(requests.length===2){res.writeHead(307,{Location:'https://invalid.example/'});res.end();return}
    if(requests.length>=3){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'r'+requests.length,status:'completed',usage:{input_tokens:5,total_tokens:9,output_tokens:4,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:1}}}));return}
    res.writeHead(200,{'Content-Type':'text/event-stream','Set-Cookie':'private=fixture'});res.write('data: ');res.end('fixture\n\n')
  });await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>upstream.close(resolve)))
  const dest=`127.0.0.1:${upstream.address().port}`, origin=`https://${dest}`
  const eg=new RestrictedProviderEgress({providerBaseUrl:`${origin}/custom`,networkConnectTimeoutMs:1000,additionalOrigins:[origin],
    meteredResponses:{capture,ca,getProviderKey:()=>'only-upstream'}});await eg.start();t.after(()=>eg.dispose())
  const token=eg.meteredRoute.sandboxToken(), host=`10.0.2.2:${eg.port}`
  const post=({method='POST',path='/v1/responses',headers={},body='{"fixture":"正文"}'}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:eg.port,path,method,headers:{host,authorization:`Bearer ${token}`,'content-type':'application/json','x-secret-fixture':'do-not-forward',...headers}},async res=>{
      const chunks=[];for await(const chunk of res)chunks.push(chunk);resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),headers:res.headers})
    });req.once('error',reject);req.end(body)
  })
  const tunnel=await new Promise((resolve,reject)=>{const sock=connect(eg.port,'127.0.0.1',()=>sock.write(`CONNECT ${dest} HTTP/1.1\r\nHost: ${dest}\r\n\r\n`));sock.once('error',reject);sock.once('data',buf=>{sock.destroy();resolve(buf.toString())})});assert.match(tunnel,/^HTTP\/1.1 403/)
  assert.equal((await post()).status,502);eg.attestation={measured:true};eg._assertOwner=async()=>{}
  for(const args of [{method:'GET'},{headers:{host:dest}},{path:`http://${host}/v1/responses`},{path:'/v1/other'}]) assert.equal((await post(args)).status,400)
  assert.equal((await post({headers:{authorization:'Bearer other'}})).status,403);assert.equal(requests.length,0)
  const ok=await post();assert.equal(ok.body,'data: fixture\n\n');assert.equal(ok.headers['set-cookie'],undefined)
  assert.equal(requests[0].pending,'PENDING');assert.equal(requests[0].path,'/custom/responses');assert.equal(requests[0].headers.authorization,'Bearer only-upstream');assert.equal(requests[0].headers['x-secret-fixture'],undefined);assert.equal(requests[0].body,'{"fixture":"正文"}')
  const redirect=await post();assert.equal(redirect.status,502);assert.equal(redirect.headers.location,undefined)
  const examples=[{input:'正文'},{input:'正文',tools:[{type:'web_search'}]},{input:[{role:'user',content:[{type:'input_image',image_url:'private-fixture'}]}]}]
  for(const [i,x] of examples.entries()){const body=JSON.stringify({model:'fixture',...x});const reply=await post({body});assert.equal(reply.status,200);assert.equal(JSON.parse(reply.body).id,'r'+(i+3));assert.equal(requests.at(-1).body,body)}
  await mkdir(join(dir,'request-6-1.json'));assert.equal((await post()).status,502);assert.equal(requests.length,5)
  await assert.rejects(capture.stopAndDrain(),{code:'METERED_CAPTURE_WRITE_INCOMPLETE'})
  for(const [i,reason] of [null,'REQUEST_PROVIDER_TOOL_OR_UNKNOWN','REQUEST_NON_TEXT_INPUT'].entries()){
    const req=await read('request-'+(i+3)+'-2'), obs=(await read('response-'+req.observation.sourceAttemptId+'-1')).observation
    assert.equal(obs.reportedUsage.input_tokens,5);if(reason){assert.equal(obs.measuredQuantities,null);assert.ok(obs.reasonCodes.includes(reason))}else assert.equal(obs.measuredQuantities.tokens.INPUT,'3')
  }
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    let text=entry.name
    if(entry.isDirectory()) {assert.match(entry.name,/^(?:request-6-1\.json|response-owner-[a-f0-9]{64})$/);assert.deepEqual(await readdir(join(dir,entry.name)),[])}
    else {assert.ok(entry.isFile());text+=await readFile(join(dir,entry.name),'utf8')}
    for(const secret of [token,'only-upstream','正文','private-fixture'])assert.equal(text.includes(secret),false)
  }
  await eg.dispose();assert.throws(()=>eg.meteredRoute.sandboxToken(),/CLOSED/)
})

import { writeFile } from 'node:fs/promises'
import { NativeExecutionProfileRuntime } from '../native-execution-runtime.mjs'
import { measureMinimalNativeExecutionToolchain } from '../native-execution-profile.mjs'

for (const admitted of [false,true,'artifact','answer','file','empty']) test(admitted==='file'?'real text file delivery keeps unbound native shell history out of complete cost samples':admitted==='answer'?'prepared LOCAL_ANSWER group matches the metered structured answer actually delivered':admitted==='empty'?'real engine missing empty thread stays unresolved without another source, turn or model call':admitted==='artifact'?'real metered native execution ties its second request to the successful result proposal':admitted ? 'admitted V2 profile measures the CLI, persists before real TLS and retains suspend watermark without false coverage' : 'real metered Codex native turn uses sealed temporary HOME, measured namespace and one durable request at the TLS fixture',
  {skip:process.env.CYF_NATIVE_EXECUTION_ISOLATION_PROBE !== '1',timeout:60000}, async t=>{
  const {capture,read,store}=await openRoot(t,{engineVersion:'codex-cli-0.167.0',adapterVersion:'RESPONSES_TEXT_TOKENS_V1',coveragePolicyVersion:'TEXT_MODEL_ONLY_V1'},admitted), root=await mkdtemp(join(tmpdir(),'mrt-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const privateDir=async name=>{const path=join(root,name);await mkdir(path,{mode:0o700});return path}
  const sourceHome=await privateDir('home'),stateRoot=await privateDir('state'),materializerRoot=await privateDir('materials')
  await writeFile(join(sourceHome,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'upstream-fixture-only'}),{mode:0o600})
  const cert=join(root,'cert'),key=join(root,'key');execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'})
  let actualRead=read;const calls=[];const upstream=createHttpsServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));calls.push({path:req.url,auth:req.headers.authorization,pending:(await actualRead(`request-${calls.length+1}-1`)).observation.resolution})
    const firstTool=['artifact','answer','empty'].includes(admitted)&&calls.length===1, id='resp-'+calls.length
    let item=firstTool?{id:'fc_1',type:'function_call',call_id:'call_local_1',name:'result_propose',arguments:JSON.stringify({summary:'fixture proposal',artifactRefs:[],data:admitted==='answer'?{answer:'fixture answer'}:null})}:
      {id:'msg-1',type:'message',role:'assistant',content:[{type:'output_text',text:'fixture complete'}]}
    if(admitted==='file' && calls.length<=3){
      const call=(name,args,ns)=>({id:'fc_'+calls.length,type:'function_call',call_id:'file_call_'+calls.length,name,...(ns?{namespace:ns}:{}),arguments:JSON.stringify(args)})
      if(calls.length===1){
        const catalog=body.tools.flatMap(t=>t.type==='namespace'?t.tools.map(tool=>({...tool,ns:t.name})):[t]);
        const shell=catalog.find(x=>['exec_command','shell_command','shell'].includes(x.name));
        const cmd='printf file-fixture > /outputs/result.txt';
        if(shell)item=call(shell.name,shell.name==='exec_command'?{cmd}:shell.name==='shell'?{command:['/bin/bash','-c',cmd]}:{command:cmd},shell.ns)
        t.diagnostic('file fixture offered tools: '+catalog.map(x=>x.name).join(','))
      }else if(calls.length===2)item=call('artifact_stage',{path:'/outputs/result.txt',displayName:'result.txt',mediaTypeHint:'text/plain'})
      else {
        const staged=body.input.find(x=>x.type==='function_call_output'&&x.call_id==='file_call_2');
        const ref=JSON.stringify(staged?.output??null).match(/output_[0-9a-f]{64}/)?.[0];
        if(ref)item=call('result_propose',{summary:'file fixture',artifactRefs:[ref],data:null})
      }
    }
    if(['artifact','answer'].includes(admitted)&&calls.length===2)calls[1].history=body.input.filter(x=>x.type?.startsWith('function_call')).map(x=>[x.type,x.call_id])
    res.writeHead(200,{'Content-Type':'text/event-stream'});for(const event of [{type:'response.created',response:{id}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',usage:{input_tokens:10,output_tokens:2,total_tokens:12,input_tokens_details:{cached_tokens:3},output_tokens_details:{reasoning_tokens:1}}}}])res.write(`data: ${JSON.stringify(event)}\n\n`);res.end()
  });await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>upstream.close(resolve)))
  const runtime=new NativeExecutionProfileRuntime({profile:{profileId:'metered-test',agentId:admitted==='answer'?'agt_00000000000000000000000000000002':'agent',chatModel:'gpt-5.4',chatReasoningEffort:'medium',codexBin:process.env.CYF_CODEX_BIN,codexHome:sourceHome,typedInspectionProviderNetwork:'restricted-proxy',typedInspectionProviderId:'fixture',typedInspectionProviderBaseUrl:`https://127.0.0.1:${upstream.address().port}/custom`,typedInspectionNetworkConnectTimeoutMs:2000,typedInspectionCaBundlePath:cert},materializerRoot,stateRoot,nativeToolchain:measureMinimalNativeExecutionToolchain()})
  const spawn=runtime._spawnAdapter.bind(runtime);let inspected=false
  runtime._spawnAdapter=async args=>{if(args.nativeExecution.executionId!=='exec1')return spawn(args);const staged=JSON.parse(await readFile(args.engineState.authPath));assert.match(staged.OPENAI_API_KEY,/^[a-f0-9]{64}$/);assert.notEqual(staged.OPENAI_API_KEY,'upstream-fixture-only');inspected=true;return spawn(args)}
  const binding={schemaVersion:1,requestKey:'metered-request',authorizationId:'exec1',manifestDigest:'sha256:'+store.command.snapshotDigest,requestId:'req-1',turnId:'turn-1',inputPolicyDigest:'policy-1'}
  try {
    if(['artifact','answer','file','empty'].includes(admitted)){
      const scope={kind:'TASK',taskId:admitted==='answer'?'billing-task':'task',conversationId:'42',conversationGeneration:'1'}
      // Actual Java request exported by the signed selection integration, not reconstructed from PLAN.
      const wire=admitted==='answer'?await readFile(new URL('./fixtures/selected-answer-probe.json',import.meta.url)):null
      const probe=wire?JSON.parse(wire):null
      const command={...store.command,runId:'run-exec1',snapshotDigest:skillDigest({executionProtocolVersion:6,scope}),scope,commandId:'cmd',messageId:'msg',instruction:'fixture',parameters:{},inputRefs:[],outputs:probe?probe.data.outputs:admitted==='file'?{mimeTypes:['text/plain'],artifactsRequired:true,multiple:true}:{mimeTypes:[],artifactsRequired:false,multiple:false,dataSchema:null}}
      const actual=new SkillExecutionStore({rootDirectory:root,scope:{agentId:runtime.profile.agentId},command})
      // Read this real execution's source records at the upstream, not the first harness's directory.
      actualRead=async key=>JSON.parse(await readFile(join(actual.directory,`usage-capture-${skillDigest(['CAPTURE_V2',command.executionId,command.runId])}`,key+'.json')))
      const {runNativeExecution,compareProspectiveTaskConfiguration}=await import('../native-execution.mjs')
      // Independent deployment measurement: no PLAN or source records exist yet.
      assert.ok(await runtime.measureNativeExecution(),JSON.stringify(runtime.nativeExecutionMeasurementFailure))
      const comparisonOutputs=admitted==='file'?{...command.outputs,dataSchema:null}:command.outputs
      const group=compareProspectiveTaskConfiguration(runtime,{scopeKind:'TASK',outputs:comparisonOutputs,entries:[],skillConfiguration:[],privateTools:null,toolPolicyRef:command.toolPolicyRef})
      const compare=outputs=>compareProspectiveTaskConfiguration(runtime,{scopeKind:'TASK',outputs,entries:[],skillConfiguration:[],privateTools:null,toolPolicyRef:command.toolPolicyRef},true)
      const sampled=compare(comparisonOutputs),alternate=compare({...comparisonOutputs,dataSchema:comparisonOutputs.dataSchema?null:{type:'object'}})
      assert.ok(group && sampled && alternate,'expected resolved prospective comparison');assert.match(sampled.profileSha256,/^[0-9a-f]{64}$/);assert.equal(sampled.executionConfigSha256,group.executionConfigSha256)
      assert.notEqual(alternate.toolConfigSha256,sampled.toolConfigSha256);assert.equal(alternate.profileSha256,sampled.profileSha256)
      let selectedReply=null
      if(probe){
        const {channelFixture}=await import('../../cyf-agent-runtime-v1/test/channel-fixture.mjs')
        const peer=await channelFixture(t,{firstIdentity:{tenantId:'0',clientId:'billing-client',canonicalAgentId:'agt_00000000000000000000000000000002',installationId:'inst'},hostId:'host',instanceId:'boot',previousGeneration:0,comparePrepared:compare})
        await peer.executors[0].activate();const socket=peer.sockets[0];socket.emit('message',wire)
        selectedReply=JSON.parse(socket.measuredWire);assert.equal(selectedReply.correlationId,probe.messageId);assert.equal(selectedReply.requestId,probe.requestId)
        assert.equal(selectedReply.data.intentSha256,probe.data.intentSha256);assert.deepEqual(peer.states()[0].preparedReads,[command.outputs]);assert.deepEqual(peer.states()[0].accepted,[])
        assert.equal(selectedReply.data.configurationEpoch.profileSha256,sampled.profileSha256)
      }
      const effort=runtime.profile.chatReasoningEffort;try {runtime.profile.chatReasoningEffort='high';assert.notEqual(compare(comparisonOutputs).profileSha256,sampled.profileSha256)}finally{runtime.profile.chatReasoningEffort=effort}
      assert.ok(group);assert.equal(calls.length,0);await assert.rejects(actualRead('plan'),{code:'ENOENT'})
      const channel=skillDigest(['METERED_PROVIDER_NAMESPACE_V1','fixture',`https://127.0.0.1:${upstream.address().port}/custom`])
      const admission=skillDigest(['NATIVE_LOCAL_ARTIFACT_TEXT_V1','codex-cli-0.167.0','RESPONSES_TEXT_TOKENS_V1',group.executionConfigSha256,group.routeSha256,group.toolConfigSha256,channel])
      if(admitted==='empty'){
        const request={command,inputs:[],entries:[],store:actual,checkActive(){},profileRuntime:runtime,model:'gpt-5.4',effort:'medium'}
        const write=actual.write.bind(actual);actual.write=(key,value)=>{write(key,value);if(key==='native-thread')throw Error('fixture stopped immediately after thread checkpoint')}
        await assert.rejects(runNativeExecution(request),/fixture stopped immediately/);actual.write=write
        const original=actual.read('native-thread');assert.ok(original.threadId);assert.equal(actual.read('native-start-attempt'),null);assert.equal((await actualRead('producer-stopped')).reservedHigh,'0');assert.equal(calls.length,0)
        const readRoot=actualRead;actualRead=key=>readRoot('epoch-1/'+key)
        for(let i=0;i<2;i++)await assert.rejects(runNativeExecution(request),e=>e.code==='SKILL_RESULT_UNKNOWN' && e.cause?.code===-32600 && e.cause.message===`no rollout found for thread id ${original.threadId}`)
        assert.deepEqual(actual.read('native-thread'),original);assert.equal(actual.read('native-start-attempt'),null);assert.equal(actual.read('native-turn'),null);assert.equal(calls.length,0)
        await assert.rejects(readRoot('epoch-1/source-1'),{code:'ENOENT'});return
      }
      const result=await runNativeExecution({command,inputs:[],entries:[],store:actual,checkActive(){},profileRuntime:runtime,model:'gpt-5.4',effort:'medium'})
      if(admitted==='file'){
        assert.equal(result.result.data,null);assert.equal(result.result.artifacts.length,1)
        const [file]=result.result.artifacts;assert.equal(file.contentMimeType,'text/plain');assert.equal(file.displayName,'result.txt');assert.equal(actual.readBlob(file.outputId,file).toString(),'file-fixture')
        assert.equal(calls.length,4);assert.ok(calls.every(c=>c.pending==='PENDING'))
        for(const seq of [1,2,3,4]){
          const linked=await actualRead(`request-${seq}-2`);const o=(await actualRead(`response-${linked.observation.sourceAttemptId}-1`)).observation
          assert.equal(o.reportedUsage.input_tokens,10);assert.equal(o.actualBillingIdentity,null)
          if(seq===1)assert.deepEqual(o.measuredQuantities.tokens,{INPUT:'7',CACHED_INPUT:'3',OUTPUT:'2'})
          else {assert.equal(o.measuredQuantities,null);assert.ok(o.reasonCodes.some(x=>x==='REQUEST_TOOL_HISTORY_UNBOUND'||x==='REQUEST_COST_SCOPE_UNKNOWN'),JSON.stringify(o.reasonCodes))}
        }
        await recoverStoppedMeteredRoot(actual,()=>assert.equal(runtime.activeAdapters.size,0));assert.deepEqual((await actualRead('plan')).observation.dispatchGroup,group)
        const close=(await actualRead('capture-final-1')).observation;assert.equal(close.closeState,'SEALED_INCOMPLETE');assert.ok(close.reasonCodes.includes('USAGE_INCOMPLETE'));return
      }
      if(admitted==='answer'){
        assert.deepEqual(result.result.data,{answer:'fixture answer'});assert.deepEqual(result.result.artifacts,[])
        const measured=(await actualRead('plan')).observation.dispatchGroup
        for(const key of ['version','executionConfigSha256','routeSha256','toolConfigSha256'])assert.equal(measured[key],selectedReply.data.measurement[key],key)
      }
      assert.equal(result.executionId,'exec1');assert.equal(actual.read('native-selection').revision,'1');assert.equal(calls.length,2)
      assert.deepEqual(calls.map(x=>x.pending),['PENDING','PENDING']);assert.deepEqual(calls[1].history,[['function_call','call_local_1'],['function_call_output','call_local_1']])
      for(const seq of [1,2]){const linked=await actualRead(`request-${seq}-2`),o=(await actualRead(`response-${linked.observation.sourceAttemptId}-1`)).observation
        assert.deepEqual(o.reasonCodes,['BILLING_IDENTITY_UNKNOWN']);assert.equal(o.actualBillingIdentity,null);assert.deepEqual(o.measuredQuantities.tokens,{INPUT:'7',CACHED_INPUT:'3',OUTPUT:'2'})}
      await recoverStoppedMeteredRoot(actual,()=>assert.equal(runtime.activeAdapters.size,0));assert.equal((await actualRead('plan')).observation.coveragePolicyVersion,'NATIVE_LOCAL_ARTIFACT_TEXT_V1');assert.equal((await actualRead('source-final-1')).observation.requestCount,'2');assert.equal((await actualRead('capture-final-1')).observation.closeState,'DRAINED')
      assert.deepEqual((await actualRead('plan')).observation.dispatchGroup,group);assert.equal((await actualRead('source-0')).observation.channelNamespace,channel)
      if(selectedReply && process.env.CYF_TEST_EXPORT_NATIVE_CAPTURE==='1'){
        const plan=(await actualRead('plan')).observation
        await writeFile(join(tmpdir(),'selected-answer-peer.json'),JSON.stringify({reply:selectedReply,dispatchGroup:plan.dispatchGroup,coverage:plan.coveragePolicyVersion}),{mode:0o600,flag:'wx'})
      }
      if(admitted==='artifact'&&process.env.CYF_TEST_EXPORT_NATIVE_CAPTURE==='1'){
        const keys=['plan','source-0','source-final-1','capture-final-1'];for(const seq of [1,2])keys.push(`request-${seq}-1`,`request-${seq}-2`,`response-${(await actualRead(`request-${seq}-2`)).observation.sourceAttemptId}-1`)
        // Only transport records from this synthetic test; no headers, HOME, messages, tool arguments or result files.
        const records=Object.fromEntries(await Promise.all(keys.map(async key=>[key,await actualRead(key)])))
        await writeFile(join(tmpdir(),'local-artifact-test-evidence.json'),JSON.stringify({admission,records}),{mode:0o600,flag:'wx'})
      }
      return
    }
    const openAdapter=(restore=false)=>runtime.openNativeExecutionAdapter(join(store.directory,'inputs'),binding.requestKey,binding,{requireExistingState:restore,scratchDirectory:join(store.directory,'scratch'),draftsDirectory:join(store.directory,'drafts'),nativeExecution:{executionId:'exec1',tools:[],checkActive(){},callTool(){}},...(admitted?{meteredAdmission:{store,model:'gpt-5.4',effort:'medium',instructionsSha256:skillDigest('fixture launch policy')}}:{meteredCapture:capture})})
    const adapter=await openAdapter();assert.ok(inspected);assert.ok(adapter.readback.credentialIsolation.bootstrapCredentialRemoved);assert.ok(adapter.nativeExecutionIsolation.network.nftDefaultDropReadback)
    const policy={cwd:'/execution',model:'gpt-5.4',effort:'medium',developerInstructions:'fixture launch policy'},thread=await adapter.startOrResumeThread(null,policy)
    const completed=await adapter.runTurn({threadId:thread.threadId,clientUserMessageId:'fixture-message',policy,input:[{type:'text',text:'fixture'}]})
    assert.deepEqual(calls,[{path:'/custom/responses',auth:'Bearer upstream-fixture-only',pending:'PENDING'}])
    if(admitted){
      await runtime.suspendAdapter(binding.requestKey)
      const measured=(await read('plan')).observation;assert.equal(measured.engineVersion,'codex-cli-0.167.0');assert.equal(measured.dispatchGroup.version,'NATIVE_DISPATCH_GROUP_V1');assert.match(measured.dispatchGroup.toolConfigSha256,/^[a-f0-9]{64}$/);assert.equal(measured.coveragePolicyVersion,'NATIVE_EXECUTION_UNVERIFIED_V1')
      assert.equal((await read('producer-stopped')).reservedHigh,'1')
      store.write('native-thread',{threadId:thread.threadId});store.write('native-start-attempt',{threadId:thread.threadId,clientUserMessageId:store.command.messageId})
      const again=await openAdapter(true);const state=await again.reconcileTurn({threadId:thread.threadId,turnId:completed.turnId,clientUserMessageId:store.command.messageId})
      assert.equal(state.status,'TERMINAL');assert.equal(state.turnId,completed.turnId);assert.equal(state.terminalStatus,'completed')
      const active=runtime.activeAdapters.get(binding.requestKey);await assert.rejects(active.slot.meteredCapture.dispatch(()=>assert.fail('reconciliation sent a request')),{code:'METERED_CAPTURE_ADMISSION_CLOSED'})
      await runtime.suspendAdapter(binding.requestKey);assert.equal(calls.length,1)
      assert.equal((await read('epoch-1/source-1')).observation.previousEpochSourceRecordId,(await read('source-0')).recordId);assert.equal((await read('epoch-1/producer-stopped')).reservedHigh,'0')
      await assert.rejects(read('capture-final-1'),{code:'ENOENT'})
    } else await capture.stopAndDrain()
    const linked=await read('request-1-2'), response=await read(`response-${linked.observation.sourceAttemptId}-1`)
    assert.equal(linked.previousEvidenceSha256,(await read('request-1-1')).evidenceSha256);assert.equal(linked.observation.resolution,'RESPONSE')
    assert.equal(response.expectedRevision,'0');assert.equal(response.observation.actualBillingIdentity,null)
    if(admitted){assert.equal(response.observation.measuredQuantities,null);assert.equal(response.observation.reportedUsage.input_tokens,10)}
    else assert.deepEqual(response.observation.measuredQuantities?.tokens,{INPUT:'7',CACHED_INPUT:'3',OUTPUT:'2'},JSON.stringify(response.observation.reasonCodes))
    await runtime.releaseAdapter(binding.requestKey,{requestBinding:binding})
    if(admitted) await recoverStoppedMeteredRoot(store,()=>{assert.equal(runtime.activeAdapters.size,0)})
    const expected=admitted?'SEALED_INCOMPLETE':'DRAINED'
    const sourceFinal=await read('source-final-1'),captureFinal=await read('capture-final-1')
    assert.equal(sourceFinal.observation.closeState,expected);assert.equal(sourceFinal.observation.requestCount,'1')
    const tuple=r=>[r.recordId,r.sourceRevision,r.evidenceSha256]
    assert.equal(sourceFinal.observation.recordsSha256,skillDigest([await read('source-0'),linked,response].map(tuple).sort(([a],[b])=>a<b?-1:1)))
    assert.equal(captureFinal.observation.sourcesSha256,skillDigest((admitted?[tuple(sourceFinal),tuple(await read('epoch-1/source-final-1'))]:[tuple(sourceFinal)]).sort(([a],[b])=>a<b?-1:1)));assert.equal((await read('usage-capture-finalized')).closeState,expected)
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
  const wire={...command,snapshotSha256:command.snapshotDigest};delete wire.snapshotDigest
  const {skillCommandFromWire}=await import('../skill-conversation.mjs')
  assert.deepEqual(skillCommandFromWire(wire),command);assert.throws(()=>skillCommandFromWire({...wire,captureProtocol:'other'}),/SKILL_COMMAND_INVALID/)
  const lane=new SkillUsageDelivery(config);assert.deepEqual(lane.pendingCommands(),[])
  const missing=await lane.flush();assert.equal(missing.confirmed,false);assert.equal(missing.pending,1);assert.ok(missing.errors.length)
  const foreign=new SkillUsageDelivery({...config,scope:{...scope,tenantId:'other'}});assert.equal((await foreign.flush()).pending,0)
  await startMeteredRoot(store,{executionId:'exec1',runId:'run1',executionConfigSha256:'c'.repeat(64),engineVersion:'fixture',coveragePolicyVersion:'fixture',rootSourceId:'root',channelNamespace:'fixture',adapterVersion:'fixture',checkActive(){}})
  const calls=[],prior=new Map();let corrupt=true
  const fake=async(path,method,raw,status,call)=>{
    assert.equal(path,'/internal/agent/executions/exec1/runs/run1/usage');assert.equal(method,'POST');assert.equal(call.callId,raw.receiptId);assert.equal(call.requestId,raw.receiptId)
    calls.push(raw.kind);const a={...Object.fromEntries(['schemaVersion','executionId','runId','captureId','recordId','receiptId','sourceRevision','evidenceSha256'].map(k=>[k,raw[k]])),acceptance:'DURABLE',acceptedAt:123,ledger:null}
    if(prior.has(raw.kind))assert.deepEqual(prior.get(raw.kind),a);prior.set(raw.kind,a)
    if(raw.kind==='SOURCE'&&corrupt)return {...a,recordId:'0'.repeat(64)};return a
  }
  lane.request=fake;lane.pendingCommands();const errors=await lane.deliverPendingUsage();assert.equal(errors.length,1);assert.deepEqual(calls,['PLAN','SOURCE'])
  // Restart: read persisted PLAN ACK; replay only missing/uncertain source. No legacy evidence or new engine.
  corrupt=false;const stopped=new SkillUsageDelivery(config);stopped.request=fake
  const report=await stopped.flush();assert.deepEqual(report,{confirmed:true,captureStates:[{executionId:'exec1',captureState:'FINALIZED',closeState:'SEALED_INCOMPLETE',deliveryState:'ACKED'}],pending:0,errors:[]})
  assert.deepEqual(calls,['PLAN','SOURCE','SOURCE','SOURCE_FINAL','CAPTURE_FINAL']);assert.deepEqual(await stopped.flush(),report);assert.equal(calls.length,5)

})
test('stopped seal waits for in-flight response persistence and closes admission first',async t=>{
  const {capture,dir,read}=await openRoot(t),entered=Promise.withResolvers(),resume=Promise.withResolvers()
  const work=capture.dispatch(async(_request,finish)=>{entered.resolve();await resume.promise;await finish(observeResponse('application/json',503,512,false).finish(false))})
  await entered.promise;capture.stopAdmission();const seal=capture.sealStopped(()=>{})
  try { await assert.rejects(capture.dispatch(()=>assert.fail()),{code:'METERED_CAPTURE_ADMISSION_CLOSED'});assert.ok(!(await readdir(dir)).includes('producer-stopped.json')) } finally {resume.resolve()}
  await work;await seal;assert.equal((await read('request-1-2')).observation.resolution,'UNRESOLVED');assert.equal((await read('source-final-1')).observation.closeState,'SEALED_INCOMPLETE')
})

test('native HTTP posts exact revisions and recovers the original lost RESPONSE ACK, not just the final manifest',async t=>{
  const {exercisePeer}=await import('./fixtures/metered-java-peer.mjs')
  const {createServer}=await import('node:http')
  const log=[],stored=new Map();let dropped=false,serverError
  const server=createServer(async(req,res)=>{try{
    const id=req.headers['x-request-id'];assert.equal(req.headers.authorization,`AgentRuntime rts1_${'a'.repeat(64)}`)
    let a
    if(req.method==='GET'){
      assert.equal(req.headers['idempotency-key'],undefined);assert.equal(req.url,`/internal/agent/executions/exec1/runs/run1/usage/receipts/${id}`);a=stored.get(id);assert.ok(a);log.push('GET')
    }else{
      let text='';for await(const chunk of req)text+=chunk;const envelope=JSON.parse(text),e=envelope.data
      assert.equal(req.method,'POST');assert.equal(req.url,'/internal/agent/executions/exec1/runs/run1/usage');assert.equal(envelope.protocolVersion,1);assert.equal(envelope.requestId,id);assert.equal(e.receiptId,id);assert.equal(req.headers['idempotency-key'],id)
      log.push(e.kind+':'+e.sourceRevision);a={...Object.fromEntries(['schemaVersion','executionId','runId','captureId','receiptId','recordId','sourceRevision','evidenceSha256'].map(k=>[k,e[k]])),acceptedAt:123,acceptance:'DURABLE',ledger:e.kind==='RESPONSE'?{attemptId:skillDigest(['NATIVE_RESPONSE_USAGE',e.observation.sourceAttemptId]),revision:'1',status:'PENDING_USAGE',costYuan:null}:null}
      if(stored.has(id))assert.deepEqual(stored.get(id),a);stored.set(id,a)
      if(e.kind==='RESPONSE'&&!dropped){dropped=true;req.socket.destroy();return}
    }
    res.writeHead(200,{'Content-Type':'application/json','X-Request-Id':id});res.end(JSON.stringify({protocolVersion:1,requestId:id,code:'E0',msg:'',data:a}))
  }catch(error){serverError=error;res.destroy()}})
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()})
  const result=await exercisePeer({snapshotDigest:'a'.repeat(64),port:server.address().port,executionId:'exec1',runId:'run1',session:{sessionToken:'rts1_'+'a'.repeat(64),canonicalAgentId:'agent',installationId:'i',hostId:'h',runtimeInstanceId:'rt',sessionGeneration:'1'}})
  assert.ifError(serverError);assert.equal(result.ackCount,7);assert.equal(stored.size,7)
  assert.deepEqual(log,['PLAN:1','SOURCE:1','REQUEST:1','REQUEST:2','RESPONSE:1','GET','SOURCE_FINAL:1','CAPTURE_FINAL:1','RESPONSE:1'])
})

test('dispatch group commits to launch configuration, not an individual command or local paths',async t=>{
  const {nativeDispatchGroup}=await import('../native-execution-runtime.mjs')
  const binding={executionId:'one',input:{inode:1},sandboxUser:{uid:65534},neutralMountTargets:[],tools:[],
    skills:[{skillKey:'x',packageRoot:'/private',packageTreeDigest:'tree'}],skillConfiguration:[],networkAccess:false,networkOrigins:[],
    toolchain:{shell:'/bin/sh',files:[{sourcePath:'/private/bin',sandboxPath:'/bin/sh',sha256:'binary'}]}}
  const settings={binarySha256:'cli',engineVersion:'1',channelNamespace:'route',model:'model',effort:'medium',instructionsSha256:'instructions',toolPolicyRef:'local',coveragePolicyVersion:'unverified'}
  const group=nativeDispatchGroup(binding,settings);const moved=structuredClone(binding);moved.executionId='two';moved.input.inode=42;moved.skills[0].packageRoot='/elsewhere';moved.toolchain.files[0].sourcePath='/relocated';assert.deepEqual(nativeDispatchGroup(moved,settings),group)
  assert.equal(nativeDispatchGroup(binding,{...settings,model:null}),null);assert.equal(nativeDispatchGroup(binding,{...settings,effort:null}),null)
  for(const key of Object.keys(settings))assert.notEqual(nativeDispatchGroup(binding,{...settings,[key]:'different'}).executionConfigSha256,group.executionConfigSha256)
  moved.toolchain.files[0].sha256='changed';assert.notEqual(nativeDispatchGroup(moved,settings).toolConfigSha256,group.toolConfigSha256)
  const {read}=await openRoot(t,{dispatchGroup:group});const plan=(await read('plan')).observation
  assert.deepEqual(plan.dispatchGroup,group);assert.equal(plan.executionConfigSha256,'c'.repeat(64));assert.equal(JSON.stringify(plan).includes('/private'),false)
})

test('ambiguous JSON or SSE members never produce usage even when the last value looks valid',()=>{
  const valid='{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":4,"total_tokens":9,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":1}}}'
  for(const type of ['application/json','text/event-stream']) {
    const read=raw=>{const obs=observeResponse(type,200,4096,true);const wire=type==='application/json'?raw:`data: {"type":"response.completed","response":${raw}}\n\n`;for(const b of Buffer.from(wire))obs.push(Buffer.from([b]));return obs.finish(true)}
    for(const raw of [valid.replace('"id":','"id":"other","id":'),valid.replace('"input_tokens":','"input_\\u0074okens":0,"input_tokens":'),valid.replace('"cached_tokens":','"cached_tokens":0,"cached_tokens":')]) {
      const result=read(raw);assert.equal(result.measuredQuantities,null);assert.equal(result.reportedUsage,null);assert.ok(result.reasonCodes.includes('RESPONSE_STREAM_INVALID'))
    }
    const control=read(valid.replace('"id":','"irrelevant":[{"id":"{}\\\"id\\\":"},{"id":"ok"}],"id":'));assert.equal(control.measuredQuantities.tokens.INPUT,'3')
  }
})

test('large JSON and multiline SSE discard output values and still validate syntax beyond the observation window',()=>{
  const body='密'.repeat(512*1024)+'\\"id\\":\\"spoof', usage={input_tokens:5,output_tokens:4,total_tokens:9,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:1}}
  const response=JSON.stringify({output:[{content:[{text:body}]}],id:'r1',status:'completed',usage})
  for(const sse of [false,true])for(const corrupt of [false,true]){
    const raw=corrupt?response.replace('spoof','\\x'):response
    const wire=Buffer.from(sse?`event: message\r\ndata: {"type":"response.completed",\r\ndata: "response":${raw}}\r\n\r\ndata: [DONE]\n\n`:raw)
    const obs=observeResponse(sse?'text/event-stream':'application/json',200,512,true)
    for(let i=0;i<wire.length;i+=997)obs.push(wire.subarray(i,i+997))
    const result=obs.finish(true);if(corrupt){assert.equal(result.measuredQuantities,null);assert.ok(result.reasonCodes.includes('RESPONSE_STREAM_INVALID'))}
    else {assert.equal(result.providerResponseId,'r1');assert.equal(result.measuredQuantities.tokens.INPUT,'3')}
    assert.ok(!JSON.stringify(result).includes('密'))
  }
})

import { requestCostScope } from '../metered-request-scope.mjs'
test('actual upload classifies tool and input structures without interpreting prompt text as control',()=>{
  const body={model:'fixture',input:[{role:'user',content:[{type:'input_text',text:'密'.repeat(70000)+'{"type":"input_image"}'}]}],tools:[{type:'function',parameters:{properties:{type:{enum:['web_search']}}}}]}
  function read(b){const bytes=Buffer.from(typeof b==='string'?b:JSON.stringify(b)),obs=requestCostScope(256);for(let i=0;i<bytes.length;i+=127)obs.push(bytes.subarray(i,i+127));return obs.finish(true)}
  assert.deepEqual(read(body),[]);assert.deepEqual(read({...body,tools:[{type:'web_search'}]}),['REQUEST_PROVIDER_TOOL_OR_UNKNOWN']);assert.ok(read({...body,input:[{role:'user',content:[{type:'input_image',image_url:'private'}]}]}).includes('REQUEST_NON_TEXT_INPUT'))
  const ns=tools=>({...body,tools:[{tools,type:'namespace',name:'local'}]});assert.deepEqual(read(ns([{type:'function'}])),[])
  assert.ok(read(ns([{type:'namespace',tools:[{type:'web_search'}]}])).includes('REQUEST_PROVIDER_TOOL_OR_UNKNOWN'))
  for(const b of [{...body,tools:[{type:'namespace'}]},{...body,tools:[{tools:[],type:'function'}]},{...body,tools:[{}]},{...body,previous_response_id:'indirect'},{model:'fixture'},'{"input":"x","model":"x","tools":[],"tools":[]}'])assert.ok(read(b).includes('REQUEST_COST_SCOPE_UNKNOWN'))
})

test('local tool history requires this execution’s successful call; a matching id cannot hide media',()=>{
  const check=(item,lookup)=>{const obs=requestCostScope(512,lookup);obs.push(Buffer.from(JSON.stringify({model:'fixture',input:[item]})));return obs.finish(true)}
  const lookup=id=>id==='x'?'result_propose':undefined, call={type:'function_call',name:'result_propose',arguments:'{}',call_id:'x'},out={type:'function_call_output',call_id:'x',output:'text'}
  assert.deepEqual(check(call,lookup),[]);assert.deepEqual(check(out,lookup),[])
  for(const [x,f] of [[call,null],[out,null],[{...call,name:'private'},lookup],[{...out,call_id:'foreign'},lookup]])assert.ok(check(x,f).includes('REQUEST_TOOL_HISTORY_UNBOUND'))
  assert.ok(check({...out,output:[{type:'input_image',image_url:'private'}]},lookup).includes('REQUEST_NON_TEXT_INPUT'))
})

// Reader fixture: no permission to resume the engine is implied by the presence of a SOURCE.
test('stopped recovery links two epochs, retains unresolved prior requests and acknowledges both sources separately',async t=>{
  const {capture,dir,read,store}=await openRoot(t,{engineVersion:'codex-cli-0.167.0',coveragePolicyVersion:'TEXT_MODEL_ONLY_V1',adapterVersion:'RESPONSES_TEXT_TOKENS_V1'})
  await capture.dispatch(async()=>{});await capture.markStopped(()=>{})
  const {first,persist}=await import('../metered-capture-files.mjs');const {deliverMetered}=await import('../metered-usage-delivery.mjs')
  const source=await read('source-0'),{executionId,runId,captureId}=source,binding={executionId,runId,captureId},child=join(dir,'epoch-1');await mkdir(child,{mode:0o700})
  const obs={...source.observation,epoch:'1',previousEpochSourceRecordId:'f'.repeat(64)}
  const build=()=>first(binding,'SOURCE',[obs.sourceId,'1'],obs,()=>1)
  await persist(child,'source-1',build());await assert.rejects(recoverStoppedMeteredRoot(store,()=>{}),{code:'METERED_CAPTURE_SOURCE_CONFLICT'})
  await assert.rejects(read('capture-final-1'),{code:'ENOENT'});obs.previousEpochSourceRecordId=source.recordId
  await persist(child,'source-1',build());await persist(child,'producer-stopped',{...binding,epoch:'1',reservedHigh:'0',writeFailed:false})
  const marker=await recoverStoppedMeteredRoot(store,()=>{});const final=await read('capture-final-1');assert.equal(marker.closeState,'SEALED_INCOMPLETE');assert.equal(marker.sourceFinals.length,2)
  assert.equal(final.observation.sourceCount,'2');assert.ok(final.observation.reasonCodes.includes('UNRESOLVED_REQUEST'));assert.equal(final.observation.sourcesSha256,skillDigest([...marker.sourceFinals].sort(([a],[b])=>a<b?-1:1)))
  assert.deepEqual(await recoverStoppedMeteredRoot(store,()=>{}),marker)
  const seen=new Set();const post=async(path,method,r)=>{assert.equal(method,'POST');assert.ok(!seen.has(r.receiptId));seen.add(r.receiptId);return Object.fromEntries([...['schemaVersion','executionId','runId','captureId','receiptId','recordId','sourceRevision','evidenceSha256'].map(k=>[k,r[k]]),['acceptedAt',5],['acceptance','DURABLE'],['ledger',null]])}
  const send=()=>deliverMetered(store,post,{left:2,until:Date.now()+5000},true);assert.equal(await send(),false);assert.equal(await send(),false);assert.equal(await send(),false);assert.equal(await send(),true);assert.equal(seen.size,7);assert.equal(await send(),true)
})

test('only a stopped matching capture before any first turn can admit a new provider call in its successor',async t=>{
  const {resumeStoppedMeteredRoot:resume}=await import('../metered-request-capture.mjs');const {store,args,capture,dir,read}=await openRoot(t)
  const open=(a=args)=>resume(store,a,'BEFORE_FIRST_TURN');await assert.rejects(open(),{code:'SKILL_RESULT_UNKNOWN'})
  await capture.markStopped(()=>{});await assert.rejects(open({...args,channelNamespace:'different'}),{code:'SKILL_RESULT_UNKNOWN'})
  await assert.rejects(open({...args,executionConfigSha256:'0'.repeat(64)}),{code:'SKILL_RESULT_UNKNOWN'});assert.ok(!(await readdir(dir)).includes('epoch-1'))
  const next=await open();const old=await read('source-0');assert.equal((await read('epoch-1/source-1')).observation.previousEpochSourceRecordId,old.recordId)
  await next.dispatch(async request=>{assert.equal(request.epoch,'1');assert.equal(request.sequence,'1');assert.equal((await read('epoch-1/request-1-1')).observation.resolution,'PENDING')})
  await next.markStopped(()=>{});await assert.rejects(open(),{code:'SKILL_RESULT_UNKNOWN'});const marker=await recoverStoppedMeteredRoot(store,()=>{})
  assert.equal(marker.closeState,'SEALED_INCOMPLETE');await assert.rejects(resume(store,args,'RECONCILE_ONLY'),{code:'SKILL_RESULT_UNKNOWN'});assert.ok(!(await readdir(dir)).includes('epoch-2'))
})

test('deferred successor blocks bootstrap egress and persists the source before permitting any dispatch',async t=>{
  const {resumeStoppedMeteredRoot:resume}=await import('../metered-request-capture.mjs');const {store,args,capture,dir,read}=await openRoot(t);await capture.markStopped(()=>{})
  const options={...args,deferUntilThread:true},open=()=>resume(store,options,'BEFORE_FIRST_TURN');const first=await open();await first.markStopped(()=>{});await assert.rejects(first.enableAfterThreadResume(),{code:'METERED_CAPTURE_ADMISSION_CLOSED'});assert.ok(!(await readdir(dir)).includes('epoch-1'))
  const next=await open();await assert.rejects(next.dispatch(()=>assert.fail()),{code:'METERED_CAPTURE_ADMISSION_CLOSED'});await Promise.all([next.enableAfterThreadResume(),next.enableAfterThreadResume()]);await next.dispatch(async r=>{assert.equal(r.epoch,'1');assert.equal((await read('epoch-1/source-1')).observation.epoch,'1');assert.equal((await read('epoch-1/request-1-1')).observation.resolution,'PENDING')});await next.markStopped(()=>{})
})

// Source-only adapter seam: API enrollment is an explicit fixture, never inferred from historical records.
for (const origin of ['configured','managed']) test(`durable discussion source keeps original turn/dispatch/context across restart without a workspace command (${origin})`, async t => {
  const {PersistentChatInbox, canonicalSha256, validateChatDispatch} = await import('../chat-runtime.mjs')
  const {startDiscussionCapture,recoverStoppedDiscussionCapture} = await import('../metered-request-capture.mjs')
  const wire = JSON.parse(await readFile(new URL('../contracts/api-hosted-wire-v1.json', import.meta.url),'utf8'))
  const {fixture}=await import('../../cyf-agent-runtime-v1/test/channel-fixture.mjs')
  const f=await fixture(t,{count:2,firstIdentity:{tenantId:wire.tenantId,clientId:wire.clientId,canonicalAgentId:wire.targetAgentId}})
  const config=await f.config();let agent=config.agents[0],inspectionHost=config.hostId;
  if (origin==='managed') {
    // Real HostingControl journal + materialization. From the first capture, put the
    // original dispatch and all seven receipt revisions in that subject's own inbox.
    const {hostingFixture,quotedPreparation,candidateRequest}=await import('../../cyf-agent-runtime-v1/test/hosting-fixture.mjs');
    const {runtimeSubjectKey}=await import('../../cyf-agent-runtime-v1/lib/manifest.mjs');
    const {tenantId,clientId,ownerJiacn,targetAgentId:canonicalAgentId}=wire;
    const h=await hostingFixture(t,{scope:{tenantId,clientId,ownerJiacn}});
    const catalog=JSON.parse(await readFile(new URL('../../cyf-agent-runtime-v1/test/fixtures/gss-hosting-control-v1.json',import.meta.url)));
    const prep=quotedPreparation({...catalog.prepareRequest,tenantId,clientId,ownerJiacn,canonicalAgentId});
    const candidate=await h.control().handle(prep);await h.control().handle(candidateRequest(prep,candidate,'ensure'));await h.settle();
    agent=h.host().agents.get(runtimeSubjectKey(candidate.manifest)).agent;inspectionHost=h.hostConfig.hostId;
    const hostingControlPath=join(f.root,'managed-hosting.json'), hostSettings=structuredClone(h.controlConfig);
    hostSettings.template.profile.codexBin=await (await import('node:fs/promises')).realpath(hostSettings.template.profile.codexBin);
    await f.json(hostingControlPath,hostSettings);
    await f.json(f.path,{...f.raw,hostId:h.hostConfig.hostId,agents:[f.entries[1]],hostingControlPath});
    assert.equal(h.sessionCount(),1);
  }
  const rootDir=join(agent.stateRoot,'inbox')
  const {spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url')
  const cli=fileURLToPath(new URL('../../cyf-agent-runtime-v1/agent-runtime.mjs',import.meta.url))
  const report=(subject=agent.subjectKey,extra=[])=>spawnSync(process.execPath,[cli,'inspect-discussion-receipts','--config',f.path,'--subject',subject,...extra],
    {encoding:'utf8',env:{...process.env,CYF_RUNTIME_PROVIDER_ENVIRONMENTS_FILE:join(rootDir,'never-read')}})
  const counts=(expected,status)=>{const r=report();assert.equal(r.status,status,r.stderr);assert.deepEqual(JSON.parse(r.stdout),expected)}
  const absent=report(config.agents[1].subjectKey);assert.notEqual(absent.status,0);assert.equal(absent.stdout,'');assert.deepEqual(await readdir(config.agents[1].stateRoot),[])
  const profile = {agentId:wire.targetAgentId}, inbox = new PersistentChatInbox({rootDir,profile}); inbox.initialize()
  counts({sources:0,acknowledged:0,pending:0,unverified:0},2)
  const admit = async (enrolled, suffix = enrolled ? '-new' : '-old') => {
    const m=structuredClone(wire);m.route='CHAT';m.dispatchId += suffix;m.dedupeKey += suffix
    m.factsManifest.participantAgentIds=[m.targetAgentId]
    if(enrolled)m.factsManifest.taskUsageCapture={protocol:'METERED_CAPTURE_V2',captureId:skillDigest(['CAPTURE_V2',m.turnId,m.dispatchId])}
    m.contextSnapshot.facts=m.factsManifest;m.contextHash=m.contextSnapshot.contextHash=canonicalSha256({sourceVector:m.sourceVector,facts:m.factsManifest})
    const {key}=await inbox.accept(validateChatDispatch(m));inbox.claim(key);return {key,m}
  }
  const opts={executionConfigSha256:'a'.repeat(64),engineVersion:'fixture',adapterVersion:'FIXTURE',rootSourceId:'discussion',channelNamespace:'local',checkActive(){}}
  const old=await admit(false);await assert.rejects(startDiscussionCapture(inbox,old.key,opts),/CHAT_CAPTURE_BINDING_INVALID/)
  const {key,m}=await admit(true), cap=await startDiscussionCapture(inbox,key,opts);let sent=0
  const {parent}=inbox.discussionCaptureSubject(key,false), dir=join(parent,'usage-capture-'+cap.captureId)
  const {buildContextEnvelope}=await import('../chat-runtime.mjs')
  assert.equal(Object.hasOwn(buildContextEnvelope(m).authoritative.facts,'taskUsageCapture'),false)
  const {runFastChat}=await import('../agent-client.mjs')
  for(const flags of [{durable:true},{legacy:true}]) await assert.rejects(runFastChat(profile,{...m,...flags},{fallback:()=>assert.fail('unmetered fallback')}),{code:'CHAT_METERED_ROUTE_UNAVAILABLE'})
  const cert=join(rootDir,'cert'), privateKey=join(rootDir,'key')
  execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',privateKey,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'})
  const ca=await readFile(cert),upstream=createHttpsServer({key:await readFile(privateKey),cert:ca},async(req,res)=>{
    sent++; req.resume(); const pending=JSON.parse(await readFile(join(dir,`request-${sent}-1.json`)))
    assert.equal(pending.observation.resolution,'PENDING');assert.equal(pending.runId,m.dispatchId)
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'test-discussion',status:'completed',usage:{input_tokens:5,output_tokens:2,total_tokens:7}}))
  });await new Promise(ok=>upstream.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>upstream.close(ok)))
  const eg=new RestrictedProviderEgress({providerBaseUrl:`https://127.0.0.1:${upstream.address().port}/v1`,networkConnectTimeoutMs:2000,
    meteredResponses:{capture:cap,ca,getProviderKey:()=>'test-only-upstream'}});await eg.start();t.after(()=>eg.dispose())
  // Socket, TLS, prewrite and response recording are real; namespace ownership is a fixture.
  eg.attestation={measured:true};eg._assertOwner=async()=>{}
  await new Promise((ok,fail)=>{const req=httpRequest({hostname:'127.0.0.1',port:eg.port,path:'/v1/responses',method:'POST',headers:{host:`10.0.2.2:${eg.port}`,authorization:`Bearer ${eg.meteredRoute.sandboxToken()}`,'content-type':'application/json'}},res=>{
    res.resume();res.on('end',()=>res.statusCode===200?ok():fail(Error(`HTTP ${res.statusCode}`)))
  });req.on('error',fail);req.end(JSON.stringify({model:'fixture',input:'private test input'}))})
  await cap.stopAndDrain() // HTTP body completion is not a durable usage ACK.
  await eg.dispose()
  const request=JSON.parse(await readFile(join(dir,'request-1-2.json')));assert.equal(request.observation.resolution,'RESPONSE')
  const response=JSON.parse(await readFile(join(dir,`response-${request.observation.sourceAttemptId}-1.json`)))
  assert.equal(response.observation.reportedUsage.input_tokens,5);assert.equal(response.observation.reportedUsage.output_tokens,2)
  await assert.rejects(startDiscussionCapture(inbox,key,opts),{code:'EEXIST'});await cap.markStopped(()=>{})
  const restarted=new PersistentChatInbox({rootDir,profile});restarted.initialize();const closed=await recoverStoppedDiscussionCapture(restarted,key,()=>{})
  assert.equal(closed.executionId,m.turnId);assert.equal(closed.runId,m.dispatchId);assert.equal(closed.closeState,'SEALED_INCOMPLETE');assert.equal(sent,1)
  assert.equal(JSON.parse(await readFile(join(dir,'plan.json'))).observation.snapshotSha256,m.contextHash.slice(7))
  assert.deepEqual(await recoverStoppedDiscussionCapture(restarted,key,()=>{}),closed)
  assert.ok(JSON.parse(await readFile(join(dir,'capture-final-1.json'))).observation.reasonCodes.includes('UNSUPPORTED_COST_SOURCE'))
  // Use the existing terminal and retention routines, not manual removal of the business record.
  const expires=new PersistentChatInbox({rootDir,profile,archiveMaxFiles:0,dedupeRetentionMs:0});expires.initialize()
  expires.complete(expires.findByKey(key));assert.equal(expires.findByKey(key).state,'ledger')
  assert.deepEqual(await recoverStoppedDiscussionCapture(expires,key,()=>{}),closed)
  const binding=JSON.parse(await readFile(join(parent,'discussion-binding.json')))
  assert.deepEqual(Object.keys(binding).sort(),['schemaVersion','key','fingerprint','tenantId','ownerJiacn','clientId','requestId','turnId','dispatchId','targetAgentId','contextHash','digest'].sort())
  // Dedupe expiration is strictly older than the GC cutoff; pin only the GC clock for this synchronous pass.
  const {ChatUsageDelivery}=await import('../chat-usage-delivery.mjs'),acks=new Map();let gets=0,posts=0,drop=true
  const scope={agentId:m.targetAgentId,clientId:m.clientId,tenantId:m.tenantId}
  const apiOrigin='https://fixture.invalid',base=`/internal/agent/chat/dispatches/${m.dispatchId}/turns/${m.turnId}/contexts/${m.contextHash.slice(7)}/captures/${cap.captureId}/usage`
  const peer=async(ep,options)=>{
    const id=options.headers['X-Request-Id'];assert.equal(ep.origin,apiOrigin)
    if(options.method==='POST'){
      posts++;assert.equal(ep.pathname,base);const e=JSON.parse(options.body);assert.equal(e.receiptId,id);assert.equal(options.headers['Idempotency-Key'],id);assert.equal(acks.has(id),false)
      acks.set(id,{...Object.fromEntries(['schemaVersion','executionId','runId','captureId','receiptId','recordId','sourceRevision','evidenceSha256'].map(k=>[k,e[k]])),acceptedAt:1,acceptance:'DURABLE',
        ledger:e.kind==='RESPONSE'?{attemptId:skillDigest(['NATIVE_RESPONSE_USAGE',e.observation.sourceAttemptId]),revision:'1',status:'PENDING_USAGE',costYuan:null}:null})
      if(drop){drop=false;throw new TypeError('connection lost after fixture stored receipt')}
    }else{gets++;assert.equal(ep.pathname,base+'/receipts/'+id);assert.equal(options.body,undefined)}
    return {status:200,url:ep.href,headers:new Headers({'X-Request-Id':id}),text:async()=>JSON.stringify({protocolVersion:1,requestId:id,code:'E0',msg:'',data:acks.get(id)})}
  }
  let clock=1000,refusals=0
  const denied=new ChatUsageDelivery({inbox:expires,apiOrigin,scope,now:()=>clock,nativeFetch:async(ep,options)=>{
    refusals++;return {status:404,url:ep.href,headers:new Headers({'X-Request-Id':options.headers['X-Request-Id']})}
  }})
  const {inspectDiscussionReceipts}=await import('../metered-usage-delivery.mjs')
  const inspect=()=>inspectDiscussionReceipts(expires,key,scope)
  const ackRoot=join(parent,'usage-acks-'+cap.captureId)
  counts({sources:1,acknowledged:0,pending:1,unverified:0},2)
  assert.equal(await inspect(),false);await assert.rejects(readFile(ackRoot),{code:'ENOENT'})
  await assert.rejects(inspectDiscussionReceipts(expires,key,{...scope,tenantId:'wrong'}))
  for(const delay of [5000,10000,20000,40000,80000,160000,300000,300000]){
    const before=refusals;assert.equal((await denied.deliver()).length,1);assert.equal(refusals,before+1)
    denied.noteSource(key);assert.equal(denied.nextRecoveryAt(),clock+delay);clock+=delay-1
    assert.deepEqual(await denied.deliver(),[]);assert.equal(refusals,before+1);clock++
  }
  // Local backoff is a scheduling hint only. An explicit audit still tests the exact original scope.
  assert.equal((await denied.flush()).captureStates[0].reason,'ACCESS_UNCONFIRMED')
  const delivery=new ChatUsageDelivery({inbox:expires,apiOrigin,scope,nativeFetch:peer});assert.deepEqual(await delivery.deliver(),[])
  assert.equal(delivery.nextRecoveryAt(),Infinity);assert.equal(posts,7);assert.equal(gets,1);assert.equal(acks.size,7)
  const stopped=new ChatUsageDelivery({inbox:expires,scope,apiOrigin,nativeFetch:()=>assert.fail('local receipts must replay without network')})
  const audit=await stopped.flush();assert.equal(audit.confirmed,true);assert.deepEqual(audit.captureStates,[{key,capture:'SEALED',delivery:'ACKNOWLEDGED',coverage:'INCOMPLETE'}])
  // ACKs cannot be swapped, even if both have valid bindings elsewhere in this sealed pass.
  const fs=await import('node:fs/promises'),ackDir=join(parent,'usage-acks-'+cap.captureId)
  const planAck=join(ackDir,'plan.json'),sourceAck=join(ackDir,'source-0.json'),planBytes=await fs.readFile(planAck)
  counts({sources:1,acknowledged:1,pending:0,unverified:0},0)
  const roster=join(agent.stateRoot,'expected-sources.json'),actual=cap.captureId,absentId='0'.repeat(64)
  const deviceOrigin={tenant_id:wire.tenantId,client_id:wire.clientId,target_agent_id:wire.targetAgentId,
    installation_id:agent.manifest.installationId,host_id:inspectionHost,runtime_instance_id:'original-runtime',session_generation:'1'}
  const entry=(ids,changes={})=>({origin:{...deviceOrigin,...changes},manifest:{subjectKey:agent.subjectKey,captureIds:ids}})
  for(const [ids,status,missing,unexpected] of [[[actual],0,0,0],[[actual,absentId],2,1,0],[[absentId],2,1,1]]){
    await writeFile(roster,JSON.stringify(entry(ids)),{mode:0o600})
    const r=report(agent.subjectKey,['--expected-sources',roster]);assert.equal(r.status,status,r.stderr)
    assert.deepEqual(JSON.parse(r.stdout),{sources:1,acknowledged:1,pending:0,unverified:0,expected:ids.length,missing,unexpected})
  }
  for(const manifest of [entry([actual,actual]),{...entry([actual]),manifest:{subjectKey:'other',captureIds:[actual]}},
    entry([actual],{installation_id:'other-installation'}),entry([actual],{host_id:'other-host'}),entry([actual],{target_agent_id:'other-agent'}),
    entry([actual],{installation_id:undefined}),entry([actual],{host_id:undefined}),entry([actual]).manifest]){
    await writeFile(roster,JSON.stringify(manifest));const r=report(agent.subjectKey,['--expected-sources',roster]);assert.notEqual(r.status,0);assert.equal(r.stdout,'')
  }
  assert.equal(await inspect(),true)
  await fs.unlink(planAck)
  try{
    assert.equal(await inspect(),false);await assert.rejects(fs.stat(planAck),{code:'ENOENT'})
    const sourceBytes=await fs.readFile(sourceAck)
    try{await fs.writeFile(sourceAck,planBytes);await assert.rejects(inspect(),{code:'METERED_USAGE_RECEIPT_CONFLICT'})}
    finally{await fs.writeFile(sourceAck,sourceBytes)}
  }finally{await fs.writeFile(planAck,planBytes,{mode:0o600})}
  try{await fs.writeFile(planAck,await fs.readFile(sourceAck));assert.equal((await stopped.flush()).confirmed,false)}
  finally{await fs.writeFile(planAck,planBytes)}
  const {deliverDiscussionMetered,discussionBatch}=await import('../metered-usage-delivery.mjs')
  const {renameSync}=await import('node:fs'),original=join(dir,'request-1-2.json'),aside=join(parent,'verify-gap')
  try{await assert.rejects(deliverDiscussionMetered(expires,key,scope,()=>assert.fail('no fresh request'),discussionBatch(),()=>renameSync(original,aside)),{code:'METERED_USAGE_RECEIPT_CONFLICT'})}
  finally{renameSync(aside,original)}
  // A prior network ACK is no excuse to invent a missing source seal at handover.
  const {rename}=await import('node:fs/promises');const seal=join(dir,'usage-capture-finalized.json'),saved=join(parent,'saved-seal');await rename(seal,saved)
  try{await assert.rejects(inspect());const broken=await stopped.flush();assert.equal(broken.confirmed,false);assert.equal(broken.captureStates[0].capture,'UNVERIFIED');await assert.rejects(readFile(seal),{code:'ENOENT'})}
  finally{await rename(saved,seal)}
  const wrong=new ChatUsageDelivery({inbox:expires,scope:{...scope,clientId:'other'},apiOrigin,nativeFetch:peer});assert.equal((await wrong.flush()).confirmed,false)
  const extra=await admit(true,'-pruned'), extraCap=await startDiscussionCapture(inbox,extra.key,opts);await extraCap.markStopped(()=>{})
  expires.complete(expires.findByKey(extra.key));assert.equal(expires.findByKey(extra.key).state,'ledger')
  const now=Date.now;try{Date.now=()=>now()+1000;expires.initialize()}finally{Date.now=now}
  assert.equal(expires.findByKey(key),null);assert.deepEqual(await recoverStoppedDiscussionCapture(expires,key,()=>{}),closed)
  assert.equal(expires.findByKey(extra.key),null);const firstClose=await recoverStoppedDiscussionCapture(expires,extra.key,()=>{})
  counts({sources:2,acknowledged:1,pending:1,unverified:0},2)
  assert.equal(firstClose.runId,extra.m.dispatchId);assert.equal(firstClose.closeState,'SEALED_INCOMPLETE')
  await assert.rejects(startDiscussionCapture(expires,key,opts),/CHAT_CAPTURE_STATE_INVALID/)
  await writeFile(join(parent,'discussion-binding.json'),JSON.stringify({...binding,dispatchId:'different'}))
  await assert.rejects(recoverStoppedDiscussionCapture(expires,key,()=>{}),{code:'METERED_CAPTURE_SOURCE_CONFLICT'});assert.equal(sent,1)

})
test('stopped recovery cannot finalize a different frozen dispatch snapshot for the same run', async t=>{
  const {store,capture,dir}=await openRoot(t);await capture.markStopped(()=>{})
  await assert.rejects(recoverStoppedMeteredRoot({directory:store.directory,command:{...store.command,snapshotDigest:'b'.repeat(64)}},()=>{}),{code:'METERED_CAPTURE_SOURCE_CONFLICT'})
  assert.equal((await readdir(dir)).some(name=>name.includes('final')),false)
  await recoverStoppedMeteredRoot(store,()=>{})
})

test('discussion budget excludes local audit and charges failed and successful transport attempts',async()=>{
  const {discussionBatch}=await import('../metered-usage-delivery.mjs')
  let clock=0;const batch=discussionBatch(()=>clock)
  clock+=8000;assert.equal(batch.remaining(),3000);assert.equal(batch.left,8)
  await assert.rejects(batch.measure(async()=>{clock+=2410;throw new TypeError('lost response')}),TypeError)
  clock+=9000;assert.equal(batch.remaining(),590)
  await batch.measure(async()=>{clock+=590});assert.equal(batch.remaining(),0)
})

test('pinned Images enables only parent text-token observation, never complete coverage of the child',async t=>{
  const {capture}=await openRoot(t,{engineVersion:'codex-cli-0.167.0',adapterVersion:'RESPONSES_TEXT_TOKENS_V1',coveragePolicyVersion:'NATIVE_PINNED_IMAGE_V1'});
  assert.equal(capture.textTokenProtocol,true);
  assert.equal((await capture.sealStopped(()=>{})).closeState,'SEALED_INCOMPLETE');
});

test('image final links only the single reserved child in the same run and re-verifies both phase digests',async t=>{
  const args={coveragePolicyVersion:'NATIVE_PINNED_IMAGE_V1'}
  const id='11111111-1111-4111-8111-111111111111',route='e'.repeat(64)
  async function prepare(runId){
    const f=await openRoot(t,args);f.store.reserve('native-image-start',{invocationId:id,runId,executionId:'exec1',snapshotDigest:'a'.repeat(64),childRouteSha256:route});f.store.write('native-image-binding',{operation:'generate',packageSha256:'b'.repeat(64)})
    const start={schemaVersion:1,invocationId:id,operation:'generate',protocol:'openai-images-v1',channel:'test',tier:'test',priceVersion:'v',requestedModel:'im',observedAt:4,phase:'STARTED',evidence:null},end={...start,observedAt:5,phase:'TERMINAL',evidence:{providerRequestId:'image-response',usage:{total_tokens:123}}};
    f.store.write(`provider-usage-${id}-started`,start);f.store.write(`provider-usage-${id}-terminal`,end);await f.capture.markStopped(()=>{});return {...f,start,end}
  }
  const f=await prepare('run1');await recoverStoppedMeteredRoot(f.store,()=>{});const o=(await f.read('capture-final-1')).observation
  assert.deepEqual(o.imageInvocation,{invocationId:id,operation:'generate',childRouteSha256:route,startedSha256:skillDigest(f.start),terminalSha256:skillDigest(f.end)});assert.equal(o.closeState,'SEALED_INCOMPLETE')
  const {deliverMetered}=await import('../metered-usage-delivery.mjs'),posts=[]
  const send=()=>deliverMetered(f.store,async(path,method,r)=>{posts.push(r.kind);return Object.fromEntries([...['schemaVersion','executionId','runId','captureId','receiptId','recordId','sourceRevision','evidenceSha256'].map(k=>[k,r[k]]),['acceptedAt',5],['acceptance','DURABLE'],['ledger',null]])},{left:8,until:Date.now()+5000},true)
  assert.equal(await send(),false);assert.deepEqual(posts,['PLAN','SOURCE','SOURCE_FINAL'])
  const attemptId=skillDigest(['NATIVE_PROVIDER_CALL',`exec1:${id}`]);const ack=(phase,revision,observation,attempt=attemptId)=>f.store.write(`provider-usage-${id}-${phase}-receipt`,{executionId:'exec1',attemptId:attempt,revision,evidenceSha256:skillDigest({executionId:'exec1',observation}),status:phase==='started'?'PENDING_USAGE':'PENDING_PRICE',costYuan:null})
  ack('started','1',f.start);assert.equal(await send(),false)
  ack('terminal','2',f.end,'f'.repeat(64));await assert.rejects(send(),{code:'METERED_USAGE_RECEIPT_CONFLICT'});assert.ok(!posts.includes('CAPTURE_FINAL'))
  ack('terminal','2',f.end);assert.equal(await send(),true);assert.equal(await send(),true);assert.equal(posts.filter(x=>x==='CAPTURE_FINAL').length,1)
  f.store.write(`provider-usage-${id}-terminal`,{...f.end,observedAt:6});await assert.rejects(recoverStoppedMeteredRoot(f.store,()=>{}),{code:'METERED_CAPTURE_SOURCE_CONFLICT'})
  const g=await prepare('foreign-run');await recoverStoppedMeteredRoot(g.store,()=>{});assert.equal((await g.read('capture-final-1')).observation.imageInvocation,undefined)
})
