import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nativeImageRouteDigest, nativeImageToolDefinition, selectNativeImageTool, validateNativeImageSettings } from '../native-image-tool.mjs'
import { NATIVE_SKILL_SCRIPT_POLICY, skillDigest, skillHash } from '../skill-executor.mjs'
import { SkillExecutionStore } from '../skill-execution-store.mjs'
import { SkillUsageDelivery } from '../skill-usage-delivery.mjs'
import { runNativeExecution } from '../native-execution.mjs'
import { checkPng, makePng, offlinePackage } from '../../skills/image-process/test/fixture.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X8ZkAAAAASUVORK5CYII=', 'base64')
const hash = 'a'.repeat(64), apiOrigin = 'https://api.example', agentId = 'agent1'
function fixture(t, kind = 'TASK', operation = 'generate', mountPinnedSkill = false) {
  const rootDir = mkdtempSync('/var/tmp/cyf-native-image-tool-')
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  writeFileSync(resolve(rootDir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-key' }), { mode: 0o600 })
  const skillKey = `image-${operation}`, skillVersion = '1.4.2', skillInstallationId = 'installation1'
  const scope = { agentId, tenantId: 'tenant', clientId: 'client', ownerJiacn: 'owner' }
  const executionScope = { kind, taskId: kind === 'TASK' ? 'task' : null, conversationId: 'conversation', conversationGeneration: '1' }
  const executionBinding = { executionId: 'exec', agentId, scopeSha256: skillDigest(executionScope), grantRevision: '1',
    approvedPermissionsSha256: hash, packageSha256: hash, manifestSha256: null, skillVersion, skillKey, skillInstallationId, productVersionId: 'version1' }
  const command = { executionProtocolVersion: 6, executionId: 'exec', runId: 'run', commandId: 'cmd', messageId: 'message', scope: executionScope,
    toolPolicyRef: NATIVE_SKILL_SCRIPT_POLICY, snapshotDigest: hash, instruction: 'authorized image action', parameters: {},
    skills: [{ skill: { key: skillKey, version: skillVersion, packageSha256: hash, manifestSha256: null }, executionBinding }],
    inputRefs: operation === 'edit' ? ['image1'] : [], outputs: { dataSchema: null, mimeTypes: ['image/png'], multiple: false, artifactsRequired: true } }
  const store = new SkillExecutionStore({ rootDirectory: resolve(rootDir, 'skill-runs'), scope: { ...scope, apiOrigin }, command })
  const settings = validateNativeImageSettings({ model: 'image-model', [`${operation}PackageSha256`]: hash, ...(mountPinnedSkill ? { mountPinnedSkill } : {}) })
  const chatProvider = { id: 'chat', baseUrl: 'https://gateway.example/v1', wireApi: 'responses' }
  const configReadback = () => ({ config: { cli_auth_credentials_store: 'file', model_provider: 'chat', model_providers: {
    chat: { base_url: chatProvider.baseUrl, requires_openai_auth: true, wire_api: 'responses' }
  } } })
  const select = { settings, command, store, chatProvider, entries: [{ descriptor: { skillKey, skillVersion, skillInstallationId, packageSha256: hash, packageRoot: resolve(rootDir, 'offline-package'), packageTreeDigest: hash } }] }
  return { rootDir, scope, select, configReadback }
}
test('image reference routes separate model, mode, package, gateway and tier but not tariff revisions', t => {
  const { select } = fixture(t), { chatProvider: provider } = select
  const settings = {...select.settings, editPackageSha256:hash, channel:'gateway', tier:'standard', priceVersion:'p1'}
  const before = nativeImageRouteDigest('generate',settings,provider)
  assert.match(before,/^[0-9a-f]{64}$/)
  assert.equal(nativeImageRouteDigest('generate',{...settings,priceVersion:'p2'},{...provider,baseUrl:provider.baseUrl+'/'}),before)
  for(const changed of [{model:'other'},{tier:'priority'},{channel:'other'},{generatePackageSha256:'b'.repeat(64)},{mountPinnedSkill:true}])
    assert.notEqual(nativeImageRouteDigest('generate',{...settings,...changed},provider),before)
  assert.notEqual(nativeImageRouteDigest('edit',settings,provider),before)
  assert.notEqual(nativeImageRouteDigest('generate',settings,{...provider,baseUrl:'https://other.example/v1'}),before)
  assert.equal(nativeImageRouteDigest('generate',{...settings,channel:null},provider),null)
  assert.equal(nativeImageRouteDigest('generate',settings,{...provider,baseUrl:'https://private:secret@other.example/v1'}),null)
  assert.notDeepEqual(nativeImageToolDefinition('generate'),nativeImageToolDefinition('edit'))
})
for (const kind of ['TASK', 'PRIVATE']) for (const op of ['generate', 'edit']) test(`${kind} ${op} substitutes only the pinned operation and proposes the staged PNG`, async t => {
  const { select, configReadback, rootDir } = fixture(t, kind, op)
  const { store, command, settings, chatProvider } = select
  const operation = selectNativeImageTool(select)
  assert.equal(operation, op)
  const inputs = command.inputRefs.map(inputRef => ({ inputRef, byteLength: String(png.length), sha256: skillHash(png), contentMimeType: 'image/png' }))
  store.write('inputs-snapshot', { schemaVersion: 1, inputs })
  for (const input of inputs) await store.materializeInput(input, async () => [png], () => {})
  let posted = 0
  const nativeImage = { operation, settings, chatProvider, configReadback, subjectHome: rootDir, fetchFn: async (url, request) => {
    posted++
    assert.equal(request.headers.Authorization, 'Bearer fixture-key')
    assert.equal(url, `https://gateway.example/v1/images/${op === 'edit' ? 'edits' : 'generations'}`)
    const body = JSON.parse(request.body)
    assert.equal(body.model, 'image-model')
    assert.equal(body.images?.length ?? 0, inputs.length)
    if (body.images) assert.equal(body.images[0].image_url, `data:image/png;base64,${png.toString('base64')}`)
    const response = new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { headers: { 'Content-Type': 'application/json' } })
    Object.defineProperty(response, 'url', { value: url })
    return response
  } }
  const tool = `native_image_${op}`
  const profileRuntime = { async suspendAdapter() {}, async openNativeExecutionAdapter(_directory, _key, _binding, options) {
    assert.deepEqual(options.skills, [])
    assert.deepEqual(options.skillConfiguration, [])
    assert.equal(options.nativeExecution.networkAccess, false)
    assert.deepEqual(options.nativeExecution.tools.map(t => t.name), ['artifact_stage', 'result_propose', tool])
    const { callTool } = options.nativeExecution
    return { async startOrResumeThread() { return { threadId: 'thread' } }, async runTurn({ onAccepted }) {
      const turn = { threadId: 'thread', turnId: 'turn' }
      onAccepted(turn)
      const ctx = { ...turn, executionId: 'exec', tool, callId: 'paid', arguments: { prompt: 'fixture', ...(op === 'edit' ? { inputRefs: ['image1'] } : {}) } }
      await assert.rejects(callTool({ ...ctx, turnId: 'wrong' }), { code: 'NATIVE_TOOL_BINDING_INVALID' })
      await assert.rejects(callTool({ ...ctx, arguments: { ...ctx.arguments, apiKey: 'not authorized' } }), { code: 'NATIVE_TOOL_ARGUMENTS_INVALID' })
      if (op === 'edit') await assert.rejects(callTool({ ...ctx, arguments: { ...ctx.arguments, inputRefs: ['foreign'] } }), { code: 'SKILL_INPUT_SNAPSHOT_INVALID' })
      assert.equal(posted, 0)
      const artifact = await callTool(ctx)
      assert.equal(store.loadResult(), null)
      assert.equal(artifact.sha256, skillHash(png))
      await assert.rejects(callTool({ ...ctx, callId: 'second' }), { code: 'NATIVE_IMAGE_ALREADY_STARTED' })
      await callTool({ ...ctx, callId: 'propose', tool: 'result_propose', arguments: { artifactRefs: [artifact.artifactRef], summary: 'fixture', data: null } })
      return { ...turn, finishReason: 'completed', content: 'fixture' }
    } }
  } }
  const result = await runNativeExecution({ command, store, entries: [], inputs, checkActive() {}, profileRuntime, nativeImage })
  assert.equal(posted, 1)
  assert.deepEqual(store.readBlob(result.result.artifacts[0].outputId), png)
})

for (const [kind, op] of [['TASK', 'generate'], ['PRIVATE', 'edit']]) test(`${kind} native ${op}: Agent can choose offline processing and stage only the derivative`, async t => {
  const { select, configReadback, rootDir } = fixture(t, kind, op, true)
  const { command, store, settings, chatProvider, entries } = select
  const operation = selectNativeImageTool(select)
  const run = offlinePackage(entries[0].descriptor.packageRoot)
  const original = makePng(40, 20), reference = makePng(30, 40)
  const inputs = command.inputRefs.map(inputRef => ({ inputRef, byteLength: String(reference.length), sha256: skillHash(reference), contentMimeType: 'image/png' }))
  store.write('inputs-snapshot', { schemaVersion: 1, inputs })
  for (const input of inputs) await store.materializeInput(input, async () => [reference], () => {})
  let calls = 0
  const nativeImage = { operation, settings, chatProvider, configReadback, subjectHome: rootDir, fetchFn: async (url) => {
    calls++
    const response = new Response(JSON.stringify({ data: [{ b64_json: original.toString('base64') }] }), { headers: { 'Content-Type': 'application/json' } })
    Object.defineProperty(response, 'url', { value: url })
    return response
  } }
  const profileRuntime = { async suspendAdapter() {}, async openNativeExecutionAdapter(inputDir, _key, _binding, options) {
    assert.equal(options.skills.length, 1)
    assert.equal(options.skills[0].packageRoot, entries[0].descriptor.packageRoot)
    assert.deepEqual(options.skillConfiguration, [])
    assert.equal(options.nativeExecution.networkAccess, false)
    return { async startOrResumeThread() { return { threadId: 'thread' } }, async runTurn({ onAccepted }) {
      const turn = { threadId: 'thread', turnId: 'turn' }; onAccepted(turn)
      const base = { ...turn, executionId: command.executionId }
      const call = (tool, callId, args) => options.nativeExecution.callTool({ ...base, tool, callId, arguments: args })
      const raw = await call(`native_image_${op}`, 'generate', { prompt: 'synthetic', ...(op === 'edit' ? { inputRefs: ['image1'] } : {}) })
      assert.equal(raw.path, `/inputs/.tool-results/${raw.artifactRef}`)
      const input = resolve(inputDir, raw.path.slice('/inputs/'.length)), output = resolve(options.draftsDirectory, 'resized.png')
      assert.deepEqual(readFileSync(input), original)
      const args = ['--input', input, '--output', output, '--background', 'white']
      assert.equal(run([...args, '--size', 'invalid']).status, 1)
      const result = run([...args, ...(op === 'edit' ? ['--size-from', resolve(inputDir, 'image1')] : ['--size', '800x600'])])
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(readFileSync(input), original)
      if (op === 'edit') assert.deepEqual(readFileSync(resolve(inputDir, 'image1')), reference)
      const staged = await call('artifact_stage', 'stage', { path: '/outputs/resized.png', displayName: 'resized.png', mediaTypeHint: 'image/png' })
      assert.notEqual(staged.artifactRef, raw.artifactRef)
      await call('result_propose', 'propose', { artifactRefs: [staged.artifactRef], summary: 'fixture', data: null })
      return { ...turn, finishReason: 'completed', content: 'fixture' }
    } }
  } }
  const result = await runNativeExecution({ command, store, entries, inputs, checkActive() {}, profileRuntime, nativeImage })
  assert.equal(calls, 1)
  assert.equal(result.result.artifacts.length, 1)
  checkPng(store.readBlob(result.result.artifacts[0].outputId), ...(op === 'edit' ? [30, 40] : [800, 600]))
})

test('native image does not start a profile with an altered package or sandbox credentials', async t => {
  const { select } = fixture(t, 'TASK', 'generate', true)
  const operation = selectNativeImageTool(select)
  const { entries, settings, command, store } = select
  const nativeImage = { operation, settings }
  const profileRuntime = { async suspendAdapter() {}, async openNativeExecutionAdapter() { assert.fail('unauthorized profile opened') } }
  const base = { command, store, entries, nativeImage, checkActive() {}, profileRuntime }
  await assert.rejects(runNativeExecution({ ...base, entries: [{ descriptor: { ...entries[0].descriptor, packageSha256: 'b'.repeat(64) } }] }), { code: 'NATIVE_IMAGE_AUTHORIZATION_INVALID' })
  await assert.rejects(runNativeExecution({ ...base, skillConfiguration: [{ configuration: { apiKey: 'synthetic' }, networkOrigins: ['https://fixture.invalid'] }] }), { code: 'NATIVE_IMAGE_AUTHORIZATION_INVALID' })
})

test('ordinary authority cannot select native Images; pinned execution cannot switch to scripts on restart', t => {
  const { select } = fixture(t)
  assert.equal(selectNativeImageTool({ ...select, entries: [] }), null)
  assert.equal(selectNativeImageTool({ ...select, settings: { ...select.settings, generatePackageSha256: 'b'.repeat(64) } }), null)
  assert.throws(() => validateNativeImageSettings({ ...select.settings, apiKey: 'forbidden' }), { code: 'NATIVE_IMAGE_CONFIG_INVALID' })
  assert.throws(() => selectNativeImageTool({ ...select, entries: [...select.entries, ...select.entries] }), { code: 'NATIVE_IMAGE_AUTHORIZATION_INVALID' })
  assert.equal(selectNativeImageTool(select), 'generate')
  assert.throws(() => selectNativeImageTool({ ...select, settings: null }), { code: 'SKILL_RESULT_UNKNOWN' })
  assert.throws(() => selectNativeImageTool({ ...select, settings: { ...select.settings, model: 'changed' } }), { code: 'SKILL_RESULT_UNKNOWN' })
  const legacy = fixture(t)
  legacy.select.store.write('native-thread', { threadId: 'existing-script-thread' })
  assert.equal(selectNativeImageTool(legacy.select), null)
})

test('chat and host Images have independent receipt discovery; script scratch cannot impersonate host Images', async t => {
  const { select, rootDir, scope } = fixture(t, 'TASK', 'generate')
  const { store } = select
  selectNativeImageTool(select)
  // Fixtures: a separate chat record and one host invocation, plus untrusted script scratch.
  store.write('native-start-attempt', { requestedModel: 'chat-model' })
  store.write('native-final-message', { requestedModel: 'chat-model', usageEvidence: { input_tokens: 7, output_tokens: 3 } })
  const invocationId = '18d66394-3ffb-433d-b860-a39cbcaac0c4'
  const scratch = resolve(store.directory, 'scratch/.provider-usage')
  mkdirSync(scratch, { mode: 0o700 })
  writeFileSync(resolve(scratch, 'a8d66394-3ffb-433d-b860-a39cbcaac0c4-started.json'), '{}', { mode: 0o600 })
  const prefix = `provider-usage-${invocationId}`
  store.write(`${prefix}-started`, { invocationId, phase: 'STARTED' })
  store.write(`${prefix}-terminal`, { invocationId, phase: 'TERMINAL' })
  const lane = new SkillUsageDelivery({ apiOrigin, rootDir, scope, agentId: scope.agentId, runtimeInstanceId: 'runtime1', getRuntimeHeaders: () => ({}) })
  const phases = []
  lane.request = async (path, method, { observation, phase }) => {
    if (path.endsWith('/usage')) {
      phases.push(`CHAT:${phase}`)
      return { executionId: 'exec', attemptId: hash, revision: phase === 'STARTED' ? '1' : '2', status: 'PENDING_USAGE', costYuan: null }
    }
    assert.equal(path, '/internal/agent/executions/exec/runs/run/provider-usage')
    assert.equal(method, 'POST')
    assert.equal(observation.invocationId, invocationId)
    phases.push(observation.phase)
    return { executionId: 'exec', attemptId: hash, revision: observation.phase === 'STARTED' ? '1' : '2', status: 'PENDING_USAGE', costYuan: null }
  }
  for (let i = 0; i < 3; i++) {
    lane.pendingCommands()
    assert.deepEqual(await lane.deliverPendingUsage(), [])
  }
  assert.deepEqual(phases, ['CHAT:STARTED', 'STARTED', 'CHAT:TERMINAL', 'TERMINAL'])
})
