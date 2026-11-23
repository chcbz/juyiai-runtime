import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMeteredRoot } from '../metered-request-capture.mjs'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { skillDigest } from '../skill-executor.mjs'

const openRoot = async (t, options = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'metered-'))
  t.after(() => rm(directory, {recursive:true, force:true}))
  const store = new SkillExecutionStore({rootDirectory:directory,scope:{tenant:'t',owner:'o'},
    command:{executionProtocolVersion:6,executionId:'exec1',runId:'run1',usageMode:'RESPONSE_V2',captureProtocol:'METERED_CAPTURE_V2',snapshotDigest:'a'.repeat(64)}})
  const args = { executionId:'exec1',runId:'run1',executionConfigSha256:'c'.repeat(64),engineVersion:'engine1',
    coveragePolicyVersion:'TEST_MODEL_ONLY',rootSourceId:'source_model',channelNamespace:'test_gateway',adapterVersion:'FIXTURE',checkActive:()=>{}, ...options }
  const capture = await startMeteredRoot(store, args)
  const dir = join(store.directory, `usage-capture-${capture.captureId}`)
  const read = async key => JSON.parse(await readFile(join(dir, `${key}.json`)))
  return {capture, store, args, dir, read}
}
test('concurrent sends see private, durable PENDING observations linked to the original run', async t => {
  const {capture,dir,read} = await openRoot(t)
  const plan=await read('plan'), source=await read('source-0')
  assert.equal(plan.captureId,skillDigest(['CAPTURE_V2','exec1','run1']))
  assert.equal(source.observation.sourceId,plan.observation.rootSourceId)
  const ids=await Promise.all(Array.from({length:8},()=>capture.dispatch(async request=>{
    const r=await read(`request-${request.sequence}-1`)
    assert.deepEqual(await read(`reserved-${request.sequence}`),{sequence:request.sequence})
    assert.equal(r.observation.resolution,'PENDING'); assert.equal(r.observation.sourceAttemptId,null)
    assert.equal(r.recordId,skillDigest(['USAGE_RECORD_V2',plan.captureId,'REQUEST',['source_model','0',request.sequence]]))
    const {receiptId,expectedRevision,evidenceSha256,...evidence}=r
    assert.equal(skillDigest(evidence),request.evidenceSha256); assert.equal(request.attemptId,r.observation.attemptId)
    return request.attemptId
  })))
  assert.equal(new Set(ids).size,8)
  for(const name of await readdir(dir)) assert.equal((await lstat(join(dir,name))).mode & 0o777,0o600)
})
test('failed REQUEST prewrite keeps reservation, sends nothing and cannot reopen as a fresh run',async t=>{
  const {capture,dir,read,store,args}=await openRoot(t); let sends=0
  await mkdir(join(dir,'request-1-1.json')) // actual rename failure after watermark is durable
  await assert.rejects(capture.dispatch(()=>sends++)); assert.equal(sends,0)
  assert.deepEqual(await read('reserved-1'),{sequence:'1'})
  await assert.rejects(capture.dispatch(()=>sends++),{code:'METERED_CAPTURE_ADMISSION_CLOSED'})
  await assert.rejects(startMeteredRoot(store,args),{code:'EEXIST'}); assert.equal(sends,0)
})
test('revoked after prewrite leaves unresolved evidence and cannot call upstream',async t=>{
  let checks=0,sends=0; const {capture,read}=await openRoot(t,{checkActive:()=>{if(++checks===4)throw Error('revoked')}})
  await assert.rejects(capture.dispatch(()=>sends++),/revoked/); assert.equal(sends,0)
  assert.equal((await read('request-1-1')).observation.resolution,'PENDING')
})

test('does not invent a plan for another run or a legacy command',async t=>{
  const {store,args}=await openRoot(t)
  await assert.rejects(startMeteredRoot(store,{...args,runId:'other'}),{code:'METERED_CAPTURE_BINDING_INVALID'})
  await assert.rejects(startMeteredRoot({directory:store.directory,command:{executionId:'exec1',runId:'run1'}},args),{code:'METERED_CAPTURE_BINDING_INVALID'})
})
