/** Host-only transport for the chat gateway's Images endpoints. The caller owns
 * task/turn authorization, input materialization, durable effects and artifacts. */
import { assertFileAuthConfig, readModelAuthFile } from './model-auth.mjs'
import { validateNativeConversationOutput } from './conversation-native.mjs'
import { responsePng } from './skill-runners/image-http-codec.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const paths = Object.freeze({ generate: 'images/generations', edit: 'images/edits' })
const inputMimes = new Set(['image/png', 'image/jpeg', 'image/webp'])
export const NATIVE_IMAGE_MAX_INPUT_BYTES = 15 * 1024 * 1024 // combined base64 envelope stays within 20 MiB
const maxResponseBytes = 24 * 1024 * 1024 // 16 MiB PNG plus base64 and metadata

async function readBoundedJson(response) {
  const reader = response.body?.getReader()
  if (!reader) fail('NATIVE_IMAGE_RESPONSE_INVALID')
  let done = false
  try {
    const chunks = []; let size = 0
    while (!done) {
      const part = await reader.read(); done = part.done
      if (!done) {
        size += part.value.byteLength
        if (size > maxResponseBytes) fail('NATIVE_IMAGE_RESPONSE_INVALID')
        chunks.push(part.value)
      }
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
  } finally {
    if (!done) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function nativeImagesEndpoint(operation, chatProvider, configReadback) {
  if (!Object.hasOwn(paths, operation) || !chatProvider || typeof chatProvider.baseUrl !== 'string'
      || !chatProvider.id || chatProvider.wireApi !== 'responses') fail('NATIVE_IMAGE_CONFIG_INVALID')
  const provider = assertFileAuthConfig(configReadback, chatProvider)
  let base
  try { base = new URL(provider.base_url) } catch { fail('NATIVE_IMAGE_CONFIG_INVALID') }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || !/^\/v1\/?$/.test(base.pathname) || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('NATIVE_IMAGE_CONFIG_INVALID')
  return new URL(`/v1/${paths[operation]}`, base).href
}

/** Inputs are verified material bytes supplied by the host, never arbitrary paths
 * or URLs from the model. reserveOnce must atomically reserve the authorized
 * invocation and return true only for its first dispatch, including after restart. */
export function prepareNativeImageCall({ operation, model, subjectHome, chatProvider, configReadback,
  inputs = [], fetchFn, reserveOnce, observeResponse }) {
  if (typeof model !== 'string' || !model.trim() || model.length > 128
      || ![fetchFn, reserveOnce, observeResponse].every(fn => typeof fn === 'function')) fail('NATIVE_IMAGE_CONFIG_INVALID')
  const href = nativeImagesEndpoint(operation, chatProvider, configReadback)
  if (!Array.isArray(inputs) || inputs.length > 4 || (operation === 'edit') !== Boolean(inputs.length)) fail('NATIVE_IMAGE_INPUT_INVALID')
  let inputBytes = 0
  const images = Array.from(inputs, input => {
    if (!inputMimes.has(input?.contentMimeType) || !Buffer.isBuffer(input.bytes) || !input.bytes.length
        || (inputBytes += input.bytes.length) > NATIVE_IMAGE_MAX_INPUT_BYTES
        || !validateNativeConversationOutput(input.contentMimeType, input.bytes.subarray(0, 16))) fail('NATIVE_IMAGE_INPUT_INVALID')
    return { image_url: `data:${input.contentMimeType};base64,${input.bytes.toString('base64')}` }
  })
  let dispatching = false
  return async ({ prompt, signal } = {}) => {
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 32 * 1024) fail('NATIVE_IMAGE_PROMPT_INVALID')
    if (dispatching) fail('NATIVE_IMAGE_ALREADY_STARTED')
    if (signal?.aborted) fail('NATIVE_IMAGE_CANCELLED')
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('NATIVE_IMAGE_CONFIG_INVALID')
    const key = readModelAuthFile(subjectHome).auth.OPENAI_API_KEY
    dispatching = true
    if (await reserveOnce() !== true) fail('NATIVE_IMAGE_ALREADY_STARTED')
    if (signal?.aborted) fail('NATIVE_IMAGE_CANCELLED')
    let response
    try {
      response = await fetchFn(href, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]),
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, ...(images.length ? { images } : {}), n: 1, output_format: 'png' })
      })
    } catch { fail('NATIVE_IMAGE_OUTCOME_UNKNOWN') }
    const endpoint = new URL(href)
    return responsePng({ status: response.status, redirected: response.redirected, url: response.url, headers: response.headers,
      json: async () => {
        const payload = await readBoundedJson(response)
        await observeResponse({ providerRequestId: response.headers?.get('x-request-id') ?? null,
          responseModel: typeof payload?.model === 'string' ? payload.model : null, usage: payload?.usage ?? null })
        return payload
      }
    }, endpoint).finally(async () => {
      if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {})
    })
  }
}
