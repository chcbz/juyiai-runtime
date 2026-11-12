// Offline source-entry acceptance; no installed services, package install or Provider calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '../../..');
const text = path => readFileSync(resolve(repo, path), 'utf8');
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'ur01-install-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appRoot = resolve(root, 'artifact-parent'); const calls = resolve(root, 'other-component-called');
  for (const path of ['shell', 'conf/cyf-agent-runtime-v1', 'home', 'bin', 'artifact-parent/cyf-agent-runtime-v1']) mkdirSync(resolve(root, path), { recursive: true });
  // Actual dispatcher/current Runtime source, with test-only no-effects generic helpers.
  // No actual common.sh or package/service helper can be invoked by these tests.
  copyFileSync(resolve(repo, 'shell/cyf_agent_runtime_v1_install.sh'), resolve(root, 'shell/cyf_agent_runtime_v1_install.sh'));
  cpSync(resolve(repo, 'conf/cyf-agent-runtime-v1'), resolve(root, 'conf/cyf-agent-runtime-v1'), { recursive: true });
  chmodSync(resolve(root, 'conf/cyf-agent-runtime-v1/install.sh'), 0o755);
  writeFileSync(resolve(root, 'shell/common.sh'), 'check_root() { :; }\ndetect_os() { :; }\nshow_os_info() { :; }\n');
  writeFileSync(resolve(root, 'shell/nginx_install.sh'), `#!/bin/bash\nprintf 'called\\n' > '${calls}'\nexit 0\n`);
  const node = resolve(root, 'bin/node'); const npm = resolve(root, 'bin/npm'); const python = resolve(root, 'bin/python');
  writeFileSync(node, '#!/bin/bash\nif [ "$1" = "-p" ]; then printf "99.0.0\\n"; else echo "fixture Node execution failure" >&2; exit 37; fi\n');
  for (const path of [npm, python]) writeFileSync(path, '#!/bin/bash\nexit 37\n');
  for (const path of [node, npm, python]) chmodSync(path, 0o755);
  const env = { PATH: '/usr/bin:/bin', HOME: resolve(root, 'home'), LANG: 'C.UTF-8',
    CYF_RUNTIME_V1_INSTANCE: 'offline-main', CYF_RUNTIME_V1_INSTALL_TEST_MODE: '1', CYF_RUNTIME_V1_TEST_APP_ROOT: appRoot,
    CYF_RUNTIME_V1_NODE_BIN: node, CYF_RUNTIME_V1_NPM_CLI: npm, CYF_RUNTIME_V1_PYTHON_BIN: python,
    OPENCLAW_API_KEY: 'obsolete-secret-must-not-be-used', START_CODEX_WS_AGENT: 'y' };
  return { root, calls, appRoot, env, run: (args, extraEnv = {}, input = 'y\n') => spawnSync('/bin/bash', [resolve(root, 'shell/cyf_agent_runtime_v1_install.sh'), ...args],
    { cwd: root, encoding: 'utf8', env: { ...env, ...extraEnv }, input }) };
}

test('standalone Runtime entry propagates installer failure and never calls unrelated components', t => {
  const f = fixture(t);
  const result = f.run([]);
  assert.equal(result.status, 37, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /fixture Node execution failure/);
  assert.match(result.stdout, /Runtime Node version: 99\.0\.0/);
  assert.equal(existsSync(f.calls), false);
  assert.deepEqual(readdirSync(resolve(f.appRoot, 'cyf-agent-runtime-v1')), []);
  const missing = f.run([], { CYF_RUNTIME_V1_INSTANCE: '' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CYF_RUNTIME_V1_INSTANCE must be a safe non-empty instance name/);
});

test('standalone repository does not include the unrelated installer dispatcher', () => {
  assert.equal(existsSync(resolve(repo, 'install.sh')), false);
  assert.equal(existsSync(resolve(repo, 'shell/new_api_deps_install.sh')), false);
});

test('no legacy unit source remains; current single-artifact units and installation guides name only the unified path', () => {
  for (const name of ['systemd/codex-bridge.service', 'systemd/codex-bridge@.service']) assert.equal(existsSync(resolve(repo, name)), false);
  const current = text('systemd/cyf-agent-runtime-v1@.service');
  assert.equal(current, text('conf/cyf-agent-runtime-v1/systemd/cyf-agent-runtime-v1@.service'));
  assert.match(current, /^ExecStart=.*\/node\/bin\/node .*\/runtime\/agent-runtime\.mjs run --config .*%i\.host\.json$/m);
  assert.equal(current.includes('/usr/bin/env node'), false); assert.equal(current.includes('agent-client.mjs'), false);
  const guide = text('skills/codex-bridge-install/SKILL.md'); assert.match(guide, /shell\/cyf_agent_runtime_v1_install\.sh/);
  assert.equal(guide.includes('shell/codex_ws_agent_install.sh'), false); assert.equal(guide.includes('/home/isp/bin/codex_ws_agent.sh start'), false);
  for (const removed of [
    'shell/codex_ws_agent_install.sh', 'bin/codex_ws_agent.sh',
    'conf/codex-bridge/env.example', 'conf/codex-bridge/codex-profiles.conf',
    'conf/codex-bridge/install-policy-check.mjs', 'conf/codex-bridge/install-candidate',
    'conf/codex-bridge/contracts/probes'
  ]) assert.equal(existsSync(resolve(repo, removed)), false, removed);
  const engine = text('conf/codex-bridge/agent-client.mjs');
  for (const removed of ['loadRuntimeConfig', 'legacyProfile', 'parseSectionProfiles', 'loadProfilesRaw', 'observeTypedRuntimeAuthentication'])
    assert.equal(engine.includes(removed), false, removed);

});

test('Runtime and execution-package metadata impose no project Node version gate', () => {
  for (const path of ['conf/cyf-agent-runtime-v1/package.json', 'conf/codex-bridge/package.json'])
    assert.equal(JSON.parse(text(path)).engines?.node, undefined, path);
  assert.equal(JSON.parse(text('conf/codex-bridge/package-lock.json')).packages[''].engines?.node, undefined);
});

// Fixed program directory does not use the instance/version as a payload path.
test('fixed app target refuses an existing artifact before executing toolchain or changing files', t => {
  const f = fixture(t);
  const app = resolve(f.appRoot, 'cyf-agent-runtime-v1/app');
  mkdirSync(app); writeFileSync(resolve(app, 'keep'), 'unchanged');
  const result = f.run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Runtime target exists/);
  assert.equal(readFileSync(resolve(app, 'keep'), 'utf8'), 'unchanged');
  assert.equal(existsSync(f.calls), false);
});

test('new artifact freezes its Python base after launcher relocation and before validation/publication', () => {
  const installer = text('conf/cyf-agent-runtime-v1/install.sh')
  const freeze = '"$STAGE/codex-bridge/.toolchain/bin/python" -I -B "$STAGE/runtime/lib/freeze-python.py" "$STAGE/codex-bridge/.toolchain"'
  assert.ok(installer.includes('lib/freeze-python.py'))
  assert.ok(installer.includes('lib/hosting-config.mjs'))
  assert.ok(installer.indexOf(freeze) > installer.lastIndexOf('\nPY_RUNTIME_RELOCATE\n'))
  assert.ok(installer.indexOf(freeze) < installer.indexOf('"$STAGE/runtime/validate.sh" --root "$STAGE"'))
  assert.ok(installer.indexOf(freeze) < installer.indexOf('mv -T -n "$STAGE" "$TARGET"'))
})

test('optional browser install consumes a paired archive/manifest before validation without downloading', () => {
  const installer = text('conf/cyf-agent-runtime-v1/install.sh')
  const extraction = installer.indexOf('--root "$STAGE/codex-bridge/.browser-toolchain"')
  assert.ok(extraction > 0 && extraction < installer.indexOf('"$STAGE/runtime/validate.sh" --root "$STAGE"'))
  for (const flag of ['--browser-archive', '--browser-manifest']) {
    const result = spawnSync('bash', [resolve(repo, 'conf/cyf-agent-runtime-v1/install.sh'), '--target', '/nonexistent/browser-fixture', flag, '/fixture'], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /usage:/)
  }
  assert.doesNotMatch(installer, /build-browser-toolchain\.sh|playwright install/)
})


test('sandbox image is prepared only in install stage after fixed dependencies and verified before publication', () => {
  const installer = text('conf/cyf-agent-runtime-v1/install.sh')
  const prepare = installer.indexOf('"$STAGE/node/bin/node" "$STAGE/runtime/lib/prepare-toolchain-image.mjs" --root "$STAGE"')
  assert.ok(installer.includes('lib/prepare-toolchain-image.mjs'))
  assert.ok(prepare > installer.indexOf('--root "$STAGE/codex-bridge/.browser-toolchain"'))
  assert.ok(prepare < installer.indexOf('"$STAGE/runtime/validate.sh" --root "$STAGE"'))
  assert.ok(prepare < installer.indexOf('mv -T -n "$STAGE" "$TARGET"'))
  assert.match(text('conf/cyf-agent-runtime-v1/validate.sh'), /validateNativeExecutionToolchain\(readNativeToolchainImage/)
  const startup = text('conf/codex-bridge/native-document-toolchain.mjs').split('// Load the installed immutable image')[1]
  assert.doesNotMatch(startup, /measureMinimalNativeExecutionToolchain|measureNativeDocumentToolchain|measureNativeBrowserToolchain|copyFileSync/)
})
