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
const first = (binding, kind, identity, observation, clock) => {
  const observedAt = clock()
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) bad('METERED_CAPTURE_CLOCK_INVALID')
  const evidence = { schemaVersion: 2, ...binding, kind, recordId: skillDigest(['USAGE_RECORD_V2', binding.captureId, kind, identity]),
    sourceRevision: '1', previousEvidenceSha256: null, observedAt, observation }
  const evidenceSha256 = skillDigest(evidence)
  return { ...evidence, evidenceSha256, receiptId: skillDigest(['USAGE_RECEIPT_V2', evidenceSha256, null]), expectedRevision: null }
}

/** Start only a NEW RESPONSE_V2 run, before spawning the engine. Existing plan is recovery work, never dispatch authority. */
export async function startMeteredRoot(store, { executionId, runId, executionConfigSha256, engineVersion, coveragePolicyVersion,
  rootSourceId, channelNamespace, adapterVersion, checkActive, now = Date.now }) {
  if (store.command.executionId !== checkId(executionId) || !skillSha(executionConfigSha256) || typeof checkActive !== 'function') bad('METERED_CAPTURE_BINDING_INVALID')
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
  let next = 0n, stopped = false
  return Object.freeze({ captureId: binding.captureId, stopAdmission() { stopped = true },
    // Only the actual egress handler may supply send; call it after checking the live fence again.
    async dispatch(send) {
      if (stopped || typeof send !== 'function') bad('METERED_CAPTURE_ADMISSION_CLOSED')
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
      } catch (error) { stopped = true; throw error }
      return send(Object.freeze({ captureId: binding.captureId, sourceId, epoch, sequence, attemptId, evidenceSha256: record.evidenceSha256 }))
    } })
}
