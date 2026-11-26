import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { pendingProviderUsage } from '../provider-usage-receipts.mjs'
import { skillHash } from '../skill-executor.mjs'
import { prepareNativeImageInvocation } from '../native-image-invocation.mjs'

const png = readFileSync(new URL('./fixtures/native-edit-input.png', import.meta.url))
function fixture(t, commandOverrides = {}) {
  const root = mkdtempSync('/var/tmp/cyf-image-invocation-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(resolve(root, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-key' }), { mode: 0o600 })
  const command = { executionProtocolVersion: 6, executionId: 'execution1', snapshotDigest: 'a'.repeat(64), inputRefs: ['image1'], ...commandOverrides }
  const openStore = () => new SkillExecutionStore({ command, rootDirectory: root, scope: { agentId: 'agent1' } })
  const store = openStore()
  const chatProvider = { id: 'chat', baseUrl: 'https://gateway.example/v1', wireApi: 'responses' }
  const configReadback = { config: { cli_auth_credentials_store: 'file', model_provider: chatProvider.id,
    model_providers: { chat: { base_url: chatProvider.baseUrl, wire_api: chatProvider.wireApi, requires_openai_auth: true } } } }
  const request = { store, checkActive() {}, subjectHome: root, chatProvider, configReadback, model: 'image-model', operation: 'generate' }
  return { request, store, openStore }
}
function response(url, b64_json = png.toString('base64')) {
  const res = new Response(JSON.stringify({ model: 'image-fixture', data: [{ b64_json }],
    usage: { input_tokens: 3, output_tokens: 5, input_tokens_details: { text_tokens: 1, image_tokens: 2 }, ignored: 'not evidence' } }),
  { headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'image-req' } })
  Object.defineProperty(res, 'url', { value: url })
  return res
}

test('competing invocations and reopened stores cannot repeat a charged request; evidence uses the existing ordered receipts', async t => {
  const { request, store, openStore } = fixture(t)
  let calls = 0
  const args = { ...request, fetchFn: async url => {
    calls++
    assert.equal(pendingProviderUsage(openStore())[0].payload.observation.phase, 'STARTED')
    return response(url, 'bm90LWEtcG5n')
  } }
  const invoke = prepareNativeImageInvocation(args)
  const results = await Promise.allSettled([invoke({ prompt: 'first' }), invoke({ prompt: 'concurrent' })])
  assert.deepEqual(results.map(r => r.reason.code), ['CONTROLLED_IMAGE_RESPONSE_INVALID', 'NATIVE_IMAGE_ALREADY_STARTED'])
  await assert.rejects(prepareNativeImageInvocation({ ...args, store: openStore() })({ prompt: 'after restart' }), { code: 'NATIVE_IMAGE_ALREADY_STARTED' })
  assert.equal(calls, 1)
  const [start] = pendingProviderUsage(store)
  store.write(start.receiptName, { evidenceSha256: start.evidenceSha256 })
  const [end] = pendingProviderUsage(store)
  assert.equal(end.payload.observation.invocationId, start.payload.observation.invocationId)
  assert.deepEqual(end.payload.observation.evidence, { providerRequestId: 'image-req', responseModel: 'image-fixture',
    usage: { input_tokens: 3, output_tokens: 5, input_tokens_details: { text_tokens: 1, image_tokens: 2 } } })
  store.write(end.receiptName, { evidenceSha256: end.evidenceSha256 })
  assert.deepEqual(pendingProviderUsage(openStore()), [])
})

test('edit verifies authorized frozen input bytes before any reservation or request', async t => {
  const { request, store } = fixture(t)
  const input = { inputRef: 'image1', sha256: skillHash(png), byteLength: String(png.length), contentMimeType: 'image/png' }
  store.write('inputs-snapshot', { inputs: [input] })
  const material = await store.materializeInput(input, async () => [png], () => {})
  let calls = 0
  const args = { ...request, operation: 'edit', fetchFn: async (url, opts) => {
    calls++; assert.equal(url, 'https://gateway.example/v1/images/edits')
    assert.deepEqual(JSON.parse(opts.body).images, [{ image_url: `data:image/png;base64,${png.toString('base64')}` }])
    return response(url)
  } }
  await assert.rejects(prepareNativeImageInvocation({ ...args, inputRefs: ['different'] })({ prompt: 'edit' }), { code: 'SKILL_INPUT_SNAPSHOT_INVALID' })
  const invoke = prepareNativeImageInvocation({ ...args, inputRefs: ['image1'] })
  chmodSync(material.path, 0o600)
  writeFileSync(material.path, Buffer.alloc(png.length))
  await assert.rejects(invoke({ prompt: 'edit' }), { code: 'SKILL_INPUT_BYTES_INVALID' })
  assert.deepEqual(pendingProviderUsage(store), [])
  writeFileSync(material.path, png)
  assert.deepEqual(await invoke({ prompt: 'edit' }), png)
  assert.equal(calls, 1)
})

test('abort after a request starts preserves its uncertainty and never permits a repeat', async t => {
  const { request, store, openStore } = fixture(t)
  const signal = new AbortController()
  let calls = 0
  const args = { ...request, fetchFn: async () => { calls++; signal.abort(); throw Error('fixture disconnected') } }
  await assert.rejects(prepareNativeImageInvocation(args)({ prompt: 'draw', signal: signal.signal }), { code: 'NATIVE_IMAGE_OUTCOME_UNKNOWN' })
  const [start] = pendingProviderUsage(store)
  store.write(start.receiptName, { evidenceSha256: start.evidenceSha256 })
  assert.deepEqual(pendingProviderUsage(store)[0].payload.observation.evidence, { providerRequestId: null, responseModel: null, usage: null })
  await assert.rejects(prepareNativeImageInvocation({ ...args, store: openStore() })({ prompt: 'draw' }), { code: 'NATIVE_IMAGE_ALREADY_STARTED' })
  assert.equal(calls, 1)
})

test('a crash gap at the reservation still blocks dispatch; RESPONSE_V2 can journal a distinct child effect', async t => {
  const { request, openStore, store } = fixture(t)
  assert.equal(store.reserve('native-image-start'), true)
  const fetchFn = () => assert.fail('must not contact provider')
  await assert.rejects(prepareNativeImageInvocation({ ...request, store: openStore(), fetchFn })({ prompt: 'recover' }), { code: 'NATIVE_IMAGE_ALREADY_STARTED' })
  const metered = fixture(t, { usageMode: 'RESPONSE_V2' })
  const bytes = await prepareNativeImageInvocation({ ...metered.request, fetchFn: async url => response(url) })({ prompt: 'draw' })
  assert.deepEqual(bytes, png)
  assert.equal(pendingProviderUsage(metered.store, { hostOnly: true })[0].payload.observation.phase, 'STARTED')
})
