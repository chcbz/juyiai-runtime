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
export async function deliverMetered(store,request,batch,sealed=false){
  const {executionId,runId}=store.command,captureId=skillDigest(['CAPTURE_V2',executionId,runId]);const src=resolve(store.directory,`usage-capture-${captureId}`),acks=resolve(store.directory,`usage-acks-${captureId}`)
  await directory(store.directory)
  try{await directory(src)}catch(e){if(!sealed&&e.code==='ENOENT')return false;throw e}
  try{await mkdir(acks,{mode:0o700});await syncDir(store.directory)}catch(e){if(e.code!=='EEXIST')throw e}
  await directory(acks);const saved=new Set(await readdir(acks)),epochs=await rootEpochDirectories(src)
  for(const entry of epochs)entry.keys=entry.names.filter(n=>n.endsWith('.json')).map(n=>n.slice(0,-5)).sort()
  for(const [kind,pattern] of entries)for(const entry of epochs)for(const key of entry.keys){
    const match=pattern.exec(key);if(!match)continue
    const global=kind==='PLAN'||kind==='CAPTURE_FINAL';if((global&&entry.epoch!=='0')||(kind==='SOURCE'&&match[1]!==entry.epoch))bad()
    const ackKey=entry.epoch==='0'?key:`epoch-${entry.epoch}-${key}`
    const has=saved.has(`${ackKey}.json`);if(has&&!sealed)continue
    if(!has&&(batch.left<=0||Date.now()>=batch.until))return false
    const raw=await readPrivate(entry.dir,key),{receiptId,expectedRevision,evidenceSha256,...e}=raw
    const o=e.observation,identity=kind==='PLAN'||kind==='CAPTURE_FINAL'?[]:kind==='RESPONSE'?[match[1]]:kind==='REQUEST'?[o.sourceId,o.epoch,match[1]]:[o.sourceId,o.epoch]
    if((!global&&o.epoch!==entry.epoch)||e.kind!==kind||e.schemaVersion!==2||e.executionId!==executionId||e.runId!==runId||e.captureId!==captureId||e.sourceRevision!==(kind==='REQUEST'?match[2]:'1')||
      e.recordId!==skillDigest(['USAGE_RECORD_V2',captureId,kind,identity])||!sha.test(evidenceSha256)||skillDigest(e)!==evidenceSha256||
      expectedRevision!==(kind==='RESPONSE'?'0':null)||receiptId!==skillDigest(['USAGE_RECEIPT_V2',evidenceSha256,expectedRevision]))bad()
    if(has){validateAck(await readPrivate(acks,ackKey),raw);continue}
    const path=`/internal/agent/executions/${executionId}/runs/${runId}/usage`,call=()=>({requestId:receiptId,callId:receiptId,signal:AbortSignal.timeout(Math.max(1,batch.until-Date.now()))})
    batch.left--;let ack
    try{ack=await request(path,'POST',raw,[200],call())}
    catch(error){
      // Transport loss after commit is ambiguous. Read only the same persisted submission; never mint a retry identity.
      if(error.code!=='SKILL_TRANSPORT_UNKNOWN'||batch.left<=0||Date.now()>=batch.until)throw error
      batch.left--;ack=await request(`${path}/receipts/${receiptId}`,'GET',undefined,[200],call())
    }
    validateAck(ack,raw);await persist(acks,ackKey,ack)
  }
  return sealed&&epochs[0].keys.includes('plan')&&epochs[0].keys.includes('capture-final-1')&&
    epochs.every(e=>e.keys.includes(`source-${e.epoch}`)&&e.keys.includes('source-final-1'))
}
