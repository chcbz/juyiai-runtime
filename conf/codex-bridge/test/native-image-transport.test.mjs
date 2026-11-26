import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { prepareNativeImageCall } from '../native-image-transport.mjs'

const png = readFileSync(new URL('./fixtures/native-edit-input.png', import.meta.url))
function fixture(t, overrides = {}) {
  const home = mkdtempSync('/var/tmp/cyf-image-transport-')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(resolve(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-subject-key' }), { mode: 0o600 })
  const provider = { id: 'chat', baseUrl: 'https://gateway.example/v1', wireApi: 'responses' }
  const config = { cli_auth_credentials_store: 'file', model_provider: provider.id,
    model_providers: { chat: { base_url: provider.baseUrl, wire_api: provider.wireApi, requires_openai_auth: true } } }
  const events = []
  const args = { subjectHome: home, chatProvider: provider, configReadback: { config }, operation: 'generate', model: 'image-model',
    reserveOnce: async () => { events.push('reserve'); return true }, observeResponse: async entry => events.push(entry),
    fetchFn: async (url, req) => {
      events.push({ url, ...req, body: JSON.parse(req.body) })
      return imageResponse(url)
    }, ...overrides }
  return { events, args }
}
function imageResponse(url, image = png.toString('base64')) {
  const res = new Response(JSON.stringify({ model: 'image-model', usage: { total_tokens: 42 }, data: [{ b64_json: image }] }),
    { headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'provider-fixture' } })
  Object.defineProperty(res, 'url', { value: url })
  return res
}

test('native generation reuses the bound chat gateway and subject Key, after durable reservation', async t => {
  const { events, args } = fixture(t)
  const call = prepareNativeImageCall(args)
  assert.deepEqual(await call({ prompt: 'draw' }), png)
  assert.equal(events[0], 'reserve')
  const request = events[1]
  assert.equal(request.url, 'https://gateway.example/v1/images/generations')
  assert.equal(request.headers.Authorization, 'Bearer fixture-subject-key')
  assert.equal(request.redirect, 'error')
  assert.deepEqual(request.body, { model: 'image-model', prompt: 'draw', n: 1, output_format: 'png' })
  assert.deepEqual(events[2], { providerRequestId: 'provider-fixture', responseModel: 'image-model', usage: { total_tokens: 42 } })
  await assert.rejects(call({ prompt: 'draw' }), { code: 'NATIVE_IMAGE_ALREADY_STARTED' })
})

test('native edit sends only bounded material bytes, not paths or URLs', async t => {
  const { events, args } = fixture(t, { operation: 'edit', inputs: [{ contentMimeType: 'image/png', bytes: png }] })
  await prepareNativeImageCall(args)({ prompt: 'edit' })
  assert.equal(events[1].url, 'https://gateway.example/v1/images/edits')
  assert.deepEqual(events[1].body.images, [{ image_url: `data:image/png;base64,${png.toString('base64')}` }])
  assert.throws(() => prepareNativeImageCall({ ...args, inputs: [{ contentMimeType: 'image/png', url: 'https://elsewhere.example' }] }), { code: 'NATIVE_IMAGE_INPUT_INVALID' })
  assert.throws(() => prepareNativeImageCall({ ...args, inputs: [] }), { code: 'NATIVE_IMAGE_INPUT_INVALID' })
})

test('mismatched gateway, malformed auth, prior invocation and network failure cannot bypass the boundary', async t => {
  const { events, args } = fixture(t)
  assert.throws(() => prepareNativeImageCall({ ...args, chatProvider: { ...args.chatProvider, baseUrl: 'https://elsewhere.example/v1' } }), { code: 'MODEL_AUTH_CONFIG_INVALID' })
  await assert.rejects(prepareNativeImageCall({ ...args, reserveOnce: async () => false })({ prompt: 'draw' }), { code: 'NATIVE_IMAGE_ALREADY_STARTED' })
  assert.deepEqual(events, [])
  const call = prepareNativeImageCall({ ...args, fetchFn: async () => { throw Error('unsanitized upstream detail') } })
  await assert.rejects(call({ prompt: 'draw' }), { code: 'NATIVE_IMAGE_OUTCOME_UNKNOWN', message: 'NATIVE_IMAGE_OUTCOME_UNKNOWN' })
  await assert.rejects(call({ prompt: 'draw again' }), { code: 'NATIVE_IMAGE_ALREADY_STARTED' })
  writeFileSync(resolve(args.subjectHome, 'auth.json'), '{}')
  await assert.rejects(prepareNativeImageCall(args)({ prompt: 'draw' }), { code: 'MODEL_AUTH_INVALID' })
  assert.deepEqual(events, ['reserve'])
})

test('returned usage is observed even when the provider returns an invalid image', async t => {
  const { events, args } = fixture(t, { fetchFn: async url => imageResponse(url, 'bm90LWEtcG5n') })
  await assert.rejects(prepareNativeImageCall(args)({ prompt: 'draw' }), { code: 'CONTROLLED_IMAGE_RESPONSE_INVALID' })
  assert.deepEqual(events, ['reserve', { providerRequestId: 'provider-fixture', responseModel: 'image-model', usage: { total_tokens: 42 } }])
})

test('a redirected or wrong-origin response is not accepted or recorded as a valid reply', async t => {
  const { events, args } = fixture(t, { fetchFn: async () => imageResponse('https://elsewhere.example/v1/images/generations') })
  await assert.rejects(prepareNativeImageCall(args)({ prompt: 'draw' }), { code: 'CONTROLLED_IMAGE_PROVIDER_REJECTED' })
  assert.deepEqual(events, ['reserve'])
})

test('cancellation before dispatch does not contact the provider', async t => {
  const { events, args } = fixture(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepareNativeImageCall(args)({ prompt: 'draw', signal: controller.signal }), { code: 'NATIVE_IMAGE_CANCELLED' })
  assert.deepEqual(events, [])
})
