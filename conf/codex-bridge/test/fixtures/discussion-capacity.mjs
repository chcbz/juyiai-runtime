// Non-production, fixed workload. TMPDIR must be caller-owned ordinary disk. No network/credentials.
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,readdir,lstat,statfs} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersistentChatInbox,canonicalSha256,validateChatDispatch} from '../../chat-runtime.mjs'
import {startDiscussionCapture} from '../../metered-request-capture.mjs'
import {verifySealedSubject} from '../../metered-capture-closure.mjs'
import {observeResponse} from '../../metered-response-observation.mjs'
import {ChatUsageDelivery} from '../../chat-usage-delivery.mjs'
import {skillDigest} from '../../skill-executor.mjs'
const sizes=[128,32,...Array(8).fill(1)], fsType=(await statfs(tmpdir())).type
assert.ok(![0x01021994,0x858458f6].includes(fsType),'disk fixture required')
const rootDir=await mkdtemp(join(tmpdir(),'discussion-capacity-')), wire=JSON.parse(await readFile(new URL('../../contracts/api-hosted-wire-v1.json',import.meta.url)))
const roundMs=n=>Number(n.toFixed(2)),time=()=>performance.now(),samples=[],seen=new Set(),keys=[]
try{
 const profile={agentId:wire.targetAgentId},scope={...profile,clientId:wire.clientId,tenantId:wire.tenantId},inbox=new PersistentChatInbox({rootDir,profile});inbox.initialize()
 for(const [i,size] of sizes.entries()){
  const m=structuredClone(wire);m.route='CHAT';m.dispatchId+=`-${i}`;m.turnId+=`-${i}`;m.dedupeKey+=`-${i}`
  m.factsManifest.participantAgentIds=[profile.agentId];m.factsManifest.contextDelivery={mode:'BOOTSTRAP'}
  m.factsManifest.taskUsageCapture={protocol:'METERED_CAPTURE_V2',captureId:skillDigest(['CAPTURE_V2',m.turnId,m.dispatchId])}
  m.contextSnapshot.facts=m.factsManifest;m.contextHash=m.contextSnapshot.contextHash=canonicalSha256({sourceVector:m.sourceVector,facts:m.factsManifest})
  const {key}=await inbox.accept(validateChatDispatch(m));assert.ok(inbox.claim(key));const {parent,subject}=inbox.discussionCaptureSubject(key,false);keys.push(key)
  const cap=await startDiscussionCapture(inbox,key,{executionConfigSha256:'c'.repeat(64),engineVersion:'fixture',rootSourceId:'discussion',channelNamespace:'fixture',adapterVersion:'fixture',checkActive(){}})
  for(let j=0;j<size;j++){const obs=observeResponse('application/json',200,4096,false);obs.push(Buffer.from(JSON.stringify({id:`fixture_${i}_${j}`,status:'completed'})));await cap.dispatch((_r,finish)=>finish(obs.finish(true)))}
  await cap.sealStopped(()=>{});inbox.complete(inbox.findByKey(key));const dirs=join(parent,`usage-capture-${cap.captureId}`),names=await readdir(dirs);let allocated=0
  for(const n of names)allocated+=(await lstat(join(dirs,n))).blocks*512
  const auditMs=[];for(let j=0;j<3;j++){const t=time();assert.equal((await verifySealedSubject(parent,subject)).closeState,'SEALED_INCOMPLETE');auditMs.push(roundMs(time()-t))}
  samples.push({requests:size,sourceFiles:names.length,allocatedFileBytes:allocated,auditMs,posted:0})
 }
 let round=0,clock=0;const rounds=[],t0=time(),lane=new ChatUsageDelivery({inbox,scope,apiOrigin:'https://fixture.invalid',now:()=>clock,nativeFetch:async(ep,opt)=>{
  assert.equal(opt.method,'POST');const e=JSON.parse(opt.body),id=e.receiptId,s=samples[Number(e.runId.split('-').at(-1))];assert.ok(!seen.has(id));seen.add(id);s.posted++;s.firstRound??=round;s.firstPostMs??=roundMs(time()-t0);s.lastRound=round
  const ack={...Object.fromEntries(['schemaVersion','executionId','runId','captureId','receiptId','recordId','sourceRevision','evidenceSha256'].map(k=>[k,e[k]])),acceptedAt:1,acceptance:'DURABLE',ledger:e.kind==='RESPONSE'?{attemptId:skillDigest(['NATIVE_RESPONSE_USAGE',e.observation.sourceAttemptId]),revision:'1',status:'PENDING_USAGE',costYuan:null}:null}
  return {status:200,url:ep.href,headers:new Headers({'X-Request-Id':id}),text:async()=>JSON.stringify({protocolVersion:1,requestId:id,code:'E0',msg:'',data:ack})}
 }})
 for(const key of keys)lane.noteSource(key) // Deliberately put the largest source first.
 while(lane.nextRecoveryAt()!==Infinity){assert.ok(++round<200);clock=Math.max(clock,lane.nextRecoveryAt());const t=time(),prior=seen.size;assert.deepEqual(await lane.deliver(),[]);assert.ok(seen.size-prior<=8);rounds.push(roundMs(time()-t))}
 const deliveredMs=roundMs(time()-t0);for(const s of samples)assert.equal(s.posted,3*s.requests+4)
 const t=time(),audit=await lane.flush();assert.ok(audit.confirmed);assert.equal(audit.captureStates.length,sizes.length);assert.ok(audit.captureStates.every(s=>s.coverage==='INCOMPLETE'))
 console.log(JSON.stringify({format:'discussion-capacity-v1',fsType,node:process.version,samples,rounds,posted:seen.size,deliveredMs,schedulerWaitMs:clock,handoverAuditMs:roundMs(time()-t)}))
}finally{await rm(rootDir,{recursive:true,force:true})}
