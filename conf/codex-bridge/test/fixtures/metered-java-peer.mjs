// Acceptance peer only. Its parent owns the disposable loopback API, session and database.
// stdin: {port, executionId, runId, session}; stdout: non-secret correlation for SQL assertions.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RuntimeV1Client } from '../../../cyf-agent-runtime-v1/lib/runtime-client.mjs'
import { SkillExecutionStore } from '../../skill-execution-store.mjs'
import { startMeteredRoot,resumeStoppedMeteredRoot } from '../../metered-request-capture.mjs'
import { observeResponse } from '../../metered-response-observation.mjs'
import { SkillUsageDelivery } from '../../skill-usage-delivery.mjs'
import { deliverMetered, meteredBatch } from '../../metered-usage-delivery.mjs'

export async function exercisePeer({port, executionId, runId, snapshotDigest, session, successor=false}) {
  assert.ok(Number.isInteger(port) && port>0 && port<=65535)
  const origin=`http://127.0.0.1:${port}`, client=new RuntimeV1Client({apiBaseUrl:origin,manifest:{}})
  client.currentSession=session
  const root=await mkdtemp(join(tmpdir(),'metered-api-peer-'))
  try {
    const scope={agentId:session.canonicalAgentId}, store=new SkillExecutionStore({rootDirectory:root,scope,
      command:{executionProtocolVersion:6,executionId,runId,snapshotDigest,toolPolicyRef:'NATIVE_LOCAL_FILES_V1',usageMode:'RESPONSE_V2',captureProtocol:'METERED_CAPTURE_V2'}})
    const options={executionId,runId,executionConfigSha256:'c'.repeat(64),engineVersion:'fixture',
      coveragePolicyVersion:'TEST_MODEL_ONLY',rootSourceId:'source_model',channelNamespace:'test_gateway',adapterVersion:'FIXTURE',checkActive(){}}
    const first=await startMeteredRoot(store,options);let cap=first
    if(successor){await first.markStopped(()=>{});cap=await resumeStoppedMeteredRoot(store,options,'BEFORE_FIRST_TURN')}
    const observation=observeResponse('application/json',200,4096,false)
    observation.push(Buffer.from('{"id":"provider_1","status":"completed"}'))
    await cap.dispatch((_req,finish)=>finish(observation.finish(true)));await cap.sealStopped(()=>{})
    const lane=new SkillUsageDelivery({rootDir:store.directory,apiOrigin:origin,scope,agentId:scope.agentId,runtimeInstanceId:session.runtimeInstanceId,
      getRuntimeHeaders:()=>client.sessionHeaders(),fetchFn:client.nativeFetch.bind(client)})
    const send=batch=>deliverMetered(store,lane.request.bind(lane),batch,true)
    assert.equal(await send({...meteredBatch(),left:2}),false)
    // The receiving fixture drops the first RESPONSE reply after commit. Production delivery must GET its receipt.
    for(let i=0; !await send(meteredBatch()); i++) assert.ok(i<8,'delivery did not finish')
    const dir=join(store.directory,`usage-acks-${cap.captureId}`), files=await readdir(dir)
    assert.equal(files.length,successor?9:7)
    const path=join(dir,files.find(f=>(successor?/^epoch-1-response-[a-f0-9]{64}-1\.json$/:/^response-[a-f0-9]{64}-1\.json$/).test(f)))
    const ack=JSON.parse(await readFile(path));assert.equal(ack.ledger.status,'PENDING_USAGE');assert.equal(ack.ledger.costYuan,null)
    await rm(path);assert.equal(await send({...meteredBatch(),left:0}),false);assert.equal(await send(meteredBatch()),true)
    assert.deepEqual(JSON.parse(await readFile(path)),ack)
    return {captureId:cap.captureId,receiptId:ack.receiptId,attemptId:ack.ledger.attemptId,revision:ack.ledger.revision,ackCount:files.length}
  } finally {await rm(root,{recursive:true,force:true})}
}
// The Java parent supplies the frozen Chat payload and an issued device session. No workspace command.
async function discussionPeer({discussion,port,session,rotate,cutover}){
  const {PersistentChatInbox,validateChatDispatch,durableChatKey}=await import('../../chat-runtime.mjs')
  const {startDiscussionCapture}=await import('../../metered-request-capture.mjs')
  const {ChatUsageDelivery}=await import('../../chat-usage-delivery.mjs')
  assert.ok(Number.isInteger(port)&&port>0&&port<=65535)
  const m=validateChatDispatch(discussion),apiOrigin=`http://127.0.0.1:${port}`
  const client=new RuntimeV1Client({apiBaseUrl:apiOrigin,manifest:{}});client.currentSession=session
  const rootDir=cutover?join(tmpdir(),cutover==='live'?'inbox':'cutover-inbox'):await mkdtemp(join(tmpdir(),'discussion-api-peer-'))
  try{
    const profile={agentId:session.canonicalAgentId},scope={...profile,clientId:m.clientId,tenantId:m.tenantId}
    const inbox=new PersistentChatInbox({rootDir,profile});inbox.initialize()
    if(cutover==='resume'){
      // New OS process; recovery must discover the sealed original without starting a model or accepting another dispatch.
      const key=durableChatKey(m), lane=new ChatUsageDelivery({inbox,apiOrigin,scope,nativeFetch:client.nativeFetch.bind(client)})
      const {inspectDiscussionReceipts}=await import('../../metered-usage-delivery.mjs')
      assert.equal(await inspectDiscussionReceipts(inbox,key,scope),false)
      const audit=await lane.flush();assert.equal(audit.confirmed,true);assert.equal(audit.pending,0)
      assert.equal(await inspectDiscussionReceipts(inbox,key,scope),true)
      assert.deepEqual(audit.captureStates,[{key,capture:'SEALED',delivery:'ACKNOWLEDGED',coverage:'INCOMPLETE'}])
      const parent=join(inbox.dir,`discussion-source-${key}`),captureId=m.contextSnapshot.facts.taskUsageCapture.captureId
      const dir=join(parent,`usage-acks-${captureId}`),files=await readdir(dir);assert.equal(files.length,7)
      const ack=JSON.parse(await readFile(join(dir,files.find(f=>/^response-[a-f0-9]{64}-1\.json$/.test(f)))))
      return {receiptId:ack.receiptId,revision:ack.ledger.revision,ackCount:files.length}
    }
    const {key}=await inbox.accept(m);assert.ok(inbox.claim(key));const {parent}=inbox.discussionCaptureSubject(key,false)
    const cap=await startDiscussionCapture(inbox,key,{executionConfigSha256:'c'.repeat(64),engineVersion:'fixture',rootSourceId:'discussion',channelNamespace:'test_gateway',adapterVersion:'FIXTURE',checkActive(){}})
    const obs=observeResponse('application/json',200,4096,false);obs.push(Buffer.from('{"id":"discussion_response_1","status":"completed"}'))
    await cap.dispatch((_req,finish)=>finish(obs.finish(true)));await cap.sealStopped(()=>{});inbox.complete(inbox.findByKey(key))
    // Rotation only: discard the real committed receipt before the delivery component sees it.
    // Other peer cases still cut the TCP reply at the server. Do not conflate OS timing with session fencing.
    let discarded=false
    const cfg={inbox,apiOrigin,scope,nativeFetch:async(url,options)=>{
      const response=await client.nativeFetch(url,options)
      if(cutover==='stop' && response.headers.get('X-Fixture-Stop-After-Commit')==='yes'){assert.equal(response.status,200);process.exit(75)}
      if(rotate && response.headers.get('X-Fixture-Drop-Committed')==='yes'){
        assert.equal(response.status,200);assert.equal(discarded,false);discarded=true
        await response.arrayBuffer();throw new TypeError('fixture: receipt lost before delivery')
      }
      return response
    }}
    const lane=new ChatUsageDelivery(cfg),errors=await lane.deliver()
    if(rotate){
      assert.equal(discarded,true);assert.deepEqual(errors,[{code:'CHAT_CAPTURE_DELIVERY_PENDING'}]);const audit=await new ChatUsageDelivery(cfg).flush()
      assert.equal(audit.confirmed,false);assert.deepEqual(audit.captureStates,[{key,capture:'SEALED',delivery:'PENDING',coverage:'INCOMPLETE',reason:'ACCESS_UNCONFIRMED'}])
      const acks=await readdir(join(parent,`usage-acks-${cap.captureId}`));assert.equal(acks.length,4);assert.ok(!acks.some(f=>f.startsWith('response-')))
      const src=join(parent,`usage-capture-${cap.captureId}`),file=(await readdir(src)).find(f=>/^response-[a-f0-9]{64}-1\.json$/.test(f))
      const original=JSON.parse(await readFile(join(src,file)));assert.equal(original.executionId,m.turnId);assert.equal(original.runId,m.dispatchId)
      return {receiptId:original.receiptId,ackCount:acks.length,pending:audit.pending}
    }
    assert.deepEqual(errors,[])
    const audit=await new ChatUsageDelivery(cfg).flush();assert.ok(audit.confirmed);assert.equal(audit.captureStates[0].coverage,'INCOMPLETE')
    const dir=join(parent,`usage-acks-${cap.captureId}`),files=await readdir(dir);assert.equal(files.length,7)
    const ack=JSON.parse(await readFile(join(dir,files.find(f=>/^response-[a-f0-9]{64}-1\.json$/.test(f)))))
    assert.equal(ack.ledger.status,'PENDING_USAGE');assert.equal(ack.ledger.costYuan,null)
    return {receiptId:ack.receiptId,revision:ack.ledger.revision,ackCount:files.length}
  }finally{if(!cutover)await rm(rootDir,{recursive:true,force:true})}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try {const chunks=[];for await(const c of process.stdin)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks));console.log(JSON.stringify(await (input.discussion?discussionPeer:exercisePeer)(input)))}
  catch {console.error('Metered API peer verification failed');process.exitCode=1}
}
