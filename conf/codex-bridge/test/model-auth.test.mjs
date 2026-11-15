import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { serializeModelAuth, validateModelAuth, readModelAuthFile, assertFileAuthConfig, redactModelSecrets } from '../model-auth.mjs'
const auth = { auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-model-independent' }
test('single exact API-key contract; no tokens, environment or mode fallback', () => {
 assert.equal(serializeModelAuth(auth), JSON.stringify(auth)+'\n')
 for (const value of [null, {}, {...auth,tokens:{}}, {...auth,auth_mode:'chatgpt'}, {...auth,OPENAI_API_KEY:' bad'}, {...auth,OPENAI_API_KEY:''}]) assert.throws(()=>validateModelAuth(value),{code:'MODEL_AUTH_INVALID'})
 assert.equal(redactModelSecrets('error '+auth.OPENAI_API_KEY), 'error [REDACTED]')
})
test('owned file descriptor read rejects missing, symlinks, unsafe and malformed files', t => {
 const home=mkdtempSync(resolve(tmpdir(),'model-auth-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const p=resolve(home,'auth.json')
 assert.throws(()=>readModelAuthFile(home),{code:'MODEL_AUTH_REQUIRED'})
 symlinkSync(resolve(home,'missing'),p); assert.throws(()=>readModelAuthFile(home),{code:'MODEL_AUTH_UNSAFE'});rmSync(p)
 writeFileSync(p,serializeModelAuth(auth),{mode:0o600});assert.equal(readModelAuthFile(home).auth.OPENAI_API_KEY,auth.OPENAI_API_KEY)
 chmodSync(p,0o644);assert.throws(()=>readModelAuthFile(home),{code:'MODEL_AUTH_UNSAFE'});chmodSync(p,0o600)
 writeFileSync(p,'not JSON');assert.throws(()=>readModelAuthFile(home),{code:'MODEL_AUTH_INVALID'});rmSync(p);mkdirSync(p)
 assert.throws(()=>readModelAuthFile(home),{code:'MODEL_AUTH_UNSAFE'})
})
test('effective engine config requires file store and excludes alternate credential routing', () => {
 const config={cli_auth_credentials_store:'file',model_provider:'managed',model_providers:{managed:{base_url:'https://example.invalid/v1',wire_api:'responses',requires_openai_auth:true,env_key:null}}}
 assert.doesNotThrow(()=>assertFileAuthConfig({config}))
 for (const field of ['env_key','experimental_bearer_token','auth','gateway_oauth','credential_file','http_headers','env_http_headers']) {
 const changed=structuredClone(config);changed.model_providers.managed[field]='forbidden';assert.throws(()=>assertFileAuthConfig({config:changed}),{code:'MODEL_AUTH_CONFIG_INVALID'})
 }
 assert.throws(()=>assertFileAuthConfig({config:{...config,cli_auth_credentials_store:'auto'}}),{code:'MODEL_AUTH_CONFIG_INVALID'})
})

test('effective file-auth validation precedes provider requests and catalog-only remains credential-free', async () => {
 const { AppServerAdapter } = await import('../app-server-adapter.mjs')
 const config={cli_auth_credentials_store:'file',model_provider:'managed',model_providers:{managed:{base_url:'https://example.invalid/v1',wire_api:'responses',requires_openai_auth:true}}}
 const calls=[];const adapter=Object.assign(Object.create(AppServerAdapter.prototype),{child:{pid:null},readback:{},notify(){},request:async method=>{calls.push(method);return method==='config/read'?{config}:{} }})
 await adapter.initialize({fileAuth:{id:'managed',baseUrl:'https://example.invalid/v1',wireApi:'responses'}})
 assert.ok(calls.indexOf('config/read')<calls.indexOf('model/list'))
 calls.length=0;config.cli_auth_credentials_store='auto';adapter.readback={}
 await assert.rejects(adapter.initialize({fileAuth:null}),{code:'MODEL_AUTH_CONFIG_INVALID'});assert.equal(calls.includes('model/list'),false);assert.equal(calls.includes('account/read'),false)
 calls.length=0;adapter.readback={};await adapter.initialize({catalogOnly:true});assert.deepEqual(calls,['initialize'])
})
