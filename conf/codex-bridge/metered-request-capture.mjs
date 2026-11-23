/** Source-side only. The owner must hold the original execution writer fence.
 * No provider URL, credential, prompt, response body or replay callback is stored. */
import { constants as fs } from 'node:fs'
import { open, realpath, lstat, rename, unlink, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { skillCanonicalJson, skillDigest, skillId, skillSha } from './skill-executor.mjs'

const bad = code => { throw Object.assign(new Error(code), { code }) }
const checkId = id => { if (!skillId(id)) bad('METERED_CAPTURE_ID_INVALID'); return id }
const directory = async path => {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.uid !== process.geteuid() || (stat.mode & 0o077) || await realpath(path) !== path) bad('METERED_CAPTURE_DIRECTORY_UNSAFE')
}
const syncDir = async path => {
  const handle = await open(path, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
// Keys are unique within a newly claimed epoch; there is no reopen-for-writing path.
async function persist(dir, key, value) {
  await directory(dir)
  const tmp = resolve(dir, `tmp-${randomUUID()}`), dest = resolve(dir, `${key}.json`)
  const file = await open(tmp, fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW, 0o600)
  try {
    try { await file.writeFile(skillCanonicalJson(value)); await file.sync() } finally { await file.close() }
    await rename(tmp, dest); await syncDir(dir)
  } finally { await unlink(tmp).catch(err => { if (err.code !== 'ENOENT') throw err }) }
}
const first = (binding, kind, identity, observation, clock, previous = null) => {
  const observedAt = clock()
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) bad('METERED_CAPTURE_CLOCK_INVALID')
  const evidence = { schemaVersion: 2, ...binding, kind, recordId: skillDigest(['USAGE_RECORD_V2', binding.captureId, kind, identity]),
    sourceRevision: previous ? String(BigInt(previous.sourceRevision)+1n) : '1', previousEvidenceSha256: previous?.evidenceSha256 ?? null, observedAt, observation }
  const evidenceSha256 = skillDigest(evidence)
  const expectedRevision = kind === 'RESPONSE' ? '0' : null
  return { ...evidence, evidenceSha256, receiptId: skillDigest(['USAGE_RECEIPT_V2', evidenceSha256, expectedRevision]), expectedRevision }
}

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
  return Object.freeze({ ...binding, textTokenProtocol:engineVersion==='codex-cli-0.167.0' && adapterVersion==='RESPONSES_TEXT_TOKENS_V1' && coveragePolicyVersion==='TEXT_MODEL_ONLY_V1', stopAdmission() { stopped = true },
    async stopAndDrain(){stopped=true;if(inflight)await (drained??=new Promise(resolve=>{wake=resolve}));if(writeFailed)bad('METERED_CAPTURE_WRITE_INCOMPLETE')},
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
