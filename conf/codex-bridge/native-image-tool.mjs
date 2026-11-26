/** Opt-in substitution of one verified ordinary platform image package. A package
 * name, a prompt, or a locally installed script alone never opens host egress. */
import { skillDigest, skillSha, NATIVE_SKILL_SCRIPT_POLICY } from './skill-executor.mjs'
import { nativeImagesEndpoint } from './native-image-transport.mjs'
import { prepareNativeImageInvocation } from './native-image-invocation.mjs'

const fail = (code, recoverableToolError = false) => { throw Object.assign(new Error(code), { code, recoverableToolError }) }
const label = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
const packagePins = { 'image-generate': ['generate', 'generatePackageSha256'], 'image-edit': ['edit', 'editPackageSha256'] }
const fields = ['model', 'generatePackageSha256', 'editPackageSha256', 'channel', 'tier', 'priceVersion', 'mountPinnedSkill']
export function validateNativeImageSettings(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))
      || (value.mountPinnedSkill !== undefined && typeof value.mountPinnedSkill !== 'boolean')
      || !label(value.model) || ![value.generatePackageSha256, value.editPackageSha256].some(skillSha)
      || [value.generatePackageSha256, value.editPackageSha256].some(pin => pin !== undefined && !skillSha(pin))
      || [value.channel, value.tier, value.priceVersion].some(item => item !== undefined && !label(item))) fail('NATIVE_IMAGE_CONFIG_INVALID')
  return Object.freeze({ ...value })
}

export const pinnedImageOperation = (descriptor, settings) => settings && Object.hasOwn(packagePins, descriptor.skillKey)
  && skillSha(descriptor.packageSha256) && settings[packagePins[descriptor.skillKey][1]] === descriptor.packageSha256 ? packagePins[descriptor.skillKey][0] : null

export function selectNativeImageTool({ command, entries, store, settings, chatProvider }) {
  const previous = store.read('native-image-binding')
  const matches = entries.filter(({descriptor}) => pinnedImageOperation(descriptor,settings))
  if (!matches.length) {
    if (previous) fail('SKILL_RESULT_UNKNOWN') // never recover with the replaced script
    return null
  }
  // A rollout cannot reinterpret a turn already started using the script catalog.
  if (!previous && store.read('native-thread')) return null
  if (matches.length !== 1 || entries.length !== 1 || command.skills.length !== 1
      || command.toolPolicyRef !== NATIVE_SKILL_SCRIPT_POLICY || command.privateTools != null
      || !['TASK', 'PRIVATE'].includes(command.scope.kind) || !command.outputs.mimeTypes.includes('image/png')) fail('NATIVE_IMAGE_AUTHORIZATION_INVALID')
  const { descriptor } = matches[0], { skill, executionBinding } = command.skills[0]
  if (skill.key !== descriptor.skillKey || skill.packageSha256 !== descriptor.packageSha256
      || skill.version !== descriptor.skillVersion || executionBinding.skillInstallationId !== descriptor.skillInstallationId
      || executionBinding.executionId !== command.executionId || executionBinding.scopeSha256 !== skillDigest(command.scope)
      || !chatProvider?.id || typeof chatProvider.baseUrl !== 'string' || chatProvider.wireApi !== 'responses') fail('NATIVE_IMAGE_AUTHORIZATION_INVALID')
  const operation = packagePins[descriptor.skillKey][0]
  const binding = { operation, installationId: descriptor.skillInstallationId, packageSha256: descriptor.packageSha256,
    settingsSha256: skillDigest(settings), providerSha256: skillDigest(chatProvider) }
  if (previous && skillDigest(binding) !== skillDigest(previous)) fail('SKILL_RESULT_UNKNOWN')
  if (!previous) store.write('native-image-binding', binding)
  return operation
}

// A route commitment identifies comparable measured work, not a rate, permission, or proof of complete usage.
// No prompt, input, credential, execution ID, installation ID or historical tariff in this digest.
export function nativeImageRouteDigest(operation, settings, provider) {
  const spec = Object.values(packagePins).find(([op]) => op === operation)
  if (!spec || !settings || !skillSha(settings[spec[1]]) || ![settings.model, settings.channel, settings.tier, settings.priceVersion].every(label)
      || !provider?.id || provider.wireApi !== 'responses') return null
  let base; try { base = new URL(provider.baseUrl) } catch { return null }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !/^\/v1\/?$/.test(base.pathname)) return null
  return skillDigest(['NATIVE_PROVIDER_ROUTE_V1','openai-images-v1',operation,settings[spec[1]],settings.mountPinnedSkill === true,
    provider.id,base.origin + '/v1',settings.model,settings.channel,settings.tier,'openai-images-modalities-v1'])
}

export function nativeImageToolDefinition(operation) {
  if (!['generate','edit'].includes(operation)) fail('NATIVE_IMAGE_CONFIG_INVALID')
  const edit = operation === 'edit'
  return { type: 'function', name: edit ? 'native_image_edit' : 'native_image_generate',
    description: `${edit ? 'Edit approved image inputRefs' : 'Generate one image'} through the Agent image model. This may be a paid operation. Call only for the authorized user request, at most once. The response includes a read-only file path and an already staged artifactRef. Select the reference only if the original meets the request; otherwise use the tools and authorized skills available for the task.`,
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' },
      ...(edit ? { inputRefs: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string' } } } : {}) },
    required: ['prompt', ...(edit ? ['inputRefs'] : [])], additionalProperties: false } }
}

export function nativeImageToolPolicy({ operation, settings, chatProvider, configReadback, subjectHome, store, checkActive, signal, session, fetchFn, reconcileOnly }) {
  if (!reconcileOnly) {
    try { nativeImagesEndpoint(operation, chatProvider, configReadback()) } catch { fail('NATIVE_IMAGE_CONFIG_INVALID') }
  }
  const edit = operation === 'edit', tool = nativeImageToolDefinition(operation)
  return { tool, async call(ctx) {
    session.requireBoundTurn(ctx)
    if (store.read('result') || store.read('native-terminal') || store.read('native-selection')) fail('NATIVE_RESULT_ALREADY_FROZEN')
    const args = ctx.arguments
    if (!args || Object.keys(args).sort().join(',') !== (edit ? 'inputRefs,prompt' : 'prompt')) fail('NATIVE_TOOL_ARGUMENTS_INVALID', true)
    const active = () => {
      checkActive()
      if (store.read('native-selection') || store.read('native-terminal')) fail('NATIVE_RESULT_ALREADY_FROZEN')
    }
    try {
      const invoke = prepareNativeImageInvocation({ operation, model: settings.model, pricing: settings, subjectHome,
        chatProvider, configReadback: configReadback(), fetchFn, inputRefs: args.inputRefs, checkActive: active, store })
      const bytes = await invoke({ prompt: args.prompt, signal })
      return await session.stageHostImage(ctx, bytes)
    } catch (error) {
      if (['NATIVE_IMAGE_INPUT_INVALID', 'SKILL_INPUT_SNAPSHOT_INVALID', 'NATIVE_IMAGE_PROMPT_INVALID', 'NATIVE_IMAGE_ALREADY_STARTED'].includes(error.code)) fail(error.code, true)
      if (error.code?.startsWith('MODEL_AUTH_')) fail('NATIVE_IMAGE_CONFIG_INVALID')
      if (error.code === 'CONTROLLED_IMAGE_PROVIDER_REJECTED' || error.code === 'CONTROLLED_IMAGE_RESPONSE_INVALID') {
        store.write('native-image-failure', { code: error.code })
        fail('NATIVE_EXECUTION_TURN_FAILED')
      }
      throw error
    }
  } }
}
