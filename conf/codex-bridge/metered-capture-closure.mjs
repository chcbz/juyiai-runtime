/** Source-only closure for the metered HTTP root epoch. No lease, model adapter,
 * provider credential, command dispatch or wallet dependency in recovery. */
import { meteredImageReference } from './metered-image-reference.mjs'
import { resolve } from 'node:path'
import { skillDigest, skillId, skillSha } from './skill-executor.mjs'
import { directory, readPrivate, persist, first, rootEpochDirectories } from './metered-capture-files.mjs'
const invalid = () => {throw Object.assign(Error('METERED_CAPTURE_SOURCE_CONFLICT'),{code:'METERED_CAPTURE_SOURCE_CONFLICT'})}
const yes = value => {if(!value)invalid()}
const tuple = r => [r.recordId,r.sourceRevision,r.evidenceSha256]
const dec = value => typeof value==='string' && /^(0|[1-9][0-9]*)$/.test(value)
const positive='([1-9][0-9]*)', sha='([0-9a-f]{64})'
const requestRE=new RegExp(`^request-${positive}-${positive}\\.json$`),responseRE=new RegExp(`^response-${sha}-${positive}\\.json$`),reservedRE=new RegExp(`^reserved-${positive}\\.json$`)

export async function recoverStoppedMeteredRoot(store, assertStopped, clock=Date.now) {
  // Caller owns the original stopped execution / subject writer gate, not a lease to execute again.
  const {executionId,runId,usageMode,captureProtocol,snapshotDigest}=store.command
  yes(skillId(executionId)&&skillId(runId)&&usageMode==='RESPONSE_V2'&&captureProtocol==='METERED_CAPTURE_V2')
  return closeMeteredSubject(store.directory, {executionId,runId,snapshotDigest}, assertStopped, clock)
}
// Source owner supplies the frozen dispatch snapshot, not a snapshot read from the PLAN being verified.
export async function closeMeteredSubject(parent, {executionId,runId,snapshotDigest}, assertStopped, clock=Date.now) {
  await assertStopped()
  return auditSubject(parent,{executionId,runId,snapshotDigest},assertStopped,clock)
}
// Read-only recovery: never fabricate a stopped writer gate or manufacture missing seals.
export function verifySealedSubject(parent,subject,onRecord){return auditSubject(parent,subject,null,null,onRecord)}
async function auditSubject(parent,{executionId,runId,snapshotDigest},assertStopped,clock,onRecord){
  yes(skillId(executionId) && skillId(runId) && skillSha(snapshotDigest))
  const captureId=skillDigest(['CAPTURE_V2',executionId,runId]),binding={executionId,runId,captureId},dir=resolve(parent,`usage-capture-${captureId}`)
  const epochs=await rootEpochDirectories(dir), names=new Set(epochs[0].names)
  const check=(raw,kind,identity,rev,previous)=>{
    const {receiptId,expectedRevision,evidenceSha256,...e}=raw
    yes(e.schemaVersion===2&&e.executionId===executionId&&e.runId===runId&&e.captureId===captureId&&e.kind===kind&&e.recordId===skillDigest(['USAGE_RECORD_V2',captureId,kind,identity])&&e.sourceRevision===String(rev)&&e.previousEvidenceSha256===(previous?.evidenceSha256??null)&&evidenceSha256===skillDigest(e))
    yes(expectedRevision===(kind==='RESPONSE'?'0':null)&&receiptId===skillDigest(['USAGE_RECEIPT_V2',evidenceSha256,expectedRevision]));onRecord?.(raw);return raw
  }
  const plan=check(await readPrivate(dir,'plan'),'PLAN',[],1), sourceId=plan.observation.rootSourceId
  yes(plan.observation.snapshotSha256 === snapshotDigest && plan.observation.captureProtocol === 'METERED_CAPTURE_V2')
  const image=plan.observation.coveragePolicyVersion==='NATIVE_PINNED_IMAGE_V1' && plan.observation.imageRoute
  const finals=[], allReasons=new Set(), seenResponses=new Set();let previous=null
  const final=async(dir,names,key,kind,identity,observation)=>{
    if(names.has(`${key}.json`)){const existing=check(await readPrivate(dir,key),kind,identity,1);yes(skillDigest(existing.observation)===skillDigest(observation));return existing}
    yes(assertStopped);await assertStopped();const r=first(binding,kind,identity,observation,clock);await persist(dir,key,r);return r
  }
  for(const entry of epochs){
    const {epoch,dir}=entry,names=new Set(entry.names),read=k=>readPrivate(dir,k)
    const reasons=new Set(),latest=new Map(),requests=new Map(),responses=new Set(),refs=new Set(),reservations=new Set(),claims=new Set()
    const source=check(await read(`source-${epoch}`),'SOURCE',[sourceId,epoch],1),so=source.observation
    yes(skillId(sourceId)&&so.sourceId===sourceId&&so.epoch===epoch&&so.parentSourceRecordId===null&&so.previousEpochSourceRecordId===previous)
    previous=source.recordId
    const imageSource=image && skillId(image.model) && skillSha(image.childRouteSha256) && plan.observation.dispatchGroup?.routeSha256===skillDigest(['NATIVE_COMPOSITE_ROUTE_V1',so.channelNamespace,image.model,image.childRouteSha256])
    if((!imageSource&&!['TEXT_MODEL_ONLY_V1','NATIVE_LOCAL_ARTIFACT_TEXT_V1'].includes(plan.observation.coveragePolicyVersion))||plan.observation.engineVersion!=='codex-cli-0.167.0'||so.adapterVersion!=='RESPONSES_TEXT_TOKENS_V1'||so.sourceKind!=='METERED_HTTP_RESPONSES_V1')reasons.add('UNSUPPORTED_COST_SOURCE')
    latest.set(source.recordId,tuple(source))
    let high=0n
    for(const name of names){let m
      if((m=reservedRE.exec(name))){yes((await read(name.slice(0,-5))).sequence===m[1]);reservations.add(m[1]);if(BigInt(m[1])>high)high=BigInt(m[1])}
      else if((m=requestRE.exec(name))){const [_,seq,rev]=m;yes(rev==='1'||rev==='2');requests.set(seq,requests.get(seq)==='2'?'2':rev)}
      else if((m=responseRE.exec(name))){yes(m[2]==='1');responses.add(m[1])}
      else if((m=/^response-owner-([a-f0-9]{64})$/.exec(name))){await directory(resolve(dir,name));claims.add(m[1])}
      else if(/^duplicate-[1-9][0-9]*\.json$/.test(name))reasons.add('DUPLICATE_RESPONSE_ID')
      else if(name.startsWith('tmp-'))reasons.add('PARTIAL_SOURCE_WRITE')
      else if(epoch==='0' && (/^epoch-[1-9][0-9]*$/.test(name)||['plan.json','capture-final-1.json','usage-capture-finalized.json'].includes(name)))continue
      else if(!['producer-stopped.json',`source-${epoch}.json`,'source-final-1.json'].includes(name))invalid()
    }
    if(names.has('producer-stopped.json')){const stop=await read('producer-stopped');yes(Object.entries(binding).every(([k,v])=>stop[k]===v)&&(epoch==='0'||stop.epoch===epoch)&&dec(stop.reservedHigh)&&BigInt(stop.reservedHigh)>=high&&typeof stop.writeFailed==='boolean');high=BigInt(stop.reservedHigh);if(stop.writeFailed)reasons.add('SOURCE_WRITE_INCOMPLETE')}
    else reasons.add('PRODUCER_WATERMARK_UNCONFIRMED')
    if(high===0n && (image||plan.observation.coveragePolicyVersion==='NATIVE_LOCAL_ARTIFACT_TEXT_V1'))reasons.add('USAGE_INCOMPLETE')
    if(high!==BigInt(reservations.size)||high!==BigInt(requests.size))reasons.add('SEQUENCE_GAP')
    for(const [seq,rev] of requests){yes(reservations.has(seq));const identity=[sourceId,epoch,seq],base=check(await read(`request-${seq}-1`),'REQUEST',identity,1),b=base.observation
      yes(b.sourceId===sourceId&&b.epoch===epoch&&b.sequence===seq&&skillId(b.attemptId)&&b.resolution==='PENDING'&&b.sourceAttemptId===null)
      const r=rev==='2'?check(await read(`request-${seq}-2`),'REQUEST',identity,2,base):base,o=r.observation
      yes(o.sourceId===sourceId&&o.epoch===epoch&&o.sequence===seq&&o.attemptId===b.attemptId)
      if(o.resolution!=='RESPONSE'||!responses.has(o.sourceAttemptId))reasons.add('UNRESOLVED_REQUEST')
      else if(refs.has(o.sourceAttemptId))reasons.add('DUPLICATE_RESPONSE_ID');else refs.add(o.sourceAttemptId)
      latest.set(r.recordId,tuple(r))
    }
    for(const id of responses){yes(!seenResponses.has(id));seenResponses.add(id);const r=check(await read(`response-${id}-1`),'RESPONSE',[id],1),o=r.observation
      yes(o.sourceId===sourceId&&o.epoch===epoch&&o.sourceAttemptId===id&&skillId(o.providerResponseId)&&id===skillDigest(['NATIVE_RESPONSE_USAGE',so.channelNamespace,o.providerResponseId]))
      if(!refs.has(id)||!claims.has(id))reasons.add('UNLINKED_RESPONSE');if(o.measuredQuantities?.coverage!=='COMPLETE')reasons.add('USAGE_INCOMPLETE');latest.set(r.recordId,tuple(r))
    }
    for(const id of claims)if(!responses.has(id))reasons.add('MISSING_RESPONSE_RECORD')
    const reasonCodes=[...reasons].sort(), closeState=reasons.size?'SEALED_INCOMPLETE':'DRAINED'
    const sourceFinal=await final(dir,names,'source-final-1','SOURCE_FINAL',[sourceId,epoch],{sourceId,epoch,reservedSequenceHighWatermark:String(high),requestCount:String(requests.size),responseCount:String(responses.size),recordsSha256:skillDigest([...latest.values()].sort(([a],[b])=>a<b?-1:1)),closeState,reasonCodes})
    finals.push(tuple(sourceFinal));for(const reason of reasonCodes)allReasons.add(reason)
  }
  // Current local-artifact admission proves only epoch zero (design §4.2.3).
  if(epochs.length>1 && (image||plan.observation.coveragePolicyVersion==='NATIVE_LOCAL_ARTIFACT_TEXT_V1'))allReasons.add('UNSUPPORTED_COST_SOURCE')
  // Re-verify references on replay, but never reinterpret an older or incomplete final as a newer one.
  const sealed=names.has('capture-final-1.json') ? await readPrivate(dir,'capture-final-1') : null
  const child=plan.observation.coveragePolicyVersion==='NATIVE_PINNED_IMAGE_V1' && (!sealed || sealed.observation.imageInvocation)
    ? await meteredImageReference(parent,{executionId,runId,snapshotDigest},
        {includeCostRoute:!sealed || Object.hasOwn(sealed.observation.imageInvocation,'costRouteReference')}) : null
  if(image && (!child || child.childRouteSha256!==image.childRouteSha256))allReasons.add('USAGE_INCOMPLETE')
  const reasonCodes=[...allReasons].sort(),closeState=reasonCodes.length?'SEALED_INCOMPLETE':'DRAINED'
  const captureFinal=await final(dir,names,'capture-final-1','CAPTURE_FINAL',[],{...(child?{imageInvocation:child}:{}),planEvidenceSha256:plan.evidenceSha256,sourceCount:String(finals.length),sourcesSha256:skillDigest([...finals].sort(([a],[b])=>a<b?-1:1)),closeState,reasonCodes})
  const marker={...binding,...(finals.length===1?{sourceFinal:finals[0]}:{sourceFinals:finals}),captureFinal:tuple(captureFinal),closeState}
  if(names.has('usage-capture-finalized.json'))yes(skillDigest(await readPrivate(dir,'usage-capture-finalized'))===skillDigest(marker))
  else {yes(assertStopped);await assertStopped();await persist(dir,'usage-capture-finalized',marker)}
  return marker // local capture only; does not assert billing completeness, durability at the API or delivery ACK.
}
