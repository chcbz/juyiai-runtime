import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { run } from '../scripts/transcribe.mjs'

// Protocol fixture only: these bytes do not represent a verified speech recording.
const inputBytes = Buffer.from('RIFF\x24\0\0\0WAVEfmt mock-audio-bytes')
function fixture(t, configuration = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'audio-skill-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, '会议.wav'), output = join(dir, 'transcript.json'), config = join(dir, 'config.json')
  writeFileSync(input, inputBytes)
  writeFileSync(config, JSON.stringify({ endpoint: 'https://speech.example.invalid/custom/v1/', model: 'test-asr', apiKey: 'private-test-key', ...configuration }), { mode: 0o600 })
  return { dir, input, output, config, argv: ['--input', input, '--output', output, '--config', config] }
}
const ok = (data = { text: '测试转写' }) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': 'provider-test-receipt' } })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('multipart contains original bytes; base path and optional protocol fields preserved', async t => {
  const f = fixture(t, { language: 'zh', responseFormat: 'verbose_json' }); let calls = 0
  const result = await run(f.argv, { env: {}, fetchFn: async (url, options) => {
    calls++
    assert.equal(url.href, 'https://speech.example.invalid/custom/v1/audio/transcriptions')
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer private-test-key')
    assert.equal(options.headers['Content-Type'], undefined, 'fetch must add multipart boundary')
    const decoded = await new Response(options.body).formData()
    assert.equal(decoded.get('model'), 'test-asr'); assert.equal(decoded.get('language'), 'zh')
    assert.equal(decoded.get('response_format'), 'verbose_json')
    assert.equal(decoded.get('file').name, '会议.wav')
    assert.deepEqual(Buffer.from(await decoded.get('file').arrayBuffer()), inputBytes)
    return ok({ text: '好的，下周二再确认。', segments: [{ start: 0, end: 2, text: '好的，下周二再确认。' }], usage: { total_tokens: 23 }, language: 'zh', duration: 2 })
  } })
  assert.equal(calls, 1)
  const bytes = readFileSync(f.output), data = JSON.parse(bytes)
  assert.equal(data.text, '好的，下周二再确认。'); assert.equal(data.source.sha256, sha(inputBytes))
  assert.equal(data.source.byteLength, String(inputBytes.length)); assert.equal(data.segments.length, 1)
  assert.deepEqual(data.provider.usage, { total_tokens: 23 }); assert.equal(data.provider.providerRequestId, 'provider-test-receipt')
  assert.equal(result.sha256, sha(bytes)); assert.equal(result.byteLength, String(bytes.length))
  assert.equal(statSync(f.output).mode & 0o777, 0o600); assert.ok(existsSync(f.output + '.request-started'))
  assert.ok(!bytes.includes(Buffer.from('private-test-key')))
})

test('host usage receives raw provider counters without invented price or billing', async t => {
  const f = fixture(t), usageDir = join(f.dir, 'usage')
  await run(f.argv, { env: { CYF_PROVIDER_USAGE_DIR: usageDir }, fetchFn: async () => ok({ text: '收到', usage: { input_tokens: 8, custom: 11 } }) })
  const names = readdirSync(usageDir)
  assert.equal(names.length, 2)
  const terminal = JSON.parse(readFileSync(join(usageDir, names.find(n => n.endsWith('-terminal.json')))))
  assert.equal(terminal.protocol, 'openai-audio-transcriptions-v1')
  assert.deepEqual(terminal.evidence.usage, { input_tokens: 8, custom: 11 })
  assert.equal(terminal.price, undefined)
})

test('no usage or diarization is fabricated; empty text remains empty', async t => {
  const f = fixture(t)
  await run(f.argv, { env: {}, fetchFn: async () => ok({ text: '' }) })
  const data = JSON.parse(readFileSync(f.output))
  assert.equal(data.text, ''); assert.equal(data.provider.usage, null); assert.equal(data.segments, null)
})

for (const status of [302, 400, 429, 500, 504]) test(`HTTP ${status} is not retried and durable marker prevents replay`, async t => {
  const f = fixture(t); let calls = 0
  const fetchFn = async () => { calls++; return new Response('private-test-key must not leak', { status }) }
  await assert.rejects(run(f.argv, { env: {}, fetchFn }), e => e.code === 'AUDIO_PROVIDER_REJECTED' && e.httpStatus === status && e.outcome === 'UNKNOWN' && !e.message.includes('private-test-key'))
  assert.equal(calls, 1); assert.equal(existsSync(f.output), false); assert.ok(existsSync(f.output + '.request-started'))
  await assert.rejects(run(f.argv, { env: {}, fetchFn }), { code: 'AUDIO_REQUEST_EXISTS' }); assert.equal(calls, 1)
})

test('transport uncertainty is recorded without leaking exception content or retry', async t => {
  const f = fixture(t), usageDir = join(f.dir, 'usage'); let calls = 0
  const fetchFn = async () => { calls++; throw new Error('private-test-key') }
  await assert.rejects(run(f.argv, { env: { CYF_PROVIDER_USAGE_DIR: usageDir }, fetchFn }), e => e.code === 'AUDIO_OUTCOME_UNKNOWN' && e.outcome === 'UNKNOWN' && !e.message.includes('private-test-key'))
  await assert.rejects(run(f.argv, { env: {}, fetchFn }), { code: 'AUDIO_REQUEST_EXISTS' })
  assert.equal(calls, 1)
  const end = readdirSync(usageDir).find(n => n.endsWith('-terminal.json'))
  assert.equal(JSON.parse(readFileSync(join(usageDir, end))).evidence.usage, null)
})

for (const body of ['not-json private-test-key', '{}', '{"text":123}']) test(`invalid response ${body.slice(0, 10)} retains unknown outcome`, async t => {
  const f = fixture(t)
  await assert.rejects(run(f.argv, { env: {}, fetchFn: async () => new Response(body, { status: 200 }) }), { code: 'AUDIO_RESPONSE_INVALID', outcome: 'UNKNOWN' })
  assert.ok(existsSync(f.output + '.request-started')); assert.equal(existsSync(f.output), false)
})

test('existing output and symlink output never overwritten and never dispatch', async t => {
  const f = fixture(t); let calls = 0
  const fetchFn = async () => { calls++; return ok() }
  writeFileSync(f.output, 'KEEP')
  await assert.rejects(run(f.argv, { env: {}, fetchFn }), { code: 'EEXIST' })
  assert.equal(readFileSync(f.output, 'utf8'), 'KEEP'); rmSync(f.output)
  symlinkSync(f.input, f.output)
  await assert.rejects(run(f.argv, { env: {}, fetchFn }))
  assert.equal(calls, 0); assert.deepEqual(readFileSync(f.input), inputBytes)
})

for (const endpoint of ['http://speech.example.invalid/v1', 'https://user:secret@speech.example.invalid/v1', 'https://speech.example.invalid/v1?key=secret']) test(`unsafe endpoint rejected locally: ${endpoint}`, async t => {
  const f = fixture(t, { endpoint }); let calls = 0
  await assert.rejects(run(f.argv, { env: {}, fetchFn: async () => { calls++; return ok() } }), { code: 'AUDIO_CONFIG_INVALID' })
  assert.equal(calls, 0); assert.equal(existsSync(f.output + '.request-started'), false)
})

test('missing scoped config never falls back to global API credentials', async t => {
  const f = fixture(t); rmSync(f.config)
  await assert.rejects(run(f.argv, { env: { OPENAI_API_KEY: 'global-secret' }, fetchFn: async () => { assert.fail('must not dispatch') } }), { code: 'AUDIO_CONFIG_MISSING' })
})

test('CYF_SKILL_CONFIG_DIR resolves only the installation supplied config', async t => {
  const f = fixture(t)
  writeFileSync(join(f.dir, 'audio-transcription.json'), readFileSync(f.config))
  await run(['--input', f.input, '--output', f.output], { env: { CYF_SKILL_CONFIG_DIR: f.dir }, fetchFn: async () => ok() })
  assert.ok(existsSync(f.output))
})

test('TLS bypass fails locally without calling provider', async t => {
  const f = fixture(t)
  await assert.rejects(run(f.argv, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, fetchFn: async () => assert.fail() }), { code: 'AUDIO_TLS_INSECURE' })
})

test('CLI diagnostics never echo credential, provider URL, or raw configuration errors', t => {
  const f = fixture(t, { endpoint: 'invalid private-test-key' })
  const helper = fileURLToPath(new URL('../scripts/transcribe.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [helper, ...f.argv], { encoding: 'utf8' })
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).code, 'AUDIO_CONFIG_INVALID')
  assert.ok(!result.stderr.includes('private-test-key')); assert.equal(result.stdout, '')
})

test('proxy missing for HTTPS rejected before dispatch', async t => {
  const f = fixture(t)
  await assert.rejects(run(f.argv, { env: { HTTP_PROXY: 'http://127.0.0.1:1' }, fetchFn: async () => assert.fail() }), { code: 'AUDIO_PROXY_CONFIG_INVALID' })
})

test('real fetch uses configured CONNECT proxy despite NO_PROXY, without paid request', async t => {
  const f = fixture(t); let connects = 0
  const proxy = createServer()
  proxy.on('connect', (request, socket) => { connects++; assert.equal(request.url, 'speech.example.invalid:443'); socket.destroy() })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(run(f.argv, { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '*' } }), { code: 'AUDIO_OUTCOME_UNKNOWN' })
    assert.ok(connects >= 1, 'must reach explicitly configured proxy')
  } finally { await new Promise(resolve => proxy.close(resolve)) }
})

test('bad CLI or unsupported response format fails before dispatch', async t => {
  await assert.rejects(run(['--input', 'x', '--input', 'y']), { code: 'AUDIO_ARGUMENT_INVALID' })
  const f = fixture(t, { responseFormat: 'text' })
  await assert.rejects(run(f.argv, { env: {}, fetchFn: async () => assert.fail() }), { code: 'AUDIO_CONFIG_INVALID' })
})

test('empty input rejected without network or request marker', async t => {
  const f = fixture(t); writeFileSync(f.input, '')
  await assert.rejects(run(f.argv, { env: {}, fetchFn: async () => assert.fail() }), { code: 'AUDIO_INPUT_EMPTY' })
  assert.equal(existsSync(f.output + '.request-started'), false)
})
