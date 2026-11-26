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
