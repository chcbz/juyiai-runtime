import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareHostingSetup, attachHostingSetup } from '../../../shell/cyf_runtime_hosting_setup.mjs';
import { writePrivateJson, readPrivateJson } from '../lib/security.mjs';

test('one-time host pairing keeps one secret local and verifies public metadata', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'hosting-pair-')); t.after(() => rm(root, { recursive: true, force: true }));
  const output = resolve(root, 'new'); const request = await prepareHostingSetup('fixture-host', output);
  const pending = await readPrivateJson(resolve(output, 'pending.json'));
  assert.deepEqual(Object.keys(pending).sort(), ['hostId', 'token']);
  assert.equal(request.tokenSha256, createHash('sha256').update(pending.token).digest('hex'));
  assert.equal((await readFile(resolve(output, 'request.json'), 'utf8')).includes('rth1_'), false);
  const authorization = { hostId: 'fixture-host', mode: 'local', tenantId: '0', clientId: 'fixture-client', ownerJiacn: 'fixture-owner', tokenSha256: request.tokenSha256 };
  const publicPath = resolve(root, 'authorization.json'); await writePrivateJson(publicPath, authorization);
  const grants = resolve(root, 'authorizations.json');
  await attachHostingSetup(resolve(output, 'pending.json'), publicPath, grants);
  await attachHostingSetup(resolve(output, 'pending.json'), publicPath, grants);
  assert.deepEqual((await readPrivateJson(grants)).host, authorization);
  assert.equal((await readPrivateJson(grants)).token, pending.token);
  await assert.rejects(prepareHostingSetup('fixture-host', output), { code: 'EEXIST' });
  await writePrivateJson(publicPath, { ...authorization, hostId: 'wrong-host' });
  await assert.rejects(attachHostingSetup(resolve(output, 'pending.json'), publicPath, grants));
  assert.deepEqual((await readPrivateJson(grants)).host, authorization);
});
