// Acceptance peer only. Its parent owns the disposable loopback API, session and database.
// stdin: {port, executionId, runId, session}; stdout: non-secret correlation for SQL assertions.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RuntimeV1Client } from '../../../cyf-agent-runtime-v1/lib/runtime-client.mjs'
import { SkillExecutionStore } from '../../skill-execution-store.mjs'
import { startMeteredRoot } from '../../metered-request-capture.mjs'
import { observeResponse } from '../../metered-response-observation.mjs'
import { SkillUsageDelivery } from '../../skill-usage-delivery.mjs'
import { deliverMetered, meteredBatch } from '../../metered-usage-delivery.mjs'

export async function exercisePeer({port, executionId, runId, session}) {
  assert.ok(Number.isInteger(port) && port>0 && port<=65535)
  const origin=`http://127.0.0.1:${port}`, client=new RuntimeV1Client({apiBaseUrl:origin,manifest:{}})
  client.currentSession=session
  const root=await mkdtemp(join(tmpdir(),'metered-api-peer-'))
  try {
    const scope={agentId:session.canonicalAgentId}, store=new SkillExecutionStore({rootDirectory:root,scope,
      command:{executionProtocolVersion:6,executionId,runId,snapshotDigest:'a'.repeat(64),toolPolicyRef:'NATIVE_LOCAL_FILES_V1',usageMode:'RESPONSE_V2',captureProtocol:'METERED_CAPTURE_V2'}})
    const cap=await startMeteredRoot(store,{executionId,runId,executionConfigSha256:'c'.repeat(64),engineVersion:'fixture',
      coveragePolicyVersion:'TEST_MODEL_ONLY',rootSourceId:'source_model',channelNamespace:'test_gateway',adapterVersion:'FIXTURE',checkActive(){}})
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
    assert.equal(files.length,7)
    const path=join(dir,files.find(f=>/^response-[a-f0-9]{64}-1\.json$/.test(f)))
    const ack=JSON.parse(await readFile(path));assert.equal(ack.ledger.status,'PENDING_USAGE');assert.equal(ack.ledger.costYuan,null)
    await rm(path);assert.equal(await send({...meteredBatch(),left:0}),false);assert.equal(await send(meteredBatch()),true)
    assert.deepEqual(JSON.parse(await readFile(path)),ack)
    return {captureId:cap.captureId,receiptId:ack.receiptId,attemptId:ack.ledger.attemptId,revision:ack.ledger.revision,ackCount:files.length}
  } finally {await rm(root,{recursive:true,force:true})}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try {const chunks=[];for await(const c of process.stdin)chunks.push(c);console.log(JSON.stringify(await exercisePeer(JSON.parse(Buffer.concat(chunks)))))}
  catch {console.error('Metered API peer verification failed');process.exitCode=1}
}
