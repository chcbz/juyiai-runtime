import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { HostingOutboundHost } from '../lib/hosting-outbound-host.mjs';
import { HostingOutbound } from '../lib/hosting-outbound.mjs';
import { createHostingControlServer } from '../lib/hosting-server.mjs';
import { validateHostingConfig, readHostingConfig } from '../lib/hosting-config.mjs';
import { readRuntimeHostConfig } from '../lib/manifest.mjs';
import { runUnifiedRuntime } from '../agent-runtime.mjs';
import { hostingFixture, tick, code } from './hosting-fixture.mjs';

const grant = { authorizationId: 'hca_host_test', hostId: 'fixture-host', tenantId: '0',
  clientId: 'fixture-client', ownerJiacn: 'fixture-owner', canonicalAgentId: 'agt_target' };
const peer = { ...grant, authorizationId: 'hca_peer', canonicalAgentId: 'agt_peer_target' };
const token = `rth1_${'a'.repeat(64)}`;
const credential = { configVersion: 1, token, host: { hostId: grant.hostId, mode: 'local', tenantId: grant.tenantId,
  clientId: grant.clientId, ownerJiacn: grant.ownerJiacn, tokenSha256: createHash('sha256').update(token).digest('hex') } };
async function fixture(t, fetchFn) {
  const closers = []; t.after(async () => { for (const close of closers.reverse()) await close(); });
  const f = await hostingFixture(t, { staticPeers: true });
  const credentialsPath = resolve(f.root, 'credentials.json');
  await writeFile(credentialsPath, JSON.stringify(credential), { mode: 0o600 });
  let authorizations = [];
  const write = async items => { authorizations = [...items].sort((a, b) => a.authorizationId < b.authorizationId ? -1 : a.authorizationId > b.authorizationId ? 1 : 0); };
  const { socketPath, socketGid, ...base } = f.controlConfig;
  const config = { ...base, outbound: { credentialsPath, pollIntervalMs: 1 } };
  f.control().config = validateHostingConfig(config); f.control().hostCredential = credential;
  const directoryFetch = async (url, request) => new Response(JSON.stringify({ protocolVersion: 1,
    requestId: request.headers['X-Request-Id'], code: 'E0', msg: 'ok',
    data: { host: credential.host, items: authorizations, nextCursor: null, hasMore: false } }), { status: 200 });
  const events = []; const calls = [];
  const manager = new HostingOutboundHost({ control: f.control(), apiOrigin: 'https://api.example.invalid', fetchFn: directoryFetch, logger: (...args) => events.push(args),
    createWorker: options => new HostingOutbound({ ...options, fetchFn: async (url, request) => {
      const body = JSON.parse(request.body); calls.push(body);
      if (fetchFn) return fetchFn(body, request);
      return new Response(JSON.stringify({ protocolVersion: 1, requestId: body.requestId, code: 'E0', msg: 'ok',
        data: { authorizationId: body.data.authorizationId, hostId: grant.hostId, acknowledgedMessageId: null, command: null } }),
      { status: 200, headers: { 'x-request-id': body.requestId } });
    } }) });
  closers.push(() => manager.close());
  return { ...f, config, manager, write, calls, events, closers, socketPath };
}
async function until(check) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await tick(); }
  assert.fail('condition not observed');
}

test('outbound config has no socket/TLS dependencies; initial empty host is valid only with outbound control', async t => {
  const f = await fixture(t);
  const configPath = resolve(f.root, 'control.json');
  await writeFile(configPath, JSON.stringify(f.config), { mode: 0o600 });
  assert.deepEqual(await readHostingConfig(configPath, f.hostConfig), f.config);
  for (const change of [{ socketPath: f.socketPath }, { socketGid: 0 }, { remote: {} }])
    assert.throws(() => validateHostingConfig({ ...f.config, ...change }));
  const hostPath = resolve(f.root, 'host.json');
  const value = { configVersion: 1, hostId: grant.hostId, stateRoot: f.hostConfig.stateRoot, agents: [], hostingControlPath: configPath };
  await writeFile(hostPath, JSON.stringify(value), { mode: 0o600 });
  assert.equal((await readRuntimeHostConfig(hostPath)).agents.length, 0);
  delete value.hostingControlPath; await writeFile(hostPath, JSON.stringify(value), { mode: 0o600 });
  await assert.rejects(readRuntimeHostConfig(hostPath), code('RUNTIME_HOST_CONFIG_INVALID'));
});

test('hot add/remove grants share one host; removed transport stops and durable private state remains', async t => {
  const f = await fixture(t); await f.manager.refresh(); assert.equal(f.calls.length, 0);
  await f.write([grant]); await f.manager.refresh(); await until(() => f.calls.length > 0);
  const first = f.manager.workers.get(grant.authorizationId); const host = f.host();
  await f.write([grant, peer]); await f.manager.refresh();
  await until(() => f.calls.some(call => call.data.authorizationId === peer.authorizationId));
  assert.equal(f.manager.workers.get(grant.authorizationId), first); assert.equal(f.host(), host);
  await f.write([peer]); await f.manager.refresh();
  assert.equal(first.worker.release, null); assert.equal(first.aborter.signal.aborted, true);
  assert.equal(f.manager.workers.size, 1); assert.equal(f.host().agents.size, 3); assert.equal(f.enrollmentCount(), 0);
  assert.equal((await stat(first.worker.path)).mode & 0o777, 0o600);
  assert.equal((await readFile(first.worker.path, 'utf8')).includes(token), false);
  await assert.rejects(stat(f.socketPath), { code: 'ENOENT' });
});

test('invalid or changed directory cannot replace identity or stop healthy grants', async t => {
  const f = await fixture(t); await f.write([grant]); await f.manager.refresh();
  const first = f.manager.workers.get(grant.authorizationId);
  await f.write([{ ...grant, canonicalAgentId: 'changed' }]);
  await assert.rejects(f.manager.refresh(), code('HOSTING_OUTBOUND_AUTHORIZATION_CONFLICT'));
  await f.write([grant, grant]); await assert.rejects(f.manager.refresh(), code('HOSTING_OUTBOUND_DIRECTORY_INVALID'));
  await f.write([{ ...peer, ownerJiacn: 'other-owner' }]); await assert.rejects(f.manager.refresh(), code('HOSTING_OUTBOUND_AUTHORIZATION_INVALID'));
  assert.equal(f.manager.workers.get(grant.authorizationId), first); assert.equal(first.aborter.signal.aborted, false);
});

test('permanent denial quarantines only its grant and periodic refresh never restarts it', async t => {
  let observeNext = false, continued;
  const nextPeerRequest = new Promise(done => { continued = done; });
  const f = await fixture(t, async body => {
    const denied = body.data.authorizationId === grant.authorizationId;
    if (!denied && observeNext) continued();
    return new Response(JSON.stringify({ protocolVersion: 1, requestId: body.requestId,
      code: denied ? 'E403' : 'E0', msg: denied ? 'denied' : 'ok',
      data: denied ? null : { authorizationId: peer.authorizationId, hostId: peer.hostId, acknowledgedMessageId: null, command: null } }),
    { status: denied ? 403 : 200, headers: { 'x-request-id': body.requestId } });
  });
  await f.write([grant, peer]); await f.manager.refresh();
  await until(() => f.events.length === 1);
  const calls = id => f.calls.filter(call => call.data.authorizationId === id).length;
  observeNext = true;
  await f.manager.refresh();
  await Promise.race([nextPeerRequest, f.manager.workers.get(peer.authorizationId).task.then(() => {
    assert.fail('healthy peer transport unexpectedly stopped');
  })]);
  assert.equal(calls(grant.authorizationId), 1);
  assert.equal(f.host().agents.size, 3); assert.equal(f.host().stopping, false);
  assert.equal(JSON.stringify(f.events).includes(token), false);
});

test('shutdown aborts and joins in-flight fetch before releasing each writer, and is idempotent', async t => {
  const f = await fixture(t, (_, request) => new Promise((_, reject) => {
    const abort = () => reject(request.signal.reason); request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  }));
  await f.write([grant, peer]); await f.manager.refresh(); await until(() => f.calls.length === 2);
  const entries = [...f.manager.workers.values()];
  await Promise.all([f.manager.close(), f.manager.close()]);
  for (const entry of entries) { assert.equal(entry.worker.active, false); assert.equal(entry.worker.release, null); }
  assert.equal(f.control().closing, true);
});

test('production control factory chooses outbound without creating a listener', async t => {
  const f = await fixture(t); await f.manager.close(); await f.control().releaseOwnership();
  const control = await createHostingControlServer({ host: f.host(), config: f.config, apiOrigin: 'https://api.example.invalid' });
  f.closers.push(async () => { await control.close(); await control.control.releaseOwnership(); });
  assert.ok(control instanceof HostingOutboundHost);
  await assert.rejects(stat(f.socketPath), { code: 'ENOENT' });
});

test('unified runtime reloads outbound grants on heartbeat and closes the control lifecycle', async t => {
  const f = await fixture(t); await f.manager.close(); await f.stop();
  const controller = new AbortController(); let refreshed = 0, closed = 0;
  await runUnifiedRuntime({ config: { ...f.hostConfig, agents: [], hostingControl: f.config }, apiOrigin: 'https://api.example.invalid',
    signal: controller.signal, createAdapters: async () => ({ createExecutor() { throw Error('unexpected execution'); },
      heartbeat: async () => controller.abort(), close: async () => {} }),
    createControl: async options => {
      const actual = await createHostingControlServer(options);
      const refresh = actual.refresh.bind(actual), close = actual.close.bind(actual);
      actual.refresh = async () => { refreshed++; return refresh(); };
      actual.close = async () => { closed++; return close(); }; return actual;
    } });
  assert.equal(refreshed, 1); assert.ok(closed >= 1);
});

test('pending transport reload never delays other Agent heartbeats or host stop', async t => {
  const f = await fixture(t); await f.manager.close(); await f.stop();
  const controller = new AbortController(); let refreshed = false, heartbeat = false, release;
  const pending = new Promise(done => { release = done; });
  await runUnifiedRuntime({ config: { ...f.hostConfig, agents: [], hostingControl: f.config }, apiOrigin: 'https://api.example.invalid',
    signal: controller.signal, createAdapters: async () => ({ createExecutor() { throw Error('unexpected execution'); },
      heartbeat: async () => { heartbeat = true; controller.abort(); }, close: async () => {} }),
    createControl: async () => ({ control: { releaseOwnership: async () => {} }, refresh: () => { refreshed = true; return pending; }, close: async () => release() }) });
  assert.equal(heartbeat, true); assert.equal(refreshed, true);
});

test('runtime credential redaction includes outbound bearer and standalone token', async () => {
  const { redact } = await import('../lib/security.mjs');
  const result = redact(`RuntimeHosting ${token} another ${token}`);
  assert.equal(result.includes(token), false); assert.equal(result.includes(token), false);
});

test('incomplete directory never removes healthy workers; complete scan removes only absent grants', async t => {
  const f = await fixture(t); await f.write([grant, peer]); await f.manager.refresh();
  const original = f.manager.workers.get(grant.authorizationId);
  let pages = 0;
  f.manager.fetchFn = async (_, request) => {
    if (++pages === 2) throw Object.assign(Error('unavailable'), { code: 'ECONNRESET' });
    return new Response(JSON.stringify({ protocolVersion: 1, requestId: request.headers['X-Request-Id'], code: 'E0', msg: 'ok',
      data: { host: credential.host, items: [peer], nextCursor: peer.authorizationId, hasMore: true } }), { status: 200 });
  };
  await assert.rejects(f.manager.refresh(), { code: 'ECONNRESET' });
  assert.equal(original.aborter.signal.aborted, false); assert.equal(f.manager.workers.size, 2);
  f.manager.fetchFn = async (_, request) => new Response(JSON.stringify({ protocolVersion: 1, requestId: request.headers['X-Request-Id'], code: 'E0', msg: 'ok',
    data: { host: credential.host, items: [peer], nextCursor: null, hasMore: false } }), { status: 200 });
  await f.manager.refresh(); assert.equal(original.aborter.signal.aborted, true); assert.equal(f.manager.workers.size, 1);
});

test('host 401 pauses all management but not business, and directory refresh does not restart it', async t => {
  const f = await fixture(t); await f.write([grant, peer]); await f.manager.refresh();
  f.manager.fetchFn = async (_, request) => new Response(JSON.stringify({ protocolVersion: 1,
    requestId: request.headers['X-Request-Id'], code: 'HOSTING_OUTBOUND_REJECTED', msg: 'rejected', data: null }), { status: 401 });
  await assert.rejects(f.manager.refresh(), error => error.status === 401);
  assert.equal(f.manager.paused, true);
  for (const entry of f.manager.workers.values()) assert.equal(entry.aborter.signal.aborted, true);
  assert.equal(f.control().closing, false); assert.equal(f.host().stopping, false);
  const entries = [...f.manager.workers.values()]; await f.manager.refresh();
  assert.deepEqual([...f.manager.workers.values()], entries);
});

test('removed and rediscovered failed grant stays quarantined until explicit operator recovery', async t => {
  const f = await fixture(t, body => new Response(JSON.stringify({ protocolVersion: 1, requestId: body.requestId,
    code: 'FORBIDDEN', msg: 'rejected', data: null }), { status: 403 }));
  await f.write([grant]); await f.manager.refresh(); await until(() => f.manager.quarantined.has(grant.authorizationId));
  await f.write([]); await f.manager.refresh(); await f.write([grant]); await f.manager.refresh();
  assert.equal(f.calls.length, 1); assert.equal(f.manager.workers.size, 0);
});
