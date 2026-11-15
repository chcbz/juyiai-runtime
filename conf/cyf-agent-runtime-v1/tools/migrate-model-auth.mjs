// Offline, operator-invoked cutover only. Not imported by the running host.
// Caller owns the existing release lock and has stopped all configuration writers.
import { constants, lstat, open, readdir, rename, unlink, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalHostingPath, validateHostingConfig } from '../lib/hosting-config.mjs';
import { runtimeSubjectKey } from '../lib/manifest.mjs';
import { parseModelAuth, serializeModelAuth, validateModelAuth } from '../../codex-bridge/model-auth.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;
export function fileAuthToml(text, { legacy = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) fail('AUTH_MIGRATION_CONFIG_INVALID');
  const lines = text.split(/\r?\n/); const output = []; let stores = 0;
  for (const line of lines) {
    if (/^\s*preferred_auth_method\s*=/.test(line)) continue;
    if (/^\s*cli_auth_credentials_store\s*=/.test(line)) { if (++stores > 1) fail('AUTH_MIGRATION_CONFIG_INVALID'); continue; }
    if (/^\s*env_key\s*=/.test(line)) { if (!legacy) fail('AUTH_MIGRATION_CONFIG_CONFLICT'); continue; }
    output.push(legacy ? line.replace(/^(\s*requires_openai_auth\s*=\s*)false\s*$/, '$1true') : line);
  }
  return 'cli_auth_credentials_store = "file"\n' + output.join('\n');
}
export function migrateModelTemplate(template) {
  if (template === null) return null;
  const next = structuredClone(template);
  if (Object.hasOwn(next, 'modelAuth')) {
    if (Object.hasOwn(next, 'providerEnvironment')) fail('AUTH_MIGRATION_TEMPLATE_CONFLICT');
    validateModelAuth(next.modelAuth); return next;
  }
  if (Object.keys(next).sort().join(',') !== 'codexConfig,profile,providerEnvironment') fail('AUTH_MIGRATION_TEMPLATE_INVALID');
  const keys = [...next.codexConfig.matchAll(/^\s*env_key\s*=\s*"(CYF_MANAGED_PROVIDER_[A-Z][A-Z0-9_]*)"\s*$/gm)];
  if (keys.length !== 1 || !next.providerEnvironment || Object.keys(next.providerEnvironment).length !== 1
      || !Object.hasOwn(next.providerEnvironment, keys[0][1])) fail('AUTH_MIGRATION_TEMPLATE_CONFLICT');
  next.modelAuth = { auth_mode: 'apikey', OPENAI_API_KEY: next.providerEnvironment[keys[0][1]] };
  validateModelAuth(next.modelAuth); next.codexConfig = fileAuthToml(next.codexConfig, { legacy: true });
  delete next.providerEnvironment; return next;
}
async function privateRead(path, optional = false, publicFile = false) {
  await canonicalHostingPath(path); let fd;
  try {
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await fd.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & (publicFile ? 0o022 : 0o077)) fail('AUTH_MIGRATION_FILE_UNSAFE');
    return await fd.readFile();
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  finally { await fd?.close(); }
}
export async function planModelAuthMigration(hostPath) {
  const changes = new Map();
  const readJson = async path => JSON.parse(await privateRead(path));
  const record = async (path, next, optional = false) => {
    const before = await privateRead(path, optional); const after = Buffer.from(next);
    if (before?.equals(after)) return;
    if (changes.has(path) && !changes.get(path).after.equals(after)) fail('AUTH_MIGRATION_DUPLICATE_CONFLICT');
    changes.set(path, { path, before, after });
  };
  const host = await readJson(hostPath); const configPath = host.hostingControlPath;
  const config = await readJson(configPath); const updated = { ...config, template: migrateModelTemplate(config.template) };
  validateHostingConfig(updated); await record(configPath, json(updated));
  const root = config.managedRoot; const journalPath = resolve(root, 'hosting-journal.json');
  const journal = await readJson(journalPath); const nextJournal = structuredClone(journal);
  const templates = new Map();
  const collect = async (key, old, next) => {
    if (templates.has(key) && JSON.stringify(templates.get(key).next) !== JSON.stringify(next)) fail('AUTH_MIGRATION_TEMPLATE_CONFLICT');
    templates.set(key, { old, next });
    validateHostingConfig({ ...updated, template: next });
  };
  for (const [key, subject] of Object.entries(nextJournal.subjects)) {
    if (runtimeSubjectKey(subject.manifest) !== key) fail('AUTH_MIGRATION_SUBJECT_INVALID');
    if (subject.staticProfileId !== undefined) { if (subject.template !== null) fail('AUTH_MIGRATION_SUBJECT_INVALID'); continue; }
    const old = subject.template; subject.template = migrateModelTemplate(old);
    await collect(key, old, subject.template);
  }
  await record(journalPath, json(nextJournal));
  for (const name of await readdir(root)) {
    if (!name.startsWith('target-') || !name.endsWith('.json')) continue;
    const path = resolve(root, name); const target = await readJson(path); const key = runtimeSubjectKey(target.subject);
    if (name !== `target-${key}.json` || target.formatVersion !== 1) fail('AUTH_MIGRATION_TARGET_INVALID');
    const old = target.template; target.template = migrateModelTemplate(old); await collect(key, old, target.template); await record(path, json(target));
  }
  for (const [key, { old, next }] of templates) {
    const home = resolve(root, key, 'home');
    try { const st = await lstat(home); if (!st.isDirectory() || st.uid !== process.getuid() || st.mode & 0o077) fail('AUTH_MIGRATION_HOME_UNSAFE'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const path = resolve(home, 'config.toml'); const current = await privateRead(path, true);
    if (current && ![old.codexConfig, next.codexConfig].includes(current.toString())) fail('AUTH_MIGRATION_CONFIG_CONFLICT');
    await record(path, next.codexConfig, true);
    const authPath = resolve(home, 'auth.json'); const auth = await privateRead(authPath, true);
    if (auth && parseModelAuth(auth).OPENAI_API_KEY !== next.modelAuth.OPENAI_API_KEY) fail('AUTH_MIGRATION_AUTH_CONFLICT');
    await record(authPath, serializeModelAuth(next.modelAuth), true);
  }
  for (const entry of host.agents) {
    const profile = await readJson(entry.profilePath); const home = profile.codexHome;
    const auth = parseModelAuth(await privateRead(resolve(home, 'auth.json')));
    const path = resolve(home, 'config.toml'); await record(path, fileAuthToml((await privateRead(path)).toString()));
    if (entry.publicFilesPath) {
      const baseline = await readJson(entry.publicFilesPath); const manifest = JSON.parse(await privateRead(entry.manifestPath, false, true));
      if (['tenantId', 'clientId', 'canonicalAgentId'].some(k => baseline[k] !== manifest[k])) fail('AUTH_MIGRATION_BASELINE_IDENTITY');
      const baselineAuth = parseModelAuth(baseline.files['auth.json']);
      if (baselineAuth.OPENAI_API_KEY !== auth.OPENAI_API_KEY) fail('AUTH_MIGRATION_AUTH_CONFLICT');
      baseline.files['config.toml'] = fileAuthToml(baseline.files['config.toml']);
      await record(entry.publicFilesPath, json(baseline));
    }
  }
  return [...changes.values()];
}
async function atomic(path, bytes) {
  const tmp = `${path}.${randomUUID()}.auth-migration.tmp`;
  const fd = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  try { await rename(tmp, path); const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await dir.sync(); } finally { await dir.close(); } }
  finally { await unlink(tmp).catch(() => {}); }
}
export async function applyModelAuthMigration(plan, backup, { beforeWrite = () => {} } = {}) {
  for (const row of plan) {
    const current = await privateRead(row.path, true);
    if (current === null ? row.before !== null : !row.before?.equals(current)) fail('AUTH_MIGRATION_CAS_CONFLICT');
  }
  await mkdir(backup, { mode: 0o700 });
  // Private backup contains secrets. Never include these bytes or hashes in stdout.
  const saved = plan.map(row => ({ path: row.path, before: row.before?.toString('base64') ?? null }));
  await atomic(resolve(backup, 'before.json'), Buffer.from(json(saved)));
  const applied = [];
  try {
    for (const row of plan) { await beforeWrite(row, applied.length); applied.push(row); await atomic(row.path, row.after); }
    for (const row of plan) if (!(await privateRead(row.path)).equals(row.after)) fail('AUTH_MIGRATION_READBACK_FAILED');
  } catch (error) {
    for (const row of applied.reverse()) { if (row.before === null) await unlink(row.path).catch(e => { if (e.code !== 'ENOENT') throw e; }); else await atomic(row.path, row.before); }
    throw error;
  }
  return { changedFiles: plan.map(row => row.path), count: plan.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, host, backup] = process.argv.slice(2);
  if (!['--plan', '--apply'].includes(mode) || !host || mode === '--apply' && !backup) fail('AUTH_MIGRATION_USAGE');
  const plan = await planModelAuthMigration(resolve(host));
  const result = mode === '--apply' ? await applyModelAuthMigration(plan, resolve(backup)) : { changedFiles: plan.map(row => row.path), count: plan.length };
  console.log(JSON.stringify({ mode, ...result }));
}
