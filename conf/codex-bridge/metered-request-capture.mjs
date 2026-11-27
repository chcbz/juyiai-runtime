import { costConfigurationObservation } from './cost-profile-report.mjs'
/** Source-side only. The owner must hold the original execution writer fence.
 * No provider URL, credential, prompt, response body or replay callback is stored. */
import { mkdir, lstat, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { durableChatKey } from './chat-runtime.mjs'
import { skillDigest, skillId, skillSha } from './skill-executor.mjs'
import { first, persist, directory, syncDir, readPrivate, rootEpochDirectories } from './metered-capture-files.mjs'
import { closeMeteredSubject } from './metered-capture-closure.mjs'
const bad = code => { throw Object.assign(new Error(code), {code}) }
const checkId = id => { if(!skillId(id)) bad('METERED_CAPTURE_ID_INVALID'); return id }
/** Start only a NEW RESPONSE_V2 run, before spawning the engine. Existing plan is recovery work, never dispatch authority. */
export const startMeteredRoot = (store, options) => openRoot(store,options,null)
// The original dispatch owner supplies mode only after checking the durable thread/start checkpoint.
// This does not resume a model turn. A reconcile-only adapter cannot send even one model request.
export const resumeStoppedMeteredRoot = (store, options, mode) => {
  if(!['RECONCILE_ONLY','BEFORE_FIRST_TURN'].includes(mode))bad('SKILL_RESULT_UNKNOWN')
  return openRoot(store,options,mode)
}
function openRoot(store, options, mode) {
  if (store.command.usageMode !== 'RESPONSE_V2' || store.command.captureProtocol !== 'METERED_CAPTURE_V2')
    return Promise.reject(Object.assign(Error('METERED_CAPTURE_BINDING_INVALID'),{code:'METERED_CAPTURE_BINDING_INVALID'}))
  return openSubject(store.directory,store.command,options,mode)
}
async function openSubject(parent, subject, { executionId, runId, executionConfigSha256, dispatchGroup = null, imageRoute = null, costConfiguration = null, engineVersion, coveragePolicyVersion,
  rootSourceId, channelNamespace, adapterVersion, checkActive, deferUntilThread = false, now = Date.now }, mode, onClaim = null) {
  if (subject.executionId !== checkId(executionId) || subject.runId !== checkId(runId)
      || !skillSha(subject.snapshotDigest) || !skillSha(executionConfigSha256) || typeof checkActive !== 'function') bad('METERED_CAPTURE_BINDING_INVALID')
  for (const id of [runId, engineVersion, coveragePolicyVersion, rootSourceId, channelNamespace, adapterVersion]) checkId(id)
  const binding = { executionId, runId, captureId: skillDigest(['CAPTURE_V2', executionId, runId]) }
  const root = resolve(parent, `usage-capture-${binding.captureId}`),sourceId=rootSourceId
  checkActive(); await directory(parent)
  if(imageRoute && (coveragePolicyVersion!=='NATIVE_PINNED_IMAGE_V1'||Object.keys(imageRoute).length!==2||!skillId(imageRoute.model)||!skillSha(imageRoute.childRouteSha256)||
    dispatchGroup?.routeSha256!==skillDigest(['NATIVE_COMPOSITE_ROUTE_V1',channelNamespace,imageRoute.model,imageRoute.childRouteSha256])))bad('METERED_CAPTURE_BINDING_INVALID')
  let observedConfiguration=null
  if(costConfiguration!==null){
    observedConfiguration=costConfigurationObservation(costConfiguration)
    if(!dispatchGroup || observedConfiguration.capturePolicyVersion!==coveragePolicyVersion)bad('METERED_CAPTURE_BINDING_INVALID')
    const parents=observedConfiguration.routeRefs.filter(r=>r.kind==='MODEL_RESPONSE')
    if(parents.length!==1 || parents[0].component!=='INFERENCE' || parents[0].namespace!==channelNamespace || parents[0].normalizationBasis!==adapterVersion)bad('METERED_CAPTURE_BINDING_INVALID')
  }
  const planFacts={captureProtocol:'METERED_CAPTURE_V2',snapshotSha256:subject.snapshotDigest,executionConfigSha256,
    engineVersion,coveragePolicyVersion,rootSourceId,...(observedConfiguration?{costConfiguration:observedConfiguration}:{}),...(dispatchGroup?{dispatchGroup}:{}),...(imageRoute?{imageRoute}:{})}
  const sourceFacts=(epoch,previous)=>({sourceId,epoch,sourceKind:'METERED_HTTP_RESPONSES_V1',adapterVersion,channelNamespace,
    parentSourceRecordId:null,previousEpochSourceRecordId:previous})
  let epoch='0',dir=root,previous=null
  if(mode===null){
    // EEXIST never grants a second fresh writer, even if the original PLAN write failed.
    await mkdir(root,{mode:0o700});await syncDir(parent)
    if(onClaim)await onClaim()
    await persist(root,'plan',first(binding,'PLAN',[],planFacts,now))
  }else{
    const requireResume=ok=>{if(!ok)bad('SKILL_RESULT_UNKNOWN')}
    const epochs=await rootEpochDirectories(root)
    const sameFirst=(raw,kind,identity,facts)=>requireResume(skillDigest(raw)===skillDigest(first(binding,kind,identity,facts,()=>raw.observedAt)))
    sameFirst(await readPrivate(root,'plan'),'PLAN',[],planFacts)
    for(const entry of epochs){
      requireResume(!entry.names.some(n=>['source-final-1.json','capture-final-1.json','usage-capture-finalized.json'].includes(n)))
      const src=await readPrivate(entry.dir,`source-${entry.epoch}`)
      sameFirst(src,'SOURCE',[sourceId,entry.epoch],sourceFacts(entry.epoch,previous));previous=src.recordId
      requireResume(entry.names.includes('producer-stopped.json'))
      const stop=await readPrivate(entry.dir,'producer-stopped');requireResume(Object.entries(binding).every(([k,v])=>stop[k]===v)&&
        (entry.epoch==='0'||stop.epoch===entry.epoch)&&stop.writeFailed===false&&typeof stop.reservedHigh==='string'&&/^(0|[1-9][0-9]*)$/.test(stop.reservedHigh))
      // A missing start-attempt is never sufficient evidence to repeat prior provider activity.
      if(mode==='BEFORE_FIRST_TURN')requireResume(stop.reservedHigh==='0'&&!entry.names.some(n=>/^(?:reserved|request|response|duplicate|tmp)-/.test(n)))
    }
    epoch=String(BigInt(epochs.at(-1).epoch)+1n);dir=resolve(root,`epoch-${epoch}`)
  }
  const deferred=mode==='BEFORE_FIRST_TURN' && deferUntilThread
  let registered=false,registering
  const register=()=>registering??=(async()=>{
    if(mode!==null){checkActive();await mkdir(dir,{mode:0o700});await syncDir(root)}
    await persist(dir,`source-${epoch}`,first(binding,'SOURCE',[sourceId,epoch],sourceFacts(epoch,previous),now));registered=true;checkActive()
  })()
  if(!deferred)await register()
  let next = 0n, stopped = mode==='RECONCILE_ONLY', inflight=0, drained, wake, writeFailed=false
  let sealing, watermark
  async function markStopped(assertStopped) {
    await assertStopped(); stopped=true
    if(registering)await registering
    if(!registered)return // restoring an empty thread failed before admitting any producer
    if(inflight)await (drained??=new Promise(resolve=>{wake=resolve}))
    await assertStopped()
    // A stopped recovery may have already closed the source incomplete. Never rewrite its decision.
    return watermark??=(async()=>{
      const sealed=await lstat(resolve(dir,'source-final-1.json')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error})
      if(!sealed)await persist(dir,'producer-stopped',{...binding,...(epoch==='0'?{}:{epoch}),reservedHigh:String(next),writeFailed})
    })().catch(error=>{watermark=null;throw error})
  }
  return Object.freeze({ ...binding, ...(deferred?{async enableAfterThreadResume(){if(stopped)bad('METERED_CAPTURE_ADMISSION_CLOSED');await register()}}:{}), textTokenProtocol:engineVersion==='codex-cli-0.167.0' && adapterVersion==='RESPONSES_TEXT_TOKENS_V1' && ['TEXT_MODEL_ONLY_V1','NATIVE_LOCAL_ARTIFACT_TEXT_V1','NATIVE_PINNED_IMAGE_V1'].includes(coveragePolicyVersion), stopAdmission() { stopped = true },
    async stopAndDrain(){stopped=true;if(inflight)await (drained??=new Promise(resolve=>{wake=resolve}));if(writeFailed)bad('METERED_CAPTURE_WRITE_INCOMPLETE')},
    // Called only after the owner has joined the engine and closed the egress. No re-opening after this point.
    markStopped,
    sealStopped(assertStopped) {
      return sealing??=(async()=>{
        await markStopped(assertStopped)
        return closeMeteredSubject(parent,subject,assertStopped,now)
      })().catch(error=>{sealing=null;throw error})
    },
    // Only the actual egress handler may supply send; call it after checking the live fence again.
    async dispatch(send) {
      if (!registered || stopped || typeof send !== 'function') bad('METERED_CAPTURE_ADMISSION_CLOSED')
      inflight++;try {
        checkActive(); const sequence = String(++next), attemptId = randomUUID()
        let record
        try {
          // Independent reservations cannot overwrite/lower a concurrent request's high watermark.
          await persist(dir, `reserved-${sequence}`, { sequence })
          record = first(binding, 'REQUEST', [sourceId, epoch, sequence], { sourceId, epoch, sequence, attemptId,
            resolution: 'PENDING', sourceAttemptId: null, reasonCodes: [] }, now)
          await persist(dir, `request-${sequence}-1`, record)
          if (stopped) bad('METERED_CAPTURE_ADMISSION_CLOSED')
          checkActive()
        } catch (error) { stopped = true; writeFailed=true; throw error }
        let finalized=false
        const finish = async evidence => {
          if(finalized) bad('METERED_REQUEST_ALREADY_RESOLVED'); finalized=true
          const {providerResponseId,reportedUsage,measuredQuantities,actualBillingIdentity,reasonCodes}=evidence
          let sourceAttemptId=null,reasons=reasonCodes
          try {
            if(providerResponseId!==null) {
              checkId(providerResponseId);sourceAttemptId=skillDigest(['NATIVE_RESPONSE_USAGE',channelNamespace,providerResponseId])
              const observation={sourceId,epoch,sourceAttemptId,providerResponseId,reportedUsage,measuredQuantities,actualBillingIdentity,reasonCodes}
              // Immutable identity: a second concurrent request cannot replace the first response revision.
              let duplicate=false
              try { await mkdir(resolve(dir,`response-owner-${sourceAttemptId}`),{mode:0o700}) }
              catch(error){if(error.code!=='EEXIST')throw error;duplicate=true}
              if(duplicate){reasons=[...reasonCodes,'DUPLICATE_RESPONSE_ID'];await persist(dir,`duplicate-${sequence}`,observation)}
              else await persist(dir,`response-${sourceAttemptId}-1`,first(binding,'RESPONSE',[sourceAttemptId],observation,now))
            }
            const observation={...record.observation,resolution:sourceAttemptId?'RESPONSE':'UNRESOLVED',sourceAttemptId,reasonCodes:reasons}
            await persist(dir,`request-${sequence}-2`,first(binding,'REQUEST',[sourceId,epoch,sequence],observation,now,record))
          }catch(error){stopped=true;writeFailed=true;throw error}
        }
        return await send(Object.freeze({ captureId: binding.captureId, sourceId, epoch, sequence, attemptId, evidenceSha256: record.evidenceSha256 }), finish)
      }finally{if(--inflight===0)wake?.()}
    } })
}

// Internal source owner only. Never infer capture enrollment from a thread event or a deterministic ID alone.
// This lane records observations, not COMPLETE: shared adapters and material egress are not yet attested.
export async function startDiscussionCapture(inbox, key, options) {
  const origin = inbox.discussionCaptureSubject(key, false), {parent, subject} = origin
  if(discussionKey(origin.message)!==key)bad('METERED_CAPTURE_SOURCE_CONFLICT')
  const bind = async () => {
    const facts = discussionBinding(key,origin.message,origin.fingerprint)
    // Claimed root is exclusive. Never replace another snapshot; a torn write cannot pass validation.
    await directory(parent)
    const f = await open(resolve(parent,'discussion-binding.json'),'wx',0o600)
    try { await f.writeFile(JSON.stringify({...facts,digest:skillDigest(facts)})); await f.sync() } finally { await f.close() }
    await syncDir(parent)
    inbox.noteDiscussionSource?.(key)
  }
  return openSubject(parent, subject, {...options, executionId:subject.executionId, runId:subject.runId,
    dispatchGroup:null, coveragePolicyVersion:'CHAT_SOURCE_UNVERIFIED_V1'}, null, bind)
}
// No prompt, full message, tool data or price. Retain these original identity fields alongside unacknowledged usage.
const discussionKey = m => durableChatKey({dedupeKey:`${m.tenantId}:${m.ownerJiacn}:${m.clientId}:${m.dispatchId}`})
const discussionBinding = (key,m,fingerprint) => ({schemaVersion:1,key,fingerprint,
  ...Object.fromEntries(['tenantId','ownerJiacn','clientId','requestId','turnId','dispatchId','targetAgentId','contextHash'].map(k=>[k,m[k]]))})
export async function recoverStoppedDiscussionCapture(inbox, key, assertStopped) {
  await assertStopped()
  const {parent,subject}=await retainedDiscussionSource(inbox,key)
  return closeMeteredSubject(parent,subject,assertStopped)
}
// Read-only lookup for delivery and closure; has no engine or model dispatch authority.
export async function retainedDiscussionSource(inbox,key){
  const original = inbox.discussionCaptureSubject(key, true), {parent} = original
  const {digest,...facts} = await readPrivate(parent,'discussion-binding')
  const expected = discussionBinding(key,original.message || original.marker?.message || facts,
    original.fingerprint || original.marker?.fingerprint || facts.fingerprint)
  if (facts.schemaVersion!==1 || facts.key!==key || facts.targetAgentId!==inbox.profile.agentId ||
      !/^sha256:[0-9a-f]{64}$/.test(facts.fingerprint) || !/^sha256:[0-9a-f]{64}$/.test(facts.contextHash) ||
      digest!==skillDigest(facts) || digest!==skillDigest(expected) ||
      discussionKey(facts)!==key) bad('METERED_CAPTURE_SOURCE_CONFLICT')
  if(!skillId(facts.turnId)||!skillId(facts.dispatchId))bad('METERED_CAPTURE_SOURCE_CONFLICT')
  return {parent,facts,subject:{executionId:facts.turnId,runId:facts.dispatchId,snapshotDigest:facts.contextHash.slice(7)}}
}
