import { readdir } from 'node:fs/promises'
import { directory } from './metered-capture-files.mjs'
import { deliverDiscussionMetered,meteredBatch } from './metered-usage-delivery.mjs'
import { readNativeJson } from './native-json.mjs'

/** Independent evidence delivery. Never admits a turn, changes a wallet, or retries a model. */
export class ChatUsageDelivery {
  constructor({ inbox, apiOrigin, nativeFetch, scope, now = Date.now }) {
    Object.assign(this, { inbox, apiOrigin, nativeFetch, scope, now })
    this.retries = new Map()
    this.sources=new Map();this.discovered=false
  }
  // The caller owns the stopped subject gate; original session/dispatch attribution is unchanged.
  async flush() {
    const errors = []
    for (let phase = 0; phase < 2; phase++) {
      if (!this.inbox.pendingUsage().length) break
      errors.push(...await this.deliverLegacy())
      if (errors.length) break
    }
    const batch=meteredBatch(),captureStates=[];let outstanding=0
    for(const key of await this.discussionKeys()){
      const state={key,capture:'UNVERIFIED',delivery:'PENDING',coverage:'UNVERIFIED'};captureStates.push(state)
      try{
        const ack=await deliverDiscussionMetered(this.inbox,key,this.scope,this.captureRequest.bind(this),batch,
          marker=>{state.capture='SEALED';state.coverage=marker.closeState==='SEALED_INCOMPLETE'?'INCOMPLETE':'UNVERIFIED'})
        if(ack)state.delivery='ACKNOWLEDGED';else outstanding++
      }catch{outstanding++;errors.push({code:'CHAT_CAPTURE_DELIVERY_PENDING'})}
    }
    const pending = outstanding+this.inbox.pendingUsage().length
    return { confirmed: !errors.length && !pending, pending, errors, ...(captureStates.length?{captureStates}:{}) }
  }
  async discussionKeys(){
    try{await directory(this.inbox.dir)}catch(error){if(error.code==='ENOENT')return [];throw error}
    return (await readdir(this.inbox.dir,{withFileTypes:true})).filter(e=>e.name.startsWith('discussion-source-')).map(e=>{
      const key=e.name.slice('discussion-source-'.length)
      if(!e.isDirectory() || !/^[a-f0-9]{64}$/.test(key))throw new Error('CHAT_CAPTURE_SOURCE_INVALID')
      return key
    })
  }
  // nativeFetch supplies the authenticated envelope and session fence; a response is never an execution retry.
  async captureRequest(path,method,body,statuses,call){
    const ep=new URL(path,this.apiOrigin),headers={Accept:'application/json','X-Request-Id':call.requestId}
    if(method==='POST')Object.assign(headers,{'Content-Type':'application/json','Idempotency-Key':call.callId})
    let response
    try{response=await this.nativeFetch(ep,{method,headers,redirect:'error',cache:'no-store',signal:call.signal,
      ...(body===undefined?{}:{body:JSON.stringify(body)})})}
    catch(e){if(e instanceof TypeError && !e.code)throw Object.assign(Error('CHAT_TRANSPORT_UNKNOWN'),{code:'SKILL_TRANSPORT_UNKNOWN'});throw e}
    if(!statuses.includes(response?.status)||response.redirected||response.url!==ep.href||response.headers.get('X-Request-Id')!==call.requestId){
      await response?.body?.cancel?.().catch(()=>{});throw new Error('CHAT_CAPTURE_HTTP_UNCONFIRMED')}
    return readNativeJson(response)
  }
  nextRecoveryAt() {
    let due=Infinity;for(const at of this.sources.values())due=Math.min(due,at)
    return this.inbox.pendingUsage().reduce((next, item) => Math.min(next,
      this.retries.get(item.key)?.at ?? this.now()), due)
  }
  noteSource(key){this.sources.set(key,this.now())}
  async deliver(){
    const errors=await this.deliverLegacy()
    if(!this.scope)return errors
    if(!this.discovered){for(const key of await this.discussionKeys())this.noteSource(key);this.discovered=true}
    const batch=meteredBatch();let checked=0
    for(const [key,at] of this.sources){
      if(at>this.now())continue
      if(++checked>8 || batch.left===0 || Date.now()>=batch.until)break
      this.sources.delete(key)
      try{if(await deliverDiscussionMetered(this.inbox,key,this.scope,this.captureRequest.bind(this),batch))continue}
      catch{errors.push({code:'CHAT_CAPTURE_DELIVERY_PENDING'})}
      this.sources.set(key,this.now()+5000)
    }
    return errors
  }
  async deliverLegacy() {
    const errors = []
    for (const item of this.inbox.pendingUsage()) {
      const retry = this.retries.get(item.key)
      if (retry?.at > this.now()) continue
      try {
        const endpoint = new URL(`/internal/agent/chat/dispatches/${encodeURIComponent(item.dispatchId)}/usage`, this.apiOrigin)
        const response = await this.nativeFetch(endpoint, { method: 'POST', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(item.payload) })
        if (response?.status !== 200 || response.redirected === true || response.url !== endpoint.href)
          throw new Error('CHAT_USAGE_HTTP_UNCONFIRMED')
        this.inbox.acknowledgeUsage(item, await readNativeJson(response))
        this.retries.delete(item.key)
      } catch {
        const attempt = Math.min((retry?.attempt ?? 0) + 1, 6)
        this.retries.set(item.key, { attempt, at: this.now() + Math.min(30000, 1000 * 2 ** attempt) })
        errors.push({ dispatchId: item.dispatchId, code: 'CHAT_USAGE_DELIVERY_PENDING' })
      }
    }
    return errors
  }
}
