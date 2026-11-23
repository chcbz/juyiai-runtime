/** Source-side only. The owner must hold the original execution writer fence.
 * No provider URL, credential, prompt, response body or replay callback is stored. */
import { mkdir, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { skillDigest, skillId, skillSha } from './skill-executor.mjs'
import { first, persist, directory, syncDir } from './metered-capture-files.mjs'
import { recoverStoppedMeteredRoot } from './metered-capture-closure.mjs'
const bad = code => { throw Object.assign(new Error(code), {code}) }
const checkId = id => { if(!skillId(id)) bad('METERED_CAPTURE_ID_INVALID'); return id }
/** Start only a NEW RESPONSE_V2 run, before spawning the engine. Existing plan is recovery work, never dispatch authority. */
export async function startMeteredRoot(store, { executionId, runId, executionConfigSha256, engineVersion, coveragePolicyVersion,
  rootSourceId, channelNamespace, adapterVersion, checkActive, now = Date.now }) {
  if (store.command.executionId !== checkId(executionId) || store.command.runId !== checkId(runId)
      || store.command.usageMode !== 'RESPONSE_V2' || store.command.captureProtocol !== 'METERED_CAPTURE_V2'
      || !skillSha(executionConfigSha256) || typeof checkActive !== 'function') bad('METERED_CAPTURE_BINDING_INVALID')
  for (const id of [runId, engineVersion, coveragePolicyVersion, rootSourceId, channelNamespace, adapterVersion]) checkId(id)
  const binding = { executionId, runId, captureId: skillDigest(['CAPTURE_V2', executionId, runId]) }
  const dir = resolve(store.directory, `usage-capture-${binding.captureId}`)
  checkActive(); await directory(store.directory)
  // EEXIST (even a crash before PLAN) must not allow a second live writer or erase evidence.
  await mkdir(dir, { mode: 0o700 }); await syncDir(store.directory)
  const plan = first(binding, 'PLAN', [], { captureProtocol: 'METERED_CAPTURE_V2', executionConfigSha256,
    engineVersion, coveragePolicyVersion, rootSourceId }, now)
  await persist(dir, 'plan', plan)
  const epoch = '0', sourceId = rootSourceId
  const source = first(binding, 'SOURCE', [sourceId, epoch], { sourceId, epoch, sourceKind: 'METERED_HTTP_RESPONSES_V1',
    adapterVersion, channelNamespace, parentSourceRecordId: null, previousEpochSourceRecordId: null }, now)
  await persist(dir, 'source-0', source); checkActive()
  let next = 0n, stopped = false, inflight=0, drained, wake, writeFailed=false
  let sealing, watermark
  async function markStopped(assertStopped) {
    await assertStopped(); stopped=true
    if(inflight)await (drained??=new Promise(resolve=>{wake=resolve}))
    await assertStopped()
    // A stopped recovery may have already closed the source incomplete. Never rewrite its decision.
    return watermark??=(async()=>{
      const sealed=await lstat(resolve(dir,'source-final-1.json')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error})
      if(!sealed)await persist(dir,'producer-stopped',{...binding,reservedHigh:String(next),writeFailed})
    })().catch(error=>{watermark=null;throw error})
  }
  return Object.freeze({ ...binding, textTokenProtocol:engineVersion==='codex-cli-0.167.0' && adapterVersion==='RESPONSES_TEXT_TOKENS_V1' && coveragePolicyVersion==='TEXT_MODEL_ONLY_V1', stopAdmission() { stopped = true },
    async stopAndDrain(){stopped=true;if(inflight)await (drained??=new Promise(resolve=>{wake=resolve}));if(writeFailed)bad('METERED_CAPTURE_WRITE_INCOMPLETE')},
    // Called only after the owner has joined the engine and closed the egress. No re-opening after this point.
    markStopped,
    sealStopped(assertStopped) {
      return sealing??=(async()=>{
        await markStopped(assertStopped)
        return recoverStoppedMeteredRoot(store,assertStopped,now)
      })().catch(error=>{sealing=null;throw error})
    },
    // Only the actual egress handler may supply send; call it after checking the live fence again.
    async dispatch(send) {
      if (stopped || typeof send !== 'function') bad('METERED_CAPTURE_ADMISSION_CLOSED')
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
