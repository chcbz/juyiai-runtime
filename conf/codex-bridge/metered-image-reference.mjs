// Reference, not another usage record: the provider ledger owns normalization and price.
import { readPrivate } from './metered-capture-files.mjs'
import { skillDigest, skillSha } from './skill-executor.mjs'
const optional = async (dir,key) => {try{return await readPrivate(dir,key)}catch(e){if(e.code==='ENOENT')return null;throw e}}
export async function meteredImageReference(dir,{executionId,runId,snapshotDigest}) {
  const r=await optional(dir,'native-image-start')
  if(!r || r.executionId!==executionId || r.runId!==runId || r.snapshotDigest!==snapshotDigest || !skillSha(r.childRouteSha256)
      || typeof r.invocationId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.invocationId))return null
  const [binding,start,end]=await Promise.all(['native-image-binding',...['started','terminal'].map(p=>`provider-usage-${r.invocationId}-${p}`)].map(key=>optional(dir,key)))
  if(!binding || !['generate','edit'].includes(binding.operation) || !skillSha(binding.packageSha256) || !start || !end || start.phase!=='STARTED' || start.evidence!==null || end.phase!=='TERMINAL'
      || !end.evidence?.providerRequestId || !end.evidence.usage || end.operation!==binding.operation || end.invocationId!==r.invocationId || end.schemaVersion!==1 || end.protocol!=='openai-images-v1'
      || ['schemaVersion','protocol','invocationId','operation','channel','tier','requestedModel','priceVersion'].some(k=>end[k]!==start[k])) return null
  return {invocationId:r.invocationId,operation:binding.operation,childRouteSha256:r.childRouteSha256,startedSha256:skillDigest(start),terminalSha256:skillDigest(end)}
}

// The capture ACK and the provider ledger ACK are separate. Before publishing a new
// final, verify both original child receipts. Absence is retryable without re-execution.
export async function imagePhasesAcknowledged(dir,executionId,ref){
  const id=ref.invocationId
  const conflict=()=>{throw Object.assign(Error('METERED_USAGE_RECEIPT_CONFLICT'),{code:'METERED_USAGE_RECEIPT_CONFLICT'})}
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))conflict()
  const attempt=skillDigest(['NATIVE_PROVIDER_CALL',`${executionId}:${id}`])
  for(const [phase,revision,digest] of [['started','1',ref.startedSha256],['terminal','2',ref.terminalSha256]]){
    const key=`provider-usage-${id}-${phase}`
    const receipt=await optional(dir,`${key}-receipt`)
    if(!receipt)return false
    const observation=await readPrivate(dir,key)
    if(observation.invocationId!==id||observation.phase!==phase.toUpperCase()||skillDigest(observation)!==digest||
      receipt.executionId!==executionId||receipt.revision!==revision||receipt.attemptId!==attempt||
      receipt.evidenceSha256!==skillDigest({executionId,observation}))conflict()
  }
  // Receipt proves acceptance only. The API reads authoritative normalized quantities;
  // a durable PENDING_USAGE is not a measured sample and must never imply zero cost.
  return true
}
