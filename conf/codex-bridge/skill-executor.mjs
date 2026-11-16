import { createHash } from 'node:crypto'
import { validateExecutionBinding } from './skill-management-wire.mjs'
import { parseSkillJson } from './skill-manifest.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
export const skillHash = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Emit members directly: rebuilding an object would re-order integer-shaped keys.
export const skillCanonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(skillCanonicalJson).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${skillCanonicalJson(value[key])}`).join(',')}}`
  if (value !== null && !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) fail('SKILL_CANONICAL_JSON_INVALID')
  return JSON.stringify(value)
}
export const skillDigest = value => skillHash(skillCanonicalJson(value))
export const skillId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)
export const skillSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const mime = value => typeof value === 'string' && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)

// Scope is execution identity, not an authorization decision. API owns permissions.
export const executionScopeValid = scope => object(scope)
  && Object.keys(scope).length === 4
  && ['kind', 'taskId', 'conversationId', 'conversationGeneration'].every(key => Object.hasOwn(scope, key))
  && skillId(scope.conversationId)
  && typeof scope.conversationGeneration === 'string' && /^[1-9][0-9]{0,18}$/.test(scope.conversationGeneration)
  && BigInt(scope.conversationGeneration) <= 9223372036854775807n
  && (scope.kind === 'PRIVATE' ? scope.taskId === null : scope.kind === 'TASK' && skillId(scope.taskId))

export const NATIVE_LOCAL_FILES_POLICY = 'NATIVE_LOCAL_FILES_V1'
export const NATIVE_SKILL_SCRIPT_POLICY = 'NATIVE_SKILL_SCRIPT_V1'
export function parseSkillCommand(raw) {
  const value = typeof raw === 'string' || Buffer.isBuffer(raw) ? parseSkillJson(raw) : structuredClone(raw)
  const fields = ['executionProtocolVersion', 'executionId', 'runId', 'scope',
    'commandId', 'messageId', 'skills', 'snapshotDigest', 'parameters', 'instruction', 'inputRefs', 'outputs', 'toolPolicyRef']
  if (!object(value) || !fields.every(key => Object.hasOwn(value, key)) || value.executionProtocolVersion !== 6
      || Object.hasOwn(value, 'skill') || Object.hasOwn(value, 'taskSkillBinding')
      || ['taskId', 'conversationId', 'conversationGeneration'].some(key => Object.hasOwn(value, key))
      || !['executionId', 'runId', 'commandId', 'messageId'].every(key => skillId(value[key]))
      || !executionScopeValid(value.scope)
      || !skillSha(value.snapshotDigest) || ![NATIVE_LOCAL_FILES_POLICY, NATIVE_SKILL_SCRIPT_POLICY].includes(value.toolPolicyRef)
      || !object(value.parameters) || typeof value.instruction !== 'string' || !value.instruction.trim()
      || !Array.isArray(value.inputRefs) || !value.inputRefs.every(skillId) || new Set(value.inputRefs).size !== value.inputRefs.length
      || !object(value.outputs) || !Array.isArray(value.outputs.mimeTypes)
      || !value.outputs.mimeTypes.every(mime) || typeof value.outputs.multiple !== 'boolean' || typeof value.outputs.artifactsRequired !== 'boolean'
      || !Array.isArray(value.skills)) fail('SKILL_COMMAND_INVALID')
  if (value.toolPolicyRef === NATIVE_SKILL_SCRIPT_POLICY && value.skills.length === 0) fail('SKILL_COMMAND_INVALID')
  value.outputs = { ...value.outputs, dataSchema: value.outputs.dataSchema ?? null }
  const installations = new Set()
  for (const item of value.skills) {
    const skill = item?.skill
    if (!object(skill) || !skillId(skill.key) || !skillId(skill.version) || !skillSha(skill.packageSha256) || skill.manifestSha256 !== null && !skillSha(skill.manifestSha256)) fail('SKILL_COMMAND_INVALID')
    if (Object.hasOwn(item, 'taskSkillBinding')) fail('SKILL_COMMAND_INVALID')
    let binding
    try { binding = validateExecutionBinding(item.executionBinding) } catch { fail('SKILL_COMMAND_INVALID') }
    if (binding.executionId !== value.executionId || binding.scopeSha256 !== skillDigest(value.scope) || binding.skillKey !== skill.key || binding.skillVersion !== skill.version
        || binding.packageSha256 !== skill.packageSha256 || binding.manifestSha256 !== skill.manifestSha256
        || installations.has(binding.skillInstallationId)) fail('SKILL_COMMAND_INVALID')
    installations.add(binding.skillInstallationId)
  }
  // Ignore documented harmless extensions, never interpret them as authority.
  return Object.fromEntries(fields.map(key => [key, value[key]]))
}

/** Single native executor; protocols1–5 are historical read-only, never resumed. */
export async function executeSkill(raw, ctx) {
  const command = parseSkillCommand(raw)
  const claim = await ctx.claimOrResume(command)
  if (claim.failureReceipt) return claim.failureReceipt
  if (claim.resultManifest) {
    const receipt = await ctx.recoverCommittedResult(command, null, claim.resultManifest)
    await ctx.persistReceipt(command, claim.resultManifest, receipt)
    return receipt
  }
  let manifest = await ctx.loadResult(command)
  if (!manifest) {
    const entries = []
    for (const item of command.skills) entries.push(await ctx.registry.requireNativePackage({ skillKey: item.skill.key, skillVersion: item.skill.version,
      packageSha256: item.skill.packageSha256, manifestSha256: item.skill.manifestSha256 }, { executionBinding: item.executionBinding }))
    const inputs = await ctx.materializeAuthorizedInputs(command, null)
    if (typeof ctx.runNative !== 'function') fail('SKILL_NATIVE_ADAPTER_MISSING')
    manifest = await ctx.runNative({ command, inputs, entries })
  }
  if (manifest.executionId !== command.executionId || manifest.snapshotDigest !== command.snapshotDigest) fail('SKILL_RESULT_BINDING_INVALID')
  if (manifest.result.artifacts.length) await ctx.stageOutputs(command, manifest.result.artifacts)
  const receipt = await ctx.commitResult(command, manifest)
  await ctx.persistReceipt(command, manifest, receipt)
  return receipt
}
