#!/usr/bin/env node
// Operator-side one-time pairing. Tokens never go to stdout, browser or API.
import { randomBytes, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrivateJson, writePrivateJson, ensurePrivateDirectory } from '../conf/cyf-agent-runtime-v1/lib/security.mjs';
import { acquireRuntimeOwnership, requireOwnedPrivateRoot } from '../conf/cyf-agent-runtime-v1/lib/runtime-host.mjs';
import { exactHostingId } from '../conf/cyf-agent-runtime-v1/lib/hosting-config.mjs';
import { stableJson } from '../conf/cyf-agent-runtime-v1/lib/manifest.mjs';
const fail = () => { throw new Error('HOSTING_SETUP_INPUT_INVALID'); };
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => `rth1_${randomBytes(32).toString('hex')}`;
const absolute = value => { if (typeof value !== 'string' || !isAbsolute(value)) fail(); return resolve(value); };
export async function prepareHostingSetup(hostId, output) {
  if (!exactHostingId(hostId)) fail();
  output = absolute(output); await requireOwnedPrivateRoot(dirname(output));
  await mkdir(output, { mode: 0o700 }); // Never reuse or overwrite an existing setup's credentials.
  const pending = { hostId, token: token(), controlToken: token() };
  await writePrivateJson(resolve(output, 'pending.json'), pending, { exclusive: true });
  const request = { hostId, tokenSha256: hash(pending.token), controlTokenSha256: hash(pending.controlToken) };
  await writePrivateJson(resolve(output, 'request.json'), request, { exclusive: true });
  return request;
}
export async function attachHostingSetup(pendingPath, authorizationPath, authorizationsPath) {
  const pending = await readPrivateJson(absolute(pendingPath), null);
  const authorization = await readPrivateJson(absolute(authorizationPath), null);
  const fields = ['authorizationId', 'hostId', 'purpose', 'tenantId', 'clientId', 'ownerJiacn', 'canonicalAgentId'];
  if (!pending || !/^rth1_[0-9a-f]{64}$/.test(pending.token) || !/^rth1_[0-9a-f]{64}$/.test(pending.controlToken)
      || pending.token === pending.controlToken || !authorization || authorization.purpose !== 'SETUP'
      || Object.keys(authorization).sort().join(',') !== [...fields].sort().join(',')
      || fields.some(field => !exactHostingId(authorization[field])) || authorization.hostId !== pending.hostId) fail();
  const path = absolute(authorizationsPath); await requireOwnedPrivateRoot(dirname(path));
  const lock = resolve(dirname(path), '.hosting-setup-writers', hash(path)); await ensurePrivateDirectory(lock);
  const release = await acquireRuntimeOwnership(lock, { hostId: pending.hostId, instanceId: `pairing-${process.pid}`, subjectKey: 'hosting-setup' });
  try {
    const value = await readPrivateJson(path, null) ?? { configVersion: 1, authorizations: [] };
    if (value.configVersion !== 1 || !Array.isArray(value.authorizations)) fail();
    const entry = { ...authorization, token: pending.token, controlToken: pending.controlToken };
    const prior = value.authorizations.find(item => item.authorizationId === authorization.authorizationId);
    if (prior) { if (stableJson(prior) !== stableJson(entry)) fail(); return; }
    value.authorizations.push(entry); await writePrivateJson(path, value);
  } finally { await release(); }
}
async function main(args) {
  const [command, ...values] = args; const options = {};
  if (values.length % 2) fail();
  const allowed = command === 'prepare' ? ['--host-id', '--output'] : command === 'attach' ? ['--pending', '--authorization', '--authorizations'] : [];
  for (let i = 0; i < values.length; i += 2) {
    if (!allowed.includes(values[i]) || Object.hasOwn(options, values[i])) fail();
    options[values[i]] = values[i + 1];
  }
  if (Object.keys(options).length !== allowed.length || !allowed.length) fail();
  if (command === 'prepare') await prepareHostingSetup(options['--host-id'], options['--output']);
  else await attachHostingSetup(options['--pending'], options['--authorization'], options['--authorizations']);
  process.stdout.write(command === 'prepare' ? 'Prepared private pending.json and public request.json.\n' : 'Attached; the running host will reload the authorization file.\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('HOSTING_SETUP_FAILED (credentials omitted)\n'); process.exitCode = 1; });
}
