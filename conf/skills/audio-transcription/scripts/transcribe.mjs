#!/usr/bin/env node
// Standalone provider protocol helper: no platform identity, wallet or task authority.
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync, lstatSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as http from 'node:http'
import { beginProviderUsage } from './provider-usage.mjs'

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function argsOf(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1]
    if (!['--input', '--output', '--config'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(args, key.slice(2))) fail('AUDIO_ARGUMENT_INVALID')
    args[key.slice(2)] = value
  }
  if (!args.input || !args.output) fail('AUDIO_ARGUMENT_INVALID')
  return { ...args, input: resolve(args.input), output: resolve(args.output) }
}
function reserve(path) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  return { path, fd, identity: fstatSync(fd), keep: false }
}
function save(file, value) { writeFileSync(file.fd, value); fsyncSync(file.fd); file.keep = true }
function release(file) {
  if (!file) return
  closeSync(file.fd)
  if (!file.keep) {
    try {
      const current = lstatSync(file.path)
      if (current.dev === file.identity.dev && current.ino === file.identity.ino) unlinkSync(file.path)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
export async function run(argv, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const args = argsOf(argv)
  let config
  try { config = JSON.parse(readFileSync(args.config || resolve(env.CYF_SKILL_CONFIG_DIR || '/skill-config', 'audio-transcription.json'), 'utf8')) }
  catch { fail('AUDIO_CONFIG_MISSING') }
  if (!config || typeof config !== 'object' || !['endpoint', 'model', 'apiKey'].every(key => typeof config[key] === 'string' && config[key].trim())) fail('AUDIO_CONFIG_INVALID')
  let endpoint
  try {
    endpoint = new URL(config.endpoint)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error()
    endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/audio/transcriptions'
  } catch { fail('AUDIO_CONFIG_INVALID') }
  if ((config.language !== undefined && (typeof config.language !== 'string' || !config.language.trim())) || (config.responseFormat !== undefined && !['json', 'verbose_json', 'diarized_json'].includes(config.responseFormat))) fail('AUDIO_CONFIG_INVALID')
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('AUDIO_TLS_INSECURE')
  const input = readFileSync(args.input)
  if (!input.length) fail('AUDIO_INPUT_EMPTY')
  const mime = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[extname(args.input).toLowerCase()] || 'application/octet-stream'
  const body = new FormData()
  body.set('file', new Blob([input], { type: mime }), basename(args.input))
  body.set('model', config.model)
  body.set('response_format', config.responseFormat || 'json')
  if (config.language) body.set('language', config.language)
  const httpProxy = env.http_proxy || env.HTTP_PROXY, httpsProxy = env.https_proxy || env.HTTPS_PROXY
  if ((httpProxy || httpsProxy) && !httpsProxy) fail('AUDIO_PROXY_CONFIG_INVALID')
  let output, marker, usage, restoreProxy
  try {
    if (httpsProxy) {
      if (typeof http.setGlobalProxyFromEnv !== 'function') fail('AUDIO_PROXY_UNAVAILABLE')
      try { restoreProxy = http.setGlobalProxyFromEnv({ http_proxy: httpProxy, https_proxy: httpsProxy, no_proxy: ' ' }) }
      catch { fail('AUDIO_PROXY_CONFIG_INVALID') }
    }
    output = reserve(args.output)
    try { marker = reserve(`${args.output}.request-started`) }
    catch (error) { if (error.code === 'EEXIST') fail('AUDIO_REQUEST_EXISTS'); throw error }
    save(marker, JSON.stringify({ state: 'REQUEST_STARTED', sourceSha256: digest(input), sourceByteLength: String(input.length), requestedModel: config.model }) + '\n')
    const dir = openSync(dirname(args.output), constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(dir) } finally { closeSync(dir) }
    usage = beginProviderUsage({ directory: env.CYF_PROVIDER_USAGE_DIR, config, mode: 'transcribe' })
    let response
    try { response = await fetchFn(endpoint, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' }, body }) }
    catch { fail('AUDIO_OUTCOME_UNKNOWN', { outcome: 'UNKNOWN' }) }
    // A proxy/5xx response does not prove the upstream did not execute; never retry here.
    if (response.status !== 200) fail('AUDIO_PROVIDER_REJECTED', { httpStatus: response.status, outcome: 'UNKNOWN' })
    let data
    try { data = await response.json() } catch { fail('AUDIO_RESPONSE_INVALID', { outcome: 'UNKNOWN' }) }
    if (!data || typeof data !== 'object' || typeof data.text !== 'string') fail('AUDIO_RESPONSE_INVALID', { outcome: 'UNKNOWN' })
    const evidence = { usage: data.usage ?? null, responseModel: data.model ?? null, providerRequestId: response.headers.get('x-request-id') }
    usage?.complete(evidence)
    const result = { schemaVersion: 1, source: { sha256: digest(input), byteLength: String(input.length) }, text: data.text,
      language: data.language ?? null, duration: data.duration ?? null, segments: data.segments ?? null, words: data.words ?? null,
      provider: { protocol: 'openai-audio-transcriptions-v1', requestedModel: config.model, ...evidence } }
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n')
    save(output, bytes)
    return { path: args.output, contentMimeType: 'application/json', sha256: digest(bytes), byteLength: String(bytes.length) }
  } catch (error) {
    usage?.complete({ usage: null, responseModel: null, providerRequestId: null })
    throw error
  } finally { try { release(marker); release(output) } finally { restoreProxy?.() } }
}
const messages = {
  AUDIO_ARGUMENT_INVALID: 'Expected --input FILE --output NEW_JSON [--config FILE]',
  AUDIO_CONFIG_MISSING: 'Authorized audio service configuration is unavailable', AUDIO_CONFIG_INVALID: 'Audio service configuration is invalid',
  AUDIO_TLS_INSECURE: 'TLS verification must be enabled', AUDIO_INPUT_EMPTY: 'Audio input is empty',
  AUDIO_PROXY_CONFIG_INVALID: 'HTTPS proxy configuration is invalid', AUDIO_PROXY_UNAVAILABLE: 'Node runtime does not support the configured proxy',
  AUDIO_REQUEST_EXISTS: 'Request already started; inspect existing result; do not resend',
  AUDIO_OUTCOME_UNKNOWN: 'Provider outcome unknown; do not automatically resend',
  AUDIO_PROVIDER_REJECTED: 'Provider did not return a direct 200 response; do not automatically resend',
  AUDIO_RESPONSE_INVALID: 'Invalid transcription response; do not automatically resend',
  EEXIST: 'Output already exists; inspect it rather than resending', ENOENT: 'Input or output directory is unavailable'
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await run(process.argv.slice(2))) + '\n') }
  catch (error) {
    const code = Object.hasOwn(messages, error?.code) ? error.code : 'AUDIO_OPERATION_FAILED'
    process.stderr.write(JSON.stringify({ code, message: messages[code] || 'Audio operation failed; do not automatically resend', ...(error.outcome ? { outcome: error.outcome } : {}), ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) }) + '\n')
    process.exitCode = 1
  }
}
