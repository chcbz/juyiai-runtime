import { retainedDiscussionSource } from './metered-request-capture.mjs'
import { verifySealedSubject } from './metered-capture-closure.mjs'
/** Deliver immutable source files only. No engine, wallet or model dependency. The stopped
 * caller verifies closure under its existing writer fence before asking for a final ACK audit. */
import { mkdir,readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { rootEpochDirectories,directory,persist,readPrivate,syncDir } from './metered-capture-files.mjs'
import { skillDigest } from './skill-executor.mjs'
const sha=/^[0-9a-f]{64}$/
const entries=[['PLAN',/^plan$/],['SOURCE',/^source-(0|[1-9][0-9]*)$/],['REQUEST',/^request-([1-9][0-9]*)-([12])$/],['RESPONSE',/^response-([0-9a-f]{64})-1$/],['SOURCE_FINAL',/^source-final-1$/],['CAPTURE_FINAL',/^capture-final-1$/]]
const bad=()=>{throw Object.assign(new Error('METERED_USAGE_RECEIPT_CONFLICT'),{code:'METERED_USAGE_RECEIPT_CONFLICT'})}
const exact=(o,keys)=>o&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k))
function validateAck(a,e){
  if(!exact(a,['schemaVersion','executionId','runId','captureId','receiptId','recordId','sourceRevision','evidenceSha256','acceptedAt','acceptance','ledger']) ||
    !['schemaVersion','executionId','runId','captureId','receiptId','recordId','sourceRevision','evidenceSha256'].every(k=>a[k]===e[k])||
    a.acceptance!=='DURABLE'||!Number.isSafeInteger(a.acceptedAt)||a.acceptedAt<0)bad()
  const l=a.ledger
  if(e.kind!=='RESPONSE'){if(l!==null)bad();return}
  if(!exact(l,['attemptId','revision','status','costYuan'])||l.attemptId!==skillDigest(['NATIVE_RESPONSE_USAGE',e.observation.sourceAttemptId])||
    typeof l.revision!=='string'||!/^([1-9][0-9]*)$/.test(l.revision)||BigInt(l.revision)!==BigInt(e.expectedRevision)+1n||
    !['PRICED','PENDING_USAGE','PENDING_PRICE'].includes(l.status)||(l.status==='PRICED'?typeof l.costYuan!=='string'||!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(l.costYuan):l.costYuan!==null))bad()
}
export function meteredBatch(){return {left:8,until:Date.now()+3000}}
// Chat verifies immutable files before and between calls. Only time inside a network
// attempt spends this allowance; receipt lookup after an ambiguous POST spends it too.
export function discussionBatch(now=()=>performance.now()){
  let remaining=3000
  return {left:8, remaining:()=>remaining, async measure(send){
    const start=now()
    try{return await send()}finally{remaining=Math.max(0,remaining-(now()-start))}
  }}
}
const remainingMs=batch=>batch.remaining?batch.remaining():batch.until-Date.now()
export async function deliverMetered(store,request,batch,sealed=false){
  const {executionId,runId}=store.command
  return deliverSubject(store.directory,executionId,runId,`/internal/agent/executions/${executionId}/runs/${runId}/usage`,request,batch,sealed)
}
export async function deliverDiscussionMetered(inbox,key,scope,request,batch,onSealed){
  return visitDiscussion(inbox,key,scope,{request,batch,onSealed})
}
// Per-source evidence only. The caller supplies the original scoped inbox and separately
// fences admission/writers. Never open a session, deliver a request or manufacture an ACK.
export function inspectDiscussionReceipts(inbox,key,scope,onSealedId){return visitDiscussion(inbox,key,scope,null,onSealedId)}
async function visitDiscussion(inbox,key,scope,delivery,onSealedId){
  const {parent,facts,subject}=await retainedDiscussionSource(inbox,key)
  if(!scope || scope.agentId!==facts.targetAgentId || scope.clientId!==facts.clientId || scope.tenantId!==facts.tenantId)bad()
  // This one audit already reads and verifies each original. Keep only the ACK comparison
  // fields for this pass; no observations/bodies on the retry queue or across calls.
  const expectations=new Map()
  const marker=await verifySealedSubject(parent,subject,r=>{
    const {recordId,sourceRevision,receiptId,evidenceSha256,kind}=r
    const epoch=r.observation.epoch??'0'
    const key=kind==='REQUEST'?`request-${r.observation.sequence}-${sourceRevision}`:kind==='RESPONSE'?`response-${r.observation.sourceAttemptId}-1`:
      kind==='SOURCE'?`source-${epoch}`:kind==='SOURCE_FINAL'?'source-final-1':kind==='CAPTURE_FINAL'?'capture-final-1':'plan'
    // Copy verified SHA bytes; retaining slices of parsed JSON strings can keep their larger
    // backing strings alive. All other ACK fields come from the verified subject and file key.
    expectations.set(epoch==='0'?key:`epoch-${epoch}-${key}`,Buffer.from(recordId+receiptId+evidenceSha256,'hex'))
  }), {executionId,runId,snapshotDigest}=subject
  onSealedId?.(marker.captureId)
  delivery?.onSealed?.(marker)
  const path=`/internal/agent/chat/dispatches/${runId}/turns/${executionId}/contexts/${snapshotDigest}/captures/${marker.captureId}/usage`
  return deliverSubject(parent,executionId,runId,path,delivery?.request,delivery?.batch,true,expectations,delivery===null)
}
async function deliverSubject(parent,executionId,runId,path,request,batch,sealed,expectations,inspect=false){
  const captureId=skillDigest(['CAPTURE_V2',executionId,runId]),src=resolve(parent,`usage-capture-${captureId}`),acks=resolve(parent,`usage-acks-${captureId}`)
  await directory(parent)
  try{await directory(src)}catch(e){if(!sealed&&e.code==='ENOENT')return false;throw e}
  if(!inspect)try{await mkdir(acks,{mode:0o700});await syncDir(parent)}catch(e){if(e.code!=='EEXIST')throw e}
  let saved=new Set()
  try{await directory(acks);saved=new Set(await readdir(acks))}catch(e){if(!inspect||e.code!=='ENOENT')throw e}
  const epochs=await rootEpochDirectories(src);let pending=false
  for(const entry of epochs)entry.keys=entry.names.filter(n=>n.endsWith('.json')).map(n=>n.slice(0,-5)).sort()
  let checked=0
  for(const [kind,pattern] of entries)for(const entry of epochs)for(const key of entry.keys){
    const match=pattern.exec(key);if(!match)continue
    const global=kind==='PLAN'||kind==='CAPTURE_FINAL';if((global&&entry.epoch!=='0')||(kind==='SOURCE'&&match[1]!==entry.epoch))bad()
    const ackKey=entry.epoch==='0'?key:`epoch-${entry.epoch}-${key}`
    const has=saved.has(`${ackKey}.json`);if(has&&!sealed)continue
    const audited=expectations?.get(ackKey)
    if(expectations){if(!audited)bad();checked++}
    if(has&&audited){
      validateAck(await readPrivate(acks,ackKey),{schemaVersion:2,executionId,runId,captureId,kind,
        recordId:audited.toString('hex',0,32),receiptId:audited.toString('hex',32,64),evidenceSha256:audited.toString('hex',64,96),
        sourceRevision:kind==='REQUEST'?match[2]:'1',expectedRevision:kind==='RESPONSE'?'0':null,
        observation:kind==='RESPONSE'?{sourceAttemptId:match[1]}:null});continue
    }
    if(!has&&inspect){pending=true;continue} // Audit the other saved ACKs even if an earlier one is missing.
    if(!has&&(batch.left<=0||remainingMs(batch)<=0))return false
    const raw=await readPrivate(entry.dir,key),{receiptId,expectedRevision,evidenceSha256,...e}=raw
    if(audited&&raw.receiptId!==audited.toString('hex',32,64))bad()
    const o=e.observation,identity=kind==='PLAN'||kind==='CAPTURE_FINAL'?[]:kind==='RESPONSE'?[match[1]]:kind==='REQUEST'?[o.sourceId,o.epoch,match[1]]:[o.sourceId,o.epoch]
    if((!global&&o.epoch!==entry.epoch)||e.kind!==kind||e.schemaVersion!==2||e.executionId!==executionId||e.runId!==runId||e.captureId!==captureId||e.sourceRevision!==(kind==='REQUEST'?match[2]:'1')||
      e.recordId!==skillDigest(['USAGE_RECORD_V2',captureId,kind,identity])||!sha.test(evidenceSha256)||skillDigest(e)!==evidenceSha256||
      expectedRevision!==(kind==='RESPONSE'?'0':null)||receiptId!==skillDigest(['USAGE_RECEIPT_V2',evidenceSha256,expectedRevision]))bad()
    if(has){validateAck(await readPrivate(acks,ackKey),raw);continue}
    const send=(url,method,body)=>{
      const ms=remainingMs(batch)
      if(ms<=0||batch.left<=0)throw new Error('METERED_DELIVERY_BUDGET_EXHAUSTED')
      batch.left--
      const invoke=()=>request(url,method,body,[200],{requestId:receiptId,callId:receiptId,signal:AbortSignal.timeout(Math.ceil(ms))})
      return batch.measure?batch.measure(invoke):invoke()
    }
    let ack
    try{ack=await send(path,'POST',raw)}
    catch(error){
      // Read only the same submission, never mint a new retry identity.
      if(error.code!=='SKILL_TRANSPORT_UNKNOWN'||batch.left<=0||remainingMs(batch)<=0)throw error
      ack=await send(`${path}/receipts/${receiptId}`,'GET',undefined)
    }
    validateAck(ack,raw);await persist(acks,ackKey,ack)
  }
  if(expectations&&checked!==expectations.size)bad() // A file disappeared after seal verification.
  return !pending&&sealed&&epochs[0].keys.includes('plan')&&epochs[0].keys.includes('capture-final-1')&&
    epochs.every(e=>e.keys.includes(`source-${e.epoch}`)&&e.keys.includes('source-final-1'))
}
