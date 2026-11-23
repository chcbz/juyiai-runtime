import { constants as fs } from 'node:fs'
import { open, realpath, lstat, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { skillCanonicalJson, skillDigest } from './skill-executor.mjs'

const bad = code => { throw Object.assign(new Error(code), { code }) }
export const directory = async path => {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.uid !== process.geteuid() || (stat.mode & 0o077) || await realpath(path) !== path) bad('METERED_CAPTURE_DIRECTORY_UNSAFE')
}
export const syncDir = async path => {
  const handle = await open(path, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
// Keys are unique within a newly claimed epoch; there is no reopen-for-writing path.
export async function persist(dir, key, value) {
  await directory(dir)
  const tmp = resolve(dir, `tmp-${randomUUID()}`), dest = resolve(dir, `${key}.json`)
  const file = await open(tmp, fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW, 0o600)
  try {
    try { await file.writeFile(skillCanonicalJson(value)); await file.sync() } finally { await file.close() }
    await rename(tmp, dest); await syncDir(dir)
  } finally { await unlink(tmp).catch(err => { if (err.code !== 'ENOENT') throw err }) }
}
export const first = (binding, kind, identity, observation, clock, previous = null) => {
  const observedAt = clock()
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) bad('METERED_CAPTURE_CLOCK_INVALID')
  const evidence = { schemaVersion: 2, ...binding, kind, recordId: skillDigest(['USAGE_RECORD_V2', binding.captureId, kind, identity]),
    sourceRevision: previous ? String(BigInt(previous.sourceRevision)+1n) : '1', previousEvidenceSha256: previous?.evidenceSha256 ?? null, observedAt, observation }
  const evidenceSha256 = skillDigest(evidence)
  const expectedRevision = kind === 'RESPONSE' ? '0' : null
  return { ...evidence, evidenceSha256, receiptId: skillDigest(['USAGE_RECEIPT_V2', evidenceSha256, expectedRevision]), expectedRevision }
}

// Read only single-link, owner-private regular files under the authenticated execution directory.
export async function readPrivate(dir, key) {
  await directory(dir)
  const file=await open(resolve(dir,`${key}.json`),fs.O_RDONLY|fs.O_NOFOLLOW|fs.O_NONBLOCK)
  try {
    const stat=await file.stat({bigint:true})
    if(!stat.isFile() || stat.nlink!==1n || stat.uid!==BigInt(process.geteuid()) || (stat.mode&0o077n)) bad('METERED_CAPTURE_FILE_UNSAFE')
    const bytes=await file.readFile(),after=await file.stat({bigint:true})
    if(BigInt(bytes.length)!==stat.size || after.ctimeNs!==stat.ctimeNs || after.mtimeNs!==stat.mtimeNs)bad('METERED_CAPTURE_FILE_CHANGED')
    return JSON.parse(bytes.toString('utf8'))
  }finally{await file.close()}
}
