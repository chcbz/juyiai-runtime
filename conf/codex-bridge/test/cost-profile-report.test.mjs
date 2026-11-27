import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { costProfileReport, costProfileReporter, encodeCostProfileValue, installedSingleSkillCostProfiles } from '../cost-profile-report.mjs'

const H = 'a'.repeat(64)
const fixture = () => ({ profileId: 'summary', revision: '1', selectionPriority: '0',
  scopePattern: [{ slot: '0', capabilityId: 'text.summary', capabilityVersion: '1', specSha: H, dependsOn: [],
    skillKey: 'summary', skillVersion: '1', packageSha: H, installId: 'install' }],
  executionStrategyVersion: 'native-1', contextPolicyId: 'context-1', contextPolicyVersion: H,
  toolPolicyVersion: H, capturePolicyVersion: 'capture-1',
  routeRefs: [{ kind: 'MODEL', component: 'OUTPUT', namespace: 'namespace', modelOrTool: 'model', normalizationBasis: 'TOKENS_V1' }] })

test('matches independently pinned Java cost-profile encoding and hashes byte for byte', () => {
  const report = costProfileReport('1', [fixture()])
  assert.equal(report.profiles[0].measurementSha, 'bb6aff8ed243ccf9e146640c6a10f37138af8c82f1014c1c7cdb24b255c2f220')
  assert.equal(report.sha256, '729eff1e98d5f9fdbf2a0249d8b81a676da8a4936fefe47b1d718750b8fb6068')
  assert.equal(encodeCostProfileValue({ schema: report.schema, profiles: report.profiles }).length, 1042)
  assert.equal(costProfileReport('2', [fixture()]).sha256, report.sha256)
})

test('sequence tracks semantic report changes, empty withdrawal, and session reset without retaining caller objects', () => {
  const report = costProfileReporter(), p = fixture()
  const first = report([p]); assert.equal(first.sequence, '1')
  first.profiles[0].routeRefs[0].modelOrTool = 'tampered'
  assert.equal(report([p]).sequence, '1')
  p.revision = '2'; assert.equal(report([p]).sequence, '2')
  assert.equal(report([]).sequence, '3'); assert.equal(report([]).sequence, '3')
  assert.equal(report([p]).sequence, '4')
  assert.equal(costProfileReporter()([p]).sequence, '1')
})

test('invalid inputs do not advance sequence or silently withdraw valid cost evidence', () => {
  const report = costProfileReporter(); const a = report([fixture()])
  assert.throws(() => report([{ ...fixture(), revision: 2 }]), /Invalid runtime/)
  assert.deepEqual(report([fixture()]), a)
})

test('normalizes declaration order while preserving scope dependency and installation identity', () => {
  const a = fixture(), b = { ...fixture(), profileId: 'other', selectionPriority: '1' }
  assert.deepEqual(costProfileReport('1', [a, b]), costProfileReport('1', [b, a]))
  const changed = structuredClone(a); changed.scopePattern[0].installId = 'another'
  assert.notEqual(costProfileReport('1', [changed]).sha256, costProfileReport('1', [a]).sha256)
  const composite = fixture()
  composite.scopePattern.push({ ...composite.scopePattern[0], slot: '1', dependsOn: ['0'] })
  const dependent = costProfileReport('1', [composite])
  composite.scopePattern[1].dependsOn = []
  assert.notEqual(costProfileReport('1', [composite]).sha256, dependent.sha256)
})

test('rejects extra fields, duplicate identities, fake hashes, coercion and numeric overflow', () => {
  for (const mutate of [p => { p.url = 'private' }, p => { p.selectionPriority = '01' }, p => { p.revision = '0' },
    p => { p.revision = '9223372036854775808' }, p => { p.selectionPriority = '2147483648' },
    p => { p.contextPolicyVersion = 'label' }, p => { p.scopePattern[0].slot = 0 },
    p => { p.scopePattern[0].specSha = 'A'.repeat(64) }, p => { p.routeRefs.push({ ...p.routeRefs[0] }) },
    p => { p.scopePattern[0].dependsOn = ['0'] }, p => { p.profileId = '\ud800' }]) {
    const p = fixture(); mutate(p); assert.throws(() => costProfileReport('1', [p]), /Invalid runtime/)
  }
  assert.throws(() => costProfileReport('1', [fixture(), fixture()]))
  for (const sequence of ['0', '01', 1, '9223372036854775808']) assert.throws(() => costProfileReport(sequence, []))
})

test('enforces count limits and rejects sparse declarations', () => {
  const p = fixture(); p.scopePattern = []; assert.throws(() => costProfileReport('1', [p]))
  p.scopePattern = Array(1); assert.throws(() => costProfileReport('1', [p]))
  assert.throws(() => costProfileReport('1', Array(1)))
  assert.throws(() => costProfileReport('1', Array.from({ length: 33 }, (_, i) => ({ ...fixture(), profileId: String(i), selectionPriority: String(i) }))))
  p.scopePattern = fixture().scopePattern; p.routeRefs = Array(129).fill(fixture().routeRefs[0])
  assert.throws(() => costProfileReport('1', [p]))
})

test('canonical encoding uses UTF8 ordering, preserves null and forbids implicit numeric conversion', () => {
  const x = { '\u{10000}': 'supplementary', '\ue000': 'bmp' }
  const y = { '\ue000': 'bmp', '\u{10000}': 'supplementary' }
  assert.deepEqual(encodeCostProfileValue(x), encodeCostProfileValue(y))
  const encoded = encodeCostProfileValue(x)
  assert.ok(encoded.indexOf(Buffer.from('\ue000')) < encoded.indexOf(Buffer.from('\u{10000}')))
  assert.notDeepEqual(encodeCostProfileValue(null), encodeCostProfileValue(''))
  assert.throws(() => encodeCostProfileValue(0)); assert.throws(() => encodeCostProfileValue(true))
})


test('total wire size remains bounded even when individual profile lists fit', () => {
  const p = fixture()
  p.scopePattern = Array.from({ length: 128 }, (_, i) => ({ ...p.scopePattern[0], slot: String(i), installId: 'i'.repeat(128) }))
  const profiles = Array.from({ length: 32 }, (_, i) => ({ ...p, profileId: String(i), selectionPriority: String(i) }))
  assert.throws(() => costProfileReport('1', profiles), /Invalid runtime/)
})


test('same measured wire fixture as API rejects Runtime supplied tariff authority', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/cost-profile-report.json', import.meta.url), 'utf8'))
  assert.deepEqual(costProfileReport('1', [fixture()]), expected)
  for (const field of ['channel', 'tier']) {
    const p = fixture(); p.routeRefs[0][field] = 'forged'
    assert.throws(() => costProfileReport('1', [p]), /Invalid runtime/)
  }
})


test('source references share capture namespace bytes and never include tariff or endpoint secrets', async () => {
  const { meteredProviderNamespace, measuredCostRouteReference } = await import('../metered-cost-route.mjs')
  const { skillDigest } = await import('../skill-executor.mjs')
  const base = { kind: 'MODEL_RESPONSE', component: 'INFERENCE', providerId: 'provider',
    baseUrl: 'https://gateway.example/v1/', modelOrTool: 'model', normalizationBasis: 'RESPONSES_TEXT_TOKENS_V1' }
  const route = measuredCostRouteReference(base)
  assert.equal(route.namespace, skillDigest(['METERED_PROVIDER_NAMESPACE_V1', 'provider', 'https://gateway.example/v1']))
  assert.equal(route.namespace, meteredProviderNamespace('provider', 'https://gateway.example/v1'))
  assert.notEqual(route.namespace, measuredCostRouteReference({ ...base, baseUrl: 'https://other.example/v1' }).namespace)
  assert.notEqual(route.namespace, measuredCostRouteReference({ ...base, providerId: 'another' }).namespace)
  assert.deepEqual(Object.keys(route).sort(), ['component', 'kind', 'modelOrTool', 'namespace', 'normalizationBasis'])
  assert.ok(Object.isFrozen(route))
  const p = fixture(); p.routeRefs = [route]; assert.equal(costProfileReport('1', [p]).profiles[0].routeRefs[0].namespace, route.namespace)
  for (const change of [{ kind: '' }, { normalizationBasis: ' ' }, { modelOrTool: 'm'.repeat(129) }, { providerId: '' }])
    assert.throws(() => measuredCostRouteReference({ ...base, ...change }))
})

const measuredInstallation = (capability = 'text.summary') => {
  const { profileId, revision, selectionPriority, scopePattern, ...configuration } = fixture()
  return { descriptor: { skillKey: capability, skillVersion: '1', packageSha256: H, skillInstallationId: 'install-' + capability,
    quoteSpecBindings: [{ capabilityId: capability, capabilityVersion: '1', specSha: H }] }, configuration }
}

test('actual single-skill measurements use installed semantic bindings, never skill-name pricing or inferred composition', () => {
  const publish = installedSingleSkillCostProfiles()
  const inputs = ['text.summary', 'document.extract', 'visual.asset'].map(measuredInstallation)
  const profiles = publish(inputs)
  assert.equal(profiles.length, 3)
  assert.equal(new Set(profiles.map(p => p.selectionPriority)).size, 3)
  assert.deepEqual(profiles.map(p => p.scopePattern[0].capabilityId).sort(), inputs.map(p => p.descriptor.skillKey).sort())
  for (const p of profiles) {
    assert.equal(p.scopePattern.length, 1)
    assert.deepEqual(p.scopePattern[0].dependsOn, [])
    assert.equal(p.revision, '1')
    assert.equal(p.scopePattern[0].installId, 'install-' + p.scopePattern[0].capabilityId)
  }
  assert.deepEqual(publish([...inputs].reverse()), profiles)
  assert.equal(costProfileReport('1', profiles).profiles.length, 3)
  assert.deepEqual(installedSingleSkillCostProfiles()([{ ...inputs[0], configuration: null }]), [])
  assert.deepEqual(installedSingleSkillCostProfiles()([{ ...inputs[0], descriptor: { ...inputs[0].descriptor, quoteSpecBindings: [] } }]), [])
})

test('measured profile revisions follow actual configuration and installed bytes, not call count or caller mutation', () => {
  const publish = installedSingleSkillCostProfiles(), input = measuredInstallation()
  const first = publish([input]); first[0].routeRefs[0].namespace = 'tampered'
  const unchanged = publish([input]); assert.equal(unchanged[0].revision, '1')
  assert.notEqual(unchanged[0].routeRefs[0].namespace, 'tampered')
  const moved = { ...input, descriptor: { ...input.descriptor, packageSha256: 'b'.repeat(64) } }
  assert.equal(publish([moved])[0].revision, '2'); assert.equal(publish([moved])[0].revision, '2')
  assert.deepEqual(publish([]), []); assert.equal(publish([input])[0].revision, '4')
  assert.equal(installedSingleSkillCostProfiles()([input])[0].revision, '1')
  assert.throws(() => publish([input, input]), /Invalid runtime/)
  assert.equal(publish([input])[0].revision, '4')
  assert.throws(() => publish([{ ...input, descriptor: { ...input.descriptor, skillInstallationId: null } }]), /Invalid runtime/)
  assert.throws(() => publish(Array.from({ length: 33 }, (_, i) => measuredInstallation('capability-' + i))), /Invalid runtime/)
  assert.equal(publish([input])[0].revision, '4')
})
