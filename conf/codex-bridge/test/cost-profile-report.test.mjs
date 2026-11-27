import test from 'node:test'
import assert from 'node:assert/strict'
import { costProfileReport, costProfileReporter, encodeCostProfileValue } from '../cost-profile-report.mjs'

const H = 'a'.repeat(64)
const fixture = () => ({ profileId: 'summary', revision: '1', selectionPriority: '0',
  scopePattern: [{ slot: '0', capabilityId: 'text.summary', capabilityVersion: '1', specSha: H, dependsOn: [],
    skillKey: 'summary', skillVersion: '1', packageSha: H, installId: 'install' }],
  executionStrategyVersion: 'native-1', contextPolicyId: 'context-1', contextPolicyVersion: H,
  toolPolicyVersion: H, capturePolicyVersion: 'capture-1',
  routes: [{ kind: 'MODEL', component: 'OUTPUT', channel: 'channel', modelOrTool: 'model', tier: 'default', normalizationBasis: 'TOKENS_V1' }] })

test('matches independently pinned Java cost-profile encoding and hashes byte for byte', () => {
  const report = costProfileReport('1', [fixture()])
  assert.equal(report.profiles[0].configSha, '8065776bbe21d93d2c0b4f7547921b7dc34238bcda64c12078273ee0e427a432')
  assert.equal(report.sha256, '4d5508e8c8cf0e02cfabbad11422e7a747f9a15e0e12dba90db17bc66721fed1')
  assert.equal(encodeCostProfileValue({ schema: report.schema, profiles: report.profiles }).length, 1051)
  assert.equal(costProfileReport('2', [fixture()]).sha256, report.sha256)
})

test('sequence tracks semantic report changes, empty withdrawal, and session reset without retaining caller objects', () => {
  const report = costProfileReporter(), p = fixture()
  const first = report([p]); assert.equal(first.sequence, '1')
  first.profiles[0].routes[0].modelOrTool = 'tampered'
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
    p => { p.scopePattern[0].specSha = 'A'.repeat(64) }, p => { p.routes.push({ ...p.routes[0] }) },
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
  p.scopePattern = fixture().scopePattern; p.routes = Array(129).fill(fixture().routes[0])
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
