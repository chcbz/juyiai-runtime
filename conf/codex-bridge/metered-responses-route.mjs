// Runtime-owned, fixed-destination streaming adapter. No redirects, header copying,
// body logs or automatic retries. Coverage remains pending until source closure.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { requestCostScope } from './metered-request-scope.mjs'
import { observeResponse } from './metered-response-observation.mjs'
import { pipeline } from 'node:stream/promises'

const deny = (res, status) => {
  if (res.destroyed) return
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { Connection: 'close', 'Cache-Control': 'no-store' }); res.end()
}
const one = (req, name) => req.headersDistinct[name]?.length === 1 ? req.headersDistinct[name][0] : null
export class MeteredResponsesRoute {
  #temporary = randomBytes(32).toString('hex'); #capture; #localArtifactCall; #upstream; #key; #ca
  constructor(baseUrl, { capture, getProviderKey, ca, localArtifactCall }) {
    const url = new URL(baseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        typeof capture?.dispatch !== 'function' || typeof capture.stopAdmission !== 'function' || typeof getProviderKey !== 'function') throw Error('METERED_ROUTE_CONFIG_INVALID')
    url.pathname = `${url.pathname.replace(/\/$/, '')}/responses`
    this.#localArtifactCall=localArtifactCall; this.#capture = capture; this.#upstream = url; this.#key = getProviderKey; this.#ca = ca
  }
  // Opaque token is only for the isolated HOME of this run, not metrics or argv.
  sandboxToken() { if (!this.#temporary) throw Error('METERED_ROUTE_CLOSED'); return this.#temporary }
  close() { this.#temporary = null; this.#capture.stopAdmission() }
  async handle(req, res, { authority, assertOwner, signal, connectTimeoutMs }) {
    if (req.method !== 'POST' || req.url !== '/v1/responses' || one(req,'host') !== authority ||
        one(req,'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || req.headers['content-encoding']) return deny(res, 400)
    const received = Buffer.from(one(req,'authorization') || ''), expected = Buffer.from(`Bearer ${this.#temporary}`)
    if (!this.#temporary || received.length !== expected.length || !timingSafeEqual(received, expected)) return deny(res, 403)
    const aborted = new AbortController(), abort = () => aborted.abort()
    res.once('close', abort); signal.addEventListener('abort', abort, {once:true})
    const active = () => { if (!this.#temporary || signal.aborted || aborted.signal.aborted || res.destroyed) throw Error('METERED_ROUTE_CLOSED') }
    try {
      active(); await assertOwner(); active()
      const key = this.#key()
      if (typeof key !== 'string' || !key || /[^\x21-\x7e]/.test(key) || key === this.#temporary) throw Error('METERED_ROUTE_CREDENTIAL_INVALID')
      await this.#capture.dispatch(async (_request, finish) => {
        const scope=requestCostScope(req.readableHighWaterMark,this.#localArtifactCall);let observer, ended=false, uploaded=false
        try {
          active()
          const upstream = httpsRequest(this.#upstream, { method:'POST', agent:false, signal:aborted.signal, ca:this.#ca,
            headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json','Accept':'text/event-stream, application/json', 'Accept-Encoding':'identity'} })
          const timer=setTimeout(()=>upstream.destroy(Error('METERED_CONNECT_TIMEOUT')),connectTimeoutMs)
          upstream.once('socket', s=>s.once('secureConnect',()=>clearTimeout(timer))); upstream.once('close',()=>clearTimeout(timer))
          const response = new Promise((resolve,reject)=>{upstream.once('response',resolve);upstream.once('error',reject);
            upstream.once('upgrade',(_res,socket)=>{socket.destroy();reject(Error('METERED_UPGRADE_REJECTED'))})})
          // Both streams use native backpressure. Do not finish uploading before reading a possible early response.
          await Promise.all([pipeline(req,async function* (source){for await(const bytes of source){scope.push(bytes);yield bytes}uploaded=true},upstream),response.then(async incoming=>{
            const status=incoming.statusCode
            if ((status >= 300 && status < 400) || incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
              incoming.destroy(); deny(res,502); return
            }
            res.writeHead(status, {'Content-Type':incoming.headers['content-type'] || 'application/octet-stream','Cache-Control':'no-store'})
            observer=observeResponse(incoming.headers['content-type'],status,incoming.readableHighWaterMark,this.#capture.textTokenProtocol)
            await pipeline(incoming,async function* (source){ for await(const bytes of source){observer.push(bytes);yield bytes} ended=true },res)
          })])
        } finally {
          // A lost observation must not trigger a model retry after a completed business stream.
          const evidence=observer?.finish(ended) ?? {providerResponseId:null,reportedUsage:null,measuredQuantities:null,actualBillingIdentity:null,reasonCodes:['NO_RESPONSE_EVIDENCE']}
          const reasons=scope.finish(uploaded)
          if(reasons.length){evidence.measuredQuantities=null;evidence.reasonCodes.push(...reasons)}
          await finish(evidence)
        }
      })
    } catch { deny(res,502) } finally { abort(); res.off('close',abort); signal.removeEventListener('abort',abort) }
  }
}
