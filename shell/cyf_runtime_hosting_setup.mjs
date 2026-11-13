#!/usr/bin/env node
// Operator-side one-time pairing. Tokens never go to stdout, browser or API.
import { randomBytes, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrivateJson, writePrivateJson, ensurePrivateDirectory } from '../conf/cyf-agent-runtime-v1/lib/security.mjs';
import { acquireRuntimeOwnership, requireOwnedPrivateRoot } from '../conf/cyf-agent-runtime-v1/lib/runtime-host.mjs';
import { exactHostingId, validateHostingCredential } from '../conf/cyf-agent-runtime-v1/lib/hosting-config.mjs';
import { stableJson } from '../conf/cyf-agent-runtime-v1/lib/manifest.mjs';
const fail = () => { throw new Error('HOSTING_SETUP_INPUT_INVALID'); };
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => `rth1_${randomBytes(32).toString('hex')}`;
const absolute = value => { if (typeof value !== 'string' || !isAbsolute(value)) fail(); return resolve(value); };
export async function prepareHostingSetup(hostId, output) {
  if (!exactHostingId(hostId)) fail();
  output = absolute(output); await requireOwnedPrivateRoot(dirname(output));
  await mkdir(output, { mode: 0o700 }); // Never reuse or overwrite an existing setup's credentials.
  const pending = { hostId, token: token() };
  await writePrivateJson(resolve(output, 'pending.json'), pending, { exclusive: true });
  const request = { hostId, tokenSha256: hash(pending.token) };
  await writePrivateJson(resolve(output, 'request.json'), request, { exclusive: true });
  return request;
}
export async function attachHostingSetup(pendingPath, hostPath, credentialsPath) {
  const pending = await readPrivateJson(absolute(pendingPath), null);
  const host = await readPrivateJson(absolute(hostPath), null);
  const entry = validateHostingCredential({ configVersion: 1, host, token: pending?.token }, pending?.hostId);
  const path = absolute(credentialsPath); await requireOwnedPrivateRoot(dirname(path));
  const lock = resolve(dirname(path), '.hosting-setup-writers', hash(path)); await ensurePrivateDirectory(lock);
  const release = await acquireRuntimeOwnership(lock, { hostId: host.hostId, instanceId: `pairing-${process.pid}`, subjectKey: 'hosting-host' });
  try {
    const prior = await readPrivateJson(path, null);
    if (prior !== null) { if (stableJson(prior) !== stableJson(entry)) fail(); return; }
    await writePrivateJson(path, entry, { exclusive: true });
  } finally { await release(); }
}
async function main(args) {
  const [command, ...values] = args; const options = {};
  if (values.length % 2) fail();
  const allowed = command === 'prepare' ? ['--host-id', '--output'] : command === 'attach' ? ['--pending', '--host', '--credentials'] : [];
  for (let i = 0; i < values.length; i += 2) {
    if (!allowed.includes(values[i]) || Object.hasOwn(options, values[i])) fail();
    options[values[i]] = values[i + 1];
  }
  if (Object.keys(options).length !== allowed.length || !allowed.length) fail();
  if (command === 'prepare') await prepareHostingSetup(options['--host-id'], options['--output']);
  else await attachHostingSetup(options['--pending'], options['--host'], options['--credentials']);
  process.stdout.write(command === 'prepare' ? 'Prepared private pending.json and public request.json.\n' : 'Confirmed host credential; configure outbound.credentialsPath before starting management.\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('HOSTING_SETUP_FAILED (credentials omitted)\n'); process.exitCode = 1; });
}
