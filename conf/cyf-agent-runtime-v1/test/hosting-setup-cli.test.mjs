import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareHostingSetup, attachHostingSetup } from '../../../shell/cyf_runtime_hosting_setup.mjs';
import { writePrivateJson, readPrivateJson } from '../lib/security.mjs';

test('pairing keeps two independent secrets on the host and attachment is idempotent', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'hosting-pair-')); t.after(() => rm(root, { recursive: true, force: true }));
  const output = resolve(root, 'new'); const request = await prepareHostingSetup('fixture-host', output);
  const pending = await readPrivateJson(resolve(output, 'pending.json'));
  assert.notEqual(pending.token, pending.controlToken);
  assert.equal(request.tokenSha256, createHash('sha256').update(pending.token).digest('hex'));
  assert.equal((await readFile(resolve(output, 'request.json'), 'utf8')).includes('rth1_'), false);
  const authorization = { authorizationId: 'hca_pair', hostId: 'fixture-host', purpose: 'SETUP', tenantId: '0', clientId: 'fixture-client', ownerJiacn: 'fixture-owner', canonicalAgentId: 'agt_pair' };
  const publicPath = resolve(root, 'authorization.json'); await writePrivateJson(publicPath, authorization);
  const grants = resolve(root, 'authorizations.json');
  await attachHostingSetup(resolve(output, 'pending.json'), publicPath, grants);
  await attachHostingSetup(resolve(output, 'pending.json'), publicPath, grants);
  assert.equal((await readPrivateJson(grants)).authorizations.length, 1);
  assert.equal((await readPrivateJson(grants)).authorizations[0].controlToken, pending.controlToken);
  await assert.rejects(prepareHostingSetup('fixture-host', output), { code: 'EEXIST' });
  await writePrivateJson(publicPath, { ...authorization, hostId: 'wrong-host' });
  await assert.rejects(attachHostingSetup(resolve(output, 'pending.json'), publicPath, grants));
  assert.equal((await readPrivateJson(grants)).authorizations.length, 1);
});
