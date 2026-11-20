/** Execution-bound domain transport. Write and receipt routes require an explicit installation grant. */
import { createServer } from 'node:http'
import { constants, chmodSync, closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { openAsBlob } from 'node:fs'
import { join } from 'node:path'

export const BUSINESS_API_SOCKET = '/business-api.sock'
export async function openBusinessSocket(parent, exchange, { write = false } = {}) {
  const directory = mkdtempSync(join(parent, '.business-api-'))
  const socket = join(directory, 'api.sock')
  // sockaddr_un is short even when the trusted execution store has a long absolute path.
  const fd = openSync(directory, constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let closed = false, receivingFile = false
  const lifetime = new AbortController()
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000 }, async (req, res) => {
    const reply = (status, value) => { if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' }).end(JSON.stringify(value)) }
    let temp, handle
    try {
      const route = /^\/([a-z][a-z0-9-]{0,63})\/(lookup|commit|receipt)$/.exec(req.url)
      if (!route || req.method !== 'POST' || (route[2] !== 'lookup' && !write)) return reply(404, { error: 'READ_RESOURCE_REQUIRED' })
      const binary = req.headers['content-type'] === 'application/octet-stream'
      if (binary && route[2] !== 'commit') return reply(415, {error:'JSON_REQUIRED'})
      if (!binary && req.headers['content-type'] !== 'application/json') return reply(415, {error:'JSON_REQUIRED'})
      const chunks = []; let size = 0, metadataRemaining = 0
      if (binary) {
        const n = req.headers['x-cyf-metadata-length'], total = req.headers['content-length']
        if (!/^[1-9]\d{0,4}$/.test(n) || Number(n)>65536 || !/^[1-9]\d{0,8}$/.test(total) || Number(total)<=Number(n)) return reply(400,{error:'INVALID_LENGTH'})
        if (Number(total)-Number(n)>16*1024*1024) return reply(413,{error:'REQUEST_TOO_LARGE'})
        if (receivingFile) return reply(409,{error:'ATTACHMENT_BUSY'})
        receivingFile=true;metadataRemaining=Number(n);temp=join(directory,'attachment');handle=await open(temp,'wx',0o600)
      }
      for await (const chunk of req) {
        size+=chunk.length
        if (!binary) {
          if(size>65536)return reply(413,{error:'REQUEST_TOO_LARGE'})
          chunks.push(chunk);continue
        }
        const n=Math.min(metadataRemaining,chunk.length);if(n)chunks.push(chunk.subarray(0,n));metadataRemaining-=n
        if(n<chunk.length)await handle.writeFile(chunk.subarray(n))
      }
      if (binary) {await handle.close();handle=null;if(size!==Number(req.headers['content-length']))return reply(400,{error:'INVALID_LENGTH'})}
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString()) } catch { return reply(400, { error: 'INVALID_JSON' }) }
      if (!data || Array.isArray(data) || typeof data !== 'object' || Object.hasOwn(data, 'fence') || Object.hasOwn(data, 'snapshotSha256')) return reply(400, { error: 'INVALID_QUERY' })
      lifetime.signal.throwIfAborted()
      const value = await exchange(route[1], data, lifetime.signal, route[2], binary ? await openAsBlob(temp) : undefined)
      if (!closed) reply(200, value)
    } catch (err) { reply([400,403,404,409].includes(err?.status) ? err.status : 503, { error: 'LOOKUP_UNAVAILABLE' }) }
    finally { if(temp){try{await handle?.close()}finally{rmSync(temp,{force:true});receivingFile=false}} }
  })
  server.maxConnections = 8
  const dispose = () => {
    if (closed) return
    closed = true; lifetime.abort(); server.close(); server.closeAllConnections(); closeSync(fd); rmSync(directory, { recursive: true, force: true })
  }
  try {
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(`/proc/self/fd/${fd}/api.sock`, ok) })
    chmodSync(socket, 0o600)
    return { socket, dispose }
  } catch (err) { dispose(); throw err }
}
