import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, rm, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'

const hash = data => createHash('sha256').update(data).digest('hex')
const entry = /^[0-9a-f]{64}$/
// Private profile directory. Limits govern retention only, never input admission.
export class ChatMaterialByteCache {
  constructor(root, { maxBytes = 256 * 1024 * 1024, maxAge = 24 * 3600 * 1000 } = {}) {
    Object.assign(this, { root, maxBytes, maxAge })
  }
  key(message, agent, instance, digest) {
    return hash(JSON.stringify([message.tenantId, message.clientId, message.ownerJiacn, message.taskId, agent, instance, digest]))
  }
  async has(key) {
    try { const s = await lstat(join(this.root,key)); return s.isFile() && Date.now() - s.mtimeMs < this.maxAge } catch { return false }
  }
  async read(key, source) {
    let file
    try {
      file = await open(join(this.root,key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const s = await file.stat()
      if (!s.isFile() || String(s.size) !== source.byteLength || s.size > this.maxBytes || Date.now() - s.mtimeMs >= this.maxAge) return null
      const bytes = await file.readFile()
      return hash(bytes) === source.sha256 ? bytes : null
    } catch { return null } finally { await file?.close().catch(() => {}) }
  }
  async put(key, bytes) {
    if (bytes.length > this.maxBytes) return
    const temp = join(this.root, `.${key}.${randomUUID()}.tmp`)
    try {
      const file = await open(temp,'wx',0o600)
      try { await file.writeFile(bytes) } finally { await file.close() }
      await rename(temp,join(this.root,key))
    } catch { /* a cache write must not fail an authorized turn */ }
    finally { await rm(temp,{ force:true }).catch(() => {}) }
  }
  async prune() {
    try {
      const files = []
      for (const name of await readdir(this.root)) {
        if (!entry.test(name) && !/^\.[0-9a-f]{64}\.[a-f0-9-]{36}\.tmp$/.test(name)) continue
        const path = join(this.root,name), stat = await lstat(path).catch(() => null)
        if (!stat?.isFile()) continue
        if (Date.now() - stat.mtimeMs >= this.maxAge) await rm(path,{ force:true })
        else if (entry.test(name)) files.push({ path, stat })
      }
      let total = 0
      for (const { path, stat } of files.sort((a,b) => b.stat.mtimeMs - a.stat.mtimeMs)) {
        if (total + stat.size > this.maxBytes) await rm(path,{ force:true }); else total += stat.size
      }
    } catch { /* eviction is best effort */ }
  }
}
