import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { loadNativeSkillConfiguration, resolveNativeSkillConfiguration, resolvePreparedNativeSkillConfiguration, nativeSkillOrigins, nativeSkillConfigurationPath, readNativeSkillSubjectConfig } from '../native-skill-config.mjs'
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'native-config-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const scope = { tenantId: 'tenant', ownerJiacn: 'owner', clientId: 'client', agentId: 'agent' }
  const descriptor = { skillInstallationId: 'installed1', skillKey: 'test-skill', packageSha256: 'a'.repeat(64) }
  const command = { toolPolicyRef: 'NATIVE_SKILL_SCRIPT_V1', skills: [{ skill: { key: descriptor.skillKey, packageSha256: descriptor.packageSha256 }, executionBinding: { skillInstallationId: 'installed1' } }] }
  const config = { schemaVersion: 1, scope, installations: {
    installed1: { configuration: { apiKey: 'synthetic-one' }, networkOrigins: ['https://example.invalid'] },
    installed2: { configuration: { apiKey: 'synthetic-foreign' }, networkOrigins: ['https://other.invalid'] }
  } }
  const file = resolve(root, 'config.json'), write = () => writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
  write(); return { root, file, scope, command, entries: [{ descriptor }], config, write }
}
test('only the authorized installation receives its customer configuration and exact origins', t => {
  const f = fixture(t), result = loadNativeSkillConfiguration(f)
  assert.equal(result.length, 1); assert.equal(result[0].configuration.apiKey, 'synthetic-one')
  assert.deepEqual(result[0].networkOrigins, ['https://example.invalid'])
  assert.equal(JSON.stringify(result).includes('synthetic-foreign'), false)
  assert.match(result[0].digest, /^[a-f0-9]{64}$/)
})
test('local-only and empty-skill executions never open customer configuration', t => {
  const f = fixture(t)
  assert.deepEqual(loadNativeSkillConfiguration({ ...f, file: '/missing', command: { ...f.command, toolPolicyRef: 'NATIVE_LOCAL_FILES_V1' } }), [])
  assert.deepEqual(loadNativeSkillConfiguration({ ...f, file: '/missing', entries: [] }), [])
})
test('scope, installation, private-file mode and symlink boundaries are enforced', t => {
  const f = fixture(t)
  assert.throws(() => loadNativeSkillConfiguration({ ...f, scope: { ...f.scope, ownerJiacn: 'foreign' } }), /SCOPE_MISMATCH/)
  assert.throws(() => loadNativeSkillConfiguration({ ...f, command: { ...f.command, skills: [] } }), /BINDING_INVALID/)
  chmodSync(f.file, 0o644); assert.throws(() => loadNativeSkillConfiguration(f), /UNSAFE/)
  chmodSync(f.file, 0o600); const link = resolve(f.root, 'link'); symlinkSync(f.file, link)
  assert.throws(() => loadNativeSkillConfiguration({ ...f, file: link }), /UNSAFE/)
})
test('missing installation config is not borrowed; updated values produce a different local binding', t => {
  const f = fixture(t), first = loadNativeSkillConfiguration(f)[0]
  f.config.installations.installed1.configuration.apiKey = 'changed'; f.write()
  assert.notEqual(loadNativeSkillConfiguration(f)[0].digest, first.digest)
  delete f.config.installations.installed1; f.write(); assert.deepEqual(loadNativeSkillConfiguration(f), [])
})
test('network scope is exact HTTPS origins, never arbitrary URLs or embedded credentials', () => {
  assert.deepEqual(nativeSkillOrigins(['https://example.invalid', 'https://example.invalid']), ['https://example.invalid'])
  for (const value of ['http://example.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/path', 'https://example.invalid?key=secret', '*']) assert.throws(() => nativeSkillOrigins([value]), /NETWORK_INVALID/)
})

test('missing configured file is an execution-scoped recoverable failure', t => {
  const f = fixture(t)
  rmSync(f.file)
  assert.throws(() => loadNativeSkillConfiguration(f), { code: 'NATIVE_SKILL_CONFIG_UNAVAILABLE' })
  f.write()
  assert.equal(loadNativeSkillConfiguration(f)[0].skillInstallationId, 'installed1')
})

test('hosted search is explicit, installation-bound and changes the pinned configuration digest', t => {
  const f = fixture(t), original = loadNativeSkillConfiguration(f)[0]
  f.config.installations.installed2.webSearch = 'live'; f.write()
  assert.deepEqual(loadNativeSkillConfiguration(f)[0], original)
  f.config.installations.installed1.webSearch = 'live'; f.write()
  const enabled = loadNativeSkillConfiguration(f)[0]
  assert.equal(enabled.webSearch, 'live')
  assert.notEqual(enabled.digest, original.digest)
  f.config.installations.installed1.webSearch = 'disabled'; f.write()
  assert.deepEqual(loadNativeSkillConfiguration(f)[0], original)
  f.config.installations.installed1.webSearch = 'cached'; f.write()
  assert.throws(() => loadNativeSkillConfiguration(f), /WEB_SEARCH_INVALID/)
})


test('operator directory configures only an exact managed subject without modifying hosting facts', t => {
  const f = fixture(t), file = nativeSkillConfigurationPath(f.root, f.scope)
  writeFileSync(file, JSON.stringify(f.config), { mode: 0o600 })
  const options = { ...f, file: undefined, directory: f.root }
  assert.equal(loadNativeSkillConfiguration(options)[0].configuration.apiKey, 'synthetic-one')
  assert.deepEqual(loadNativeSkillConfiguration({ ...options, scope: { ...f.scope, agentId: 'foreign' } }), [])
  assert.deepEqual(loadNativeSkillConfiguration({ ...options, scope: { ...f.scope, ownerJiacn: 'foreign' } }), [])
  assert.deepEqual(loadNativeSkillConfiguration({ ...options, scope: { ...f.scope, tenantId: 'foreign' } }), [])
  assert.deepEqual(loadNativeSkillConfiguration({ ...options, scope: { ...f.scope, clientId: 'foreign' } }), [])
  chmodSync(file, 0o644)
  assert.throws(() => loadNativeSkillConfiguration(options), /UNSAFE/)
})
test('explicit profile config retains precedence and local-only work never reads directory', t => {
  const f = fixture(t)
  assert.equal(loadNativeSkillConfiguration({ ...f, directory: '/missing' })[0].configuration.apiKey, 'synthetic-one')
  assert.deepEqual(loadNativeSkillConfiguration({ ...f, file: undefined, directory: '/missing', command: { toolPolicyRef: 'NATIVE_LOCAL_FILES_V1' } }), [])
  assert.deepEqual(loadNativeSkillConfiguration({ ...f, file: undefined, directory: undefined }), [])
})

test('managed subject can configure a native image model without image skill credentials or a template change', t => {
  const f = fixture(t)
  const settings = { model: 'image-model', generatePackageSha256: 'a'.repeat(64) }
  const options = { directory: f.root, scope: f.scope }
  assert.equal(readNativeSkillSubjectConfig(options), null)
  const path = nativeSkillConfigurationPath(f.root, f.scope)
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, scope: f.scope, installations: {}, nativeImage: settings }), { mode: 0o600 })
  assert.deepEqual(readNativeSkillSubjectConfig(options).nativeImage, settings)
  assert.deepEqual(loadNativeSkillConfiguration({ ...options, command: f.command, entries: f.entries }), [])
  assert.equal(readNativeSkillSubjectConfig({ ...options, scope: { ...f.scope, agentId: 'other' } }), null)
  assert.throws(() => readNativeSkillSubjectConfig({ file: path, scope: { ...f.scope, agentId: 'other' } }), /SCOPE_MISMATCH/)
})


test('registration preparation and actual command resolution share identical installed configuration without fake commands', t => {
  const f = fixture(t)
  const read = readNativeSkillSubjectConfig({ file: f.file, scope: f.scope })
  const prepared = resolvePreparedNativeSkillConfiguration(f.entries, read)
  assert.deepEqual(prepared, loadNativeSkillConfiguration(f))
  assert.deepEqual(prepared, resolveNativeSkillConfiguration(f.command, f.entries, read))
  assert.equal(JSON.stringify(prepared).includes('synthetic-foreign'), false)
  // Caller mutation cannot rewrite the operator source or a later execution.
  prepared[0].configuration.apiKey = 'changed-by-caller'
  assert.equal(read.installations.installed1.configuration.apiKey, 'synthetic-one')
  assert.equal(resolveNativeSkillConfiguration(f.command, f.entries, read)[0].configuration.apiKey, 'synthetic-one')
})

test('prepared configuration grants no execution permission and cannot bypass command binding', t => {
  const f = fixture(t)
  assert.equal(resolvePreparedNativeSkillConfiguration(f.entries, f.config).length, 1)
  for (const mutate of [c => { c.skills = [] }, c => { c.skills[0].skill.key = 'foreign' },
    c => { c.skills[0].skill.packageSha256 = 'b'.repeat(64) }, c => { c.skills[0].executionBinding.skillInstallationId = 'foreign' }]) {
    const command = structuredClone(f.command); mutate(command)
    assert.throws(() => resolveNativeSkillConfiguration(command, f.entries, f.config), /BINDING_INVALID/)
  }
})

test('preparation handles only selected installations, does not interpret names and does not infer combination support', t => {
  const f = fixture(t)
  f.entries.push({ descriptor: { skillInstallationId: 'installed2', skillKey: 'arbitrary-second-skill', packageSha256: 'b'.repeat(64) } })
  const prepared = resolvePreparedNativeSkillConfiguration(f.entries, f.config)
  assert.deepEqual(prepared.map(x => x.skillInstallationId), ['installed1', 'installed2'])
  // These are only private mounted values. No capability, route, scope or price is produced.
  assert.deepEqual(Object.keys(prepared[0]).sort(), ['configuration', 'digest', 'networkOrigins', 'skillInstallationId', 'skillKey'])
  assert.deepEqual(resolvePreparedNativeSkillConfiguration([], f.config), [])
  assert.deepEqual(resolvePreparedNativeSkillConfiguration(f.entries, null), [])
  delete f.config.installations.installed1
  assert.deepEqual(resolvePreparedNativeSkillConfiguration([f.entries[0]], f.config), [])
})

test('preparation and execution preserve the same origins, hosted-search and malformed-config semantics', t => {
  const f = fixture(t)
  f.config.installations.installed1.webSearch = 'live'
  assert.deepEqual(resolvePreparedNativeSkillConfiguration(f.entries, f.config), resolveNativeSkillConfiguration(f.command, f.entries, f.config))
  for (const mutate of [x => { x.webSearch = 'cached' }, x => { x.networkOrigins = ['http://unsafe.invalid'] }, x => { x.configuration = null }]) {
    const config = structuredClone(f.config); mutate(config.installations.installed1)
    assert.throws(() => resolvePreparedNativeSkillConfiguration(f.entries, config), /NATIVE_SKILL_/)
    assert.throws(() => resolveNativeSkillConfiguration(f.command, f.entries, config), /NATIVE_SKILL_/)
  }
})
