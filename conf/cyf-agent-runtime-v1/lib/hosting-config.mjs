import { validateModelAuth } from '../../codex-bridge/model-auth.mjs';
// Operator-only local config. No control request can select these paths or keys.
import { createHash } from 'node:crypto';
import { constants, lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { readPrivateJson } from './security.mjs';
import { RETIRED_CHAT_SWITCHES } from '../../codex-bridge/managed-chat-scope-config.mjs';

export const hostingError = code => Object.assign(new Error(code), { code });
export const exactHostingId = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => object(value) && Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key));
export const MANAGED_PROFILE_FIELDS = Object.freeze(['codexBin', 'codexModel', 'codexSandbox', 'codexApproval', 'codexSessionMode',
  'chatEngine', 'chatModel', 'chatReasoningEffort', 'chatSandbox', 'chatToolPolicy',
  'appServerSchemaContractId', 'workspacePolicyId', 'workspaceRole',
  'workspaceNoTaskPolicy', 'workspaceNonCodingCommandTypes', 'executionReportCommandTypes', 'nativeConversationHttpPollEnabled',
  'nativeExecutionProviderId', 'nativeExecutionProviderBaseUrl', 'nativeExecutionProviderWireApi', 'nativeExecutionNetworkConnectTimeoutMs',
  'abilities', 'skills']);
export async function canonicalHostingPath(path) {
  if (!exactHostingId(path) || !isAbsolute(path) || resolve(path) !== path) throw hostingError('HOSTING_CONFIG_PATH_INVALID');
  let cursor = path;
  while (true) {
    try { if ((await lstat(cursor)).isSymbolicLink() || await realpath(cursor) !== cursor) throw hostingError('HOSTING_CONFIG_PATH_UNSAFE'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const parent = dirname(cursor); if (parent === cursor) return path; cursor = parent;
  }
}
export function validateHostingConfig(value) {
  const outbound = Object.hasOwn(value || {}, 'outbound');
  const configFields = ['configVersion', 'managedRoot', 'scopes', 'template', 'enrollmentTtlMs',
    ...(outbound ? ['outbound'] : ['socketPath', 'socketGid'])];
  if (Object.hasOwn(value || {}, 'remote')) configFields.push('remote');
  if (!fields(value, configFields)
      || value.configVersion !== 1 || !outbound && (!Number.isSafeInteger(value.socketGid) || value.socketGid < 0)
      || !Number.isSafeInteger(value.enrollmentTtlMs) || value.enrollmentTtlMs < 1
      || !Array.isArray(value.scopes) || !outbound && !value.scopes.length
      || value.template !== null && !fields(value.template, ['profile', 'codexConfig', 'modelAuth'])) throw hostingError('HOSTING_CONFIG_INVALID');
  if (outbound && (value.remote !== undefined || !fields(value.outbound, ['credentialsPath', 'pollIntervalMs'])
      || !exactHostingId(value.outbound.credentialsPath) || !isAbsolute(value.outbound.credentialsPath)
      || !Number.isSafeInteger(value.outbound.pollIntervalMs) || value.outbound.pollIntervalMs < 1))
    throw hostingError('HOSTING_OUTBOUND_CONFIG_INVALID');
  if (value.remote !== undefined) {
    const remote = value.remote;
    if (!fields(remote, ['listenHost', 'port', 'certificatePath', 'privateKeyPath', 'clientCaPath'])
        || !isIP(remote.listenHost) || !Number.isInteger(remote.port) || remote.port < 0 || remote.port > 65535
        || ['certificatePath', 'privateKeyPath', 'clientCaPath'].some(field => !exactHostingId(remote[field]) || !isAbsolute(remote[field])))
      throw hostingError('HOSTING_REMOTE_CONFIG_INVALID');
  }
  const seen = new Set();
  for (const scope of value.scopes) {
    if (!fields(scope, ['tenantId', 'clientId', 'ownerJiacn']) || !Object.values(scope).every(exactHostingId)) throw hostingError('HOSTING_CONFIG_SCOPE_INVALID');
    const key = JSON.stringify([scope.tenantId, scope.clientId, scope.ownerJiacn]);
    if (seen.has(key)) throw hostingError('HOSTING_CONFIG_SCOPE_DUPLICATE'); seen.add(key);
  }
  // Static-only hosts need no provisioning template or duplicate provider credentials.
  if (value.template === null) return value;
  const { profile, codexConfig, modelAuth } = value.template;
  try { validateModelAuth(modelAuth); } catch { throw hostingError('HOSTING_TEMPLATE_INVALID'); }
  if (!object(profile) || Object.keys(profile).some(key => !MANAGED_PROFILE_FIELDS.includes(key) && !RETIRED_CHAT_SWITCHES.includes(key))
      || !exactHostingId(profile.codexBin) || !isAbsolute(profile.codexBin)
      || typeof codexConfig !== 'string' || !codexConfig.trim() || codexConfig.includes('\0')) throw hostingError('HOSTING_TEMPLATE_INVALID');
  // Deliberately small TOML subset, not a second general-purpose TOML parser.
  // Exactly one provider table and scalar allowlists exclude includes, alternate
  // credential stores, headers, duplicate settings and multiline auth fallback.
  const top = {}; const provider = {}; let selectedTable = null;
  const topKeys = new Set(['model', 'model_provider', 'model_reasoning_effort', 'disable_response_storage', 'cli_auth_credentials_store']);
  const providerKeys = new Set(['name', 'base_url', 'wire_api', 'requires_openai_auth']);
  for (const raw of codexConfig.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const table = /^\[model_providers\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (table) {
      if (selectedTable !== null) throw hostingError('HOSTING_TEMPLATE_PROVIDER_REQUIRED');
      selectedTable = table[1]; continue;
    }
    const match = /^([a-z_]+)\s*=\s*("(?:[^"\\\r\n]|\\["\\bfnrt]|\\u[0-9a-fA-F]{4})*"|true|false)$/.exec(line);
    const target = selectedTable === null ? top : provider;
    if (!match || !(selectedTable === null ? topKeys : providerKeys).has(match[1]) || Object.hasOwn(target, match[1])) throw hostingError('HOSTING_TEMPLATE_PROVIDER_REQUIRED');
    let scalar;
    try { scalar = JSON.parse(match[2]); } catch { throw hostingError('HOSTING_TEMPLATE_PROVIDER_REQUIRED'); }
    if (typeof scalar === 'string' && !exactHostingId(scalar)) throw hostingError('HOSTING_TEMPLATE_PROVIDER_REQUIRED');
    target[match[1]] = scalar;
  }
  let providerUrl; try { providerUrl = new URL(provider.base_url); } catch {}
  if (!exactHostingId(top.model_provider) || selectedTable !== top.model_provider || selectedTable === 'openai'
      || top.cli_auth_credentials_store !== 'file'
      || providerUrl?.protocol !== 'https:' || providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash
      || provider.requires_openai_auth !== true || provider.wire_api !== 'responses'
      || Object.entries(top).some(([key, scalar]) => key === 'disable_response_storage' ? typeof scalar !== 'boolean' : typeof scalar !== 'string')
      || Object.entries(provider).some(([key, scalar]) => key === 'requires_openai_auth' ? typeof scalar !== 'boolean' : typeof scalar !== 'string')) throw hostingError('HOSTING_TEMPLATE_PROVIDER_REQUIRED');
  if ([profile.nativeExecutionProviderId, profile.nativeExecutionProviderBaseUrl, profile.nativeExecutionProviderWireApi].some(value => value !== undefined)
      && (profile.nativeExecutionProviderId !== selectedTable
      || profile.nativeExecutionProviderBaseUrl !== provider.base_url || profile.nativeExecutionProviderWireApi !== provider.wire_api))
    throw hostingError('HOSTING_TEMPLATE_DELIBERATION_CONFIG_REQUIRED');
  return value;
}
// New managed enrollment only. Existing relationship recovery must not be
// reinterpreted as a new purchase or silently rewritten to a new template.
export function requireHostingDeliberationTemplate(template) {
  const p = template?.profile;
  if (!p || p.chatEngine !== 'app-server') return;
  if (![p.nativeExecutionProviderId, p.nativeExecutionProviderBaseUrl, p.nativeExecutionProviderWireApi].every(exactHostingId)
      || !Number.isSafeInteger(p.nativeExecutionNetworkConnectTimeoutMs) || p.nativeExecutionNetworkConnectTimeoutMs <= 0)
    throw hostingError('HOSTING_TEMPLATE_DELIBERATION_CONFIG_REQUIRED');
}

export async function readHostingConfig(path, hostConfig) {
  await canonicalHostingPath(path);
  const value = validateHostingConfig(await readPrivateJson(path, null));
  if (!value.outbound) await canonicalHostingPath(value.socketPath);
  await canonicalHostingPath(value.managedRoot);
  const overlap = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const roots = [hostConfig.stateRoot, ...hostConfig.agents.flatMap(agent => [agent.stateRoot,
    ...['codexHome', 'codexWorkdir', 'chatWorkdir', 'workspaceFallbackWorkdir', 'workspaceFileRootDir', 'typedInspectionRootDir',
      'typedInspectionStateRoot', 'controlledImageHttpLedgerRoot'].map(key => agent.profile[key]).filter(Boolean)])];
  if (roots.some(root => overlap(root, value.managedRoot)) || !value.outbound && overlap(dirname(value.socketPath), value.managedRoot)) throw hostingError('HOSTING_CONFIG_ROOTS_OVERLAP');
  const managed = await lstat(value.managedRoot);
  if (!managed.isDirectory() || managed.uid !== process.getuid() || managed.mode & 0o077) throw hostingError('HOSTING_CONFIG_ROOT_UNSAFE');
  if (value.outbound) {
    await canonicalHostingPath(value.outbound.credentialsPath);
    if ([...roots, value.managedRoot].some(root => overlap(root, value.outbound.credentialsPath)))
      throw hostingError('HOSTING_OUTBOUND_CREDENTIAL_ROOT_UNSAFE');
    // Content/subject admission occurs in the transport supervisor, not in each caller.
    await readPrivateJson(value.outbound.credentialsPath, null);
  } else {
    const parent = await lstat(dirname(value.socketPath));
    if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.gid !== value.socketGid
        || ![0o710, 0o750].includes(parent.mode & 0o777)) throw hostingError('HOSTING_SOCKET_PARENT_UNSAFE');
  }
  if (value.remote) {
    for (const field of ['certificatePath', 'privateKeyPath', 'clientCaPath']) {
      const path = value.remote[field];
      await canonicalHostingPath(path);
      if ([...roots, value.managedRoot].some(root => overlap(root, path))) throw hostingError('HOSTING_REMOTE_CREDENTIAL_ROOT_UNSAFE');
    }
    await readHostingTlsOptions(value.remote);
  }
  if (value.template === null) return value;
  // Require an explicit, present binary; do not execute it here or create roots.
  await canonicalHostingPath(value.template.profile.codexBin);
  const binary = await open(value.template.profile.codexBin, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await binary.stat();
    if (!stat.isFile() || !(stat.mode & 0o111) || stat.mode & 0o022 || ![0, process.getuid()].includes(stat.uid)) throw hostingError('HOSTING_TEMPLATE_BINARY_UNSAFE');
  } finally { await binary.close(); }
  const { normalizeProfile, profileConfigurationErrors } = await import('../../codex-bridge/agent-client.mjs');
  try {
    const profile = normalizeProfile({ ...value.template.profile, profileId: 'managed-template-validation', agentId: 'managed-template-validation',
      codexHome: resolve(value.managedRoot, '.template-home'), codexWorkdir: resolve(value.managedRoot, '.template-work') }, {}, 0, { isolated: true });
    if (profileConfigurationErrors(profile).length) throw hostingError('HOSTING_TEMPLATE_PROFILE_INVALID');
  } catch { throw hostingError('HOSTING_TEMPLATE_PROFILE_INVALID'); }
  return value;
}

// TLS material is operator-owned host state, outside every Agent's mutable roots.
// No request supplies certificates, routes or transport settings.
export async function readHostingTlsOptions(remote) {
  const read = async (path, privateKey) => {
    await canonicalHostingPath(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || ![0, process.getuid()].includes(stat.uid)
          || (stat.mode & (privateKey ? 0o077 : 0o022)) !== 0) throw hostingError('HOSTING_REMOTE_CREDENTIAL_UNSAFE');
      return await file.readFile();
    } finally { await file.close(); }
  };
  return { cert: await read(remote.certificatePath, false), key: await read(remote.privateKeyPath, true),
    ca: await read(remote.clientCaPath, false), requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' };
}

// Confirmed locally before any network request. The shared credential never
// becomes part of an Agent identity, profile or lifecycle journal.
export function validateHostingCredential(value, hostId) {
  const host = value?.host;
  if (!fields(value, ['configVersion', 'host', 'token']) || value.configVersion !== 1
      || !/^rth1_[0-9a-f]{64}$/.test(value.token)
      || !fields(host, ['hostId', 'mode', 'tenantId', 'clientId', 'ownerJiacn', 'tokenSha256'])
      || !['hostId', 'tenantId', 'clientId'].every(key => exactHostingId(host[key]))
      || host.hostId !== hostId || !['server', 'local'].includes(host.mode)
      || (host.mode === 'server' ? host.ownerJiacn !== null : !exactHostingId(host.ownerJiacn))
      || host.tokenSha256 !== createHash('sha256').update(value.token).digest('hex'))
    throw hostingError('HOSTING_OUTBOUND_CREDENTIAL_INVALID');
  return Object.freeze({ configVersion: 1, host: Object.freeze({ ...host }), token: value.token });
}
export async function readHostingCredential(config, hostId) {
  await canonicalHostingPath(config.credentialsPath);
  return validateHostingCredential(await readPrivateJson(config.credentialsPath, null), hostId);
}
