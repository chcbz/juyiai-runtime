import { createHash } from 'node:crypto'

// Private COST_PROFILES_V1 producer codec. Inputs must come from measured execution
// configuration and authorized installed descriptors; this module grants neither.
const SCHEMA = 'COST_PROFILES_V1'
const LONG_MAX = 9223372036854775807n
const INT_MAX = 2147483647n
const invalid = () => { throw new TypeError('Invalid runtime cost profile declaration') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => {
  if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid()
  return value
}
const utf8Compare = (a, b) => Buffer.compare(Buffer.from(text(a)), Buffer.from(text(b)))
const whitespace = /^[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]|[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]$/u
const id = (value, max) => {
  text(value)
  if (!value.length || [...value].length > max || whitespace.test(value)) invalid()
  return value
}
const sha = value => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid(); return value }
const decimal = (value, max = LONG_MAX, positive = false) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) invalid()
  const n = BigInt(value)
  if (n > max || (positive && n === 0n)) invalid()
  return value
}
const keys = (value, expected) => {
  if (!object(value) || Object.keys(value).length !== expected.length || expected.some(k => !Object.hasOwn(value, k))) invalid()
}
const list = (value, max, nonempty = false) => {
  if (!Array.isArray(value) || value.length > max || (nonempty && !value.length)) invalid()
  // Sparse arrays are not declarations and must not disappear during map/JSON encoding.
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) invalid()
  return value
}

// E is shared with API CanonicalValueEncoding, not JSON.stringify or the old
// skillDigest. All business numeric/boolean values have already become strings.
export function encodeCostProfileValue(value) {
  const prefix = (tag, n) => { const b = Buffer.alloc(5); b[0] = tag; b.writeUInt32BE(n, 1); return b }
  const encode = (v, depth) => {
    if (depth > 12) invalid()
    if (v === null) return Buffer.from([0x6e])
    if (typeof v === 'string') { const b = Buffer.from(text(v)); return Buffer.concat([prefix(0x73, b.length), b]) }
    if (Array.isArray(v)) { list(v, 4096); return Buffer.concat([prefix(0x61, v.length), ...v.map(x => encode(x, depth + 1))]) }
    if (object(v)) {
      const names = Object.keys(v).sort(utf8Compare)
      return Buffer.concat([prefix(0x6f, names.length), ...names.flatMap(k => [encode(k, depth + 1), encode(v[k], depth + 1)])])
    }
    invalid()
  }
  return encode(value, 0)
}
const digest = value => createHash('sha256').update(encodeCostProfileValue(value)).digest('hex')
const PROFILE_KEYS = ['profileId', 'revision', 'selectionPriority', 'scopePattern', 'executionStrategyVersion', 'contextPolicyId', 'contextPolicyVersion', 'toolPolicyVersion', 'capturePolicyVersion', 'routeRefs']
const SLOT_KEYS = ['slot', 'capabilityId', 'capabilityVersion', 'specSha', 'dependsOn', 'skillKey', 'skillVersion', 'packageSha', 'installId']
const ROUTE_KEYS = ['kind', 'component', 'namespace', 'modelOrTool', 'normalizationBasis']
const ordered = names => (a, b) => { for (const k of names) { const c = utf8Compare(a[k], b[k]); if (c) return c } return 0 }
const unique = values => { if (new Set(values).size !== values.length) invalid() }

// Shared strict resource reference; provenance remains the caller's responsibility.
export function costRouteObservation(input) {
  keys(input, ROUTE_KEYS)
  return Object.fromEntries(ROUTE_KEYS.map(k => [k, id(input[k], 128)]))
}

const CONFIGURATION_KEYS=['executionStrategyVersion','contextPolicyId','contextPolicyVersion','toolPolicyVersion','capturePolicyVersion','routeRefs']
// Shared semantic value; callers independently establish registration/actual-launch provenance.
export function costConfigurationObservation(input) {
  keys(input,CONFIGURATION_KEYS)
  const routeRefs = list(input.routeRefs, 128, true).map(costRouteObservation).sort(ordered(ROUTE_KEYS))
  unique(routeRefs.map(r => JSON.stringify(r)))
  return {executionStrategyVersion:id(input.executionStrategyVersion,64),contextPolicyId:id(input.contextPolicyId,128),
    contextPolicyVersion:sha(input.contextPolicyVersion),toolPolicyVersion:sha(input.toolPolicyVersion),
    capturePolicyVersion:id(input.capturePolicyVersion,64),routeRefs}
}

function profile(input) {
  keys(input, PROFILE_KEYS)
  const slots = list(input.scopePattern, 128, true).map((s, index) => {
    keys(s, SLOT_KEYS)
    if (decimal(s.slot, INT_MAX) !== String(index)) invalid()
    const dependencies = list(s.dependsOn, 128).map(d => {
      decimal(d, INT_MAX); if (BigInt(d) >= BigInt(index)) invalid(); return d
    })
    unique(dependencies)
    return { slot: s.slot, capabilityId: id(s.capabilityId, 128), capabilityVersion: id(s.capabilityVersion, 64),
      specSha: sha(s.specSha), dependsOn: dependencies.sort((a, b) => Number(a) - Number(b)),
      skillKey: id(s.skillKey, 128), skillVersion: id(s.skillVersion, 64), packageSha: sha(s.packageSha), installId: id(s.installId, 128) }
  })
  const configuration=costConfigurationObservation(Object.fromEntries(CONFIGURATION_KEYS.map(k=>[k,input[k]])))
  const result = { profileId: id(input.profileId, 128), revision: decimal(input.revision, LONG_MAX, true),
    selectionPriority: decimal(input.selectionPriority, INT_MAX), scopePattern: slots, ...configuration }
  return { ...result, measurementSha: digest(result) }
}

export function costProfileReport(sequence, measuredProfiles) {
  decimal(sequence, LONG_MAX, true)
  const profiles = list(measuredProfiles, 32).map(profile).sort(ordered(['profileId']))
  unique(profiles.map(p => p.profileId)); unique(profiles.map(p => p.selectionPriority))
  const configuration = { schema: SCHEMA, profiles }
  const result = { ...configuration, sequence, sha256: digest(configuration) }
  if (Buffer.byteLength(JSON.stringify(result)) > 1048576) invalid()
  return result
}

// One instance per authenticated session. Invalid measurement never advances the
// sequence; absence is explicitly represented by [] by the lifecycle owner.
export function costProfileReporter() {
  let sequence = 0n, previous = null
  return measuredProfiles => {
    const result = costProfileReport('1', measuredProfiles)
    const next = previous === result.sha256 ? sequence : sequence + 1n
    if (next > LONG_MAX) invalid()
    result.sequence = String(next)
    sequence = next; previous = result.sha256
    return result
  }
}

// One publisher per execution subject/session. Each supplied entry is a single-skill
// adapter measurement, not an inferred combination of installed skills. Unknown or
// unmeasured adapters are omitted by the caller and do not acquire execution authority.
export function installedSingleSkillCostProfiles() {
  let revision = 0n, previous = null
  return measurements => {
    const profiles = []
    for (const { descriptor, configuration } of measurements) {
      if (!configuration) continue
      for (const binding of descriptor.quoteSpecBindings ?? []) {
        const scopePattern = [{ slot: '0', capabilityId: binding.capabilityId, capabilityVersion: binding.capabilityVersion,
          specSha: binding.specSha, dependsOn: [], skillKey: descriptor.skillKey, skillVersion: descriptor.skillVersion,
          packageSha: descriptor.packageSha256, installId: descriptor.skillInstallationId }]
        profiles.push({ ...configuration, profileId: digest([descriptor.skillKey, binding.capabilityId, binding.capabilityVersion]),
          revision: '1', selectionPriority: '0', scopePattern })
      }
    }
    profiles.sort(ordered(['profileId']))
    profiles.forEach((p, index) => { p.selectionPriority = String(index) })
    // Validate the whole report before changing lifecycle state; do not truncate an oversized catalogue.
    const identity = costProfileReport('1', profiles).sha256
    const next = identity === previous ? revision : revision + 1n
    const report = costProfileReport('1', profiles.map(p => ({ ...p, revision: String(next) })))
    revision = next; previous = identity
    return report.profiles.map(({ measurementSha, ...p }) => p)
  }
}
