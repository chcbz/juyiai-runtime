import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { HostingOutbound, HOSTING_EXCHANGE_PATH } from '../lib/hosting-outbound.mjs';
import { eventMessage } from '../lib/message-envelope.mjs';
import { hostingFixture, quotedPreparation, fixtureInventory, unchangedPeers } from './hosting-fixture.mjs';
import { readPrivateJson } from '../lib/security.mjs';

const activationWire = JSON.parse(await readFile(new URL('./fixtures/hosting-activation-v1.json', import.meta.url)));
const sharedWire = JSON.parse(await readFile(new URL('./fixtures/hosting-outbound-v1.json', import.meta.url)));
const scope = { tenantId: '0', clientId: 'fixture-client', ownerJiacn: 'fixture-owner', canonicalAgentId: 'agt_outbound_new' };
const grant = { ...sharedWire.authorization, token: `rth1_${'a'.repeat(64)}` };
const inventory = (id = 'inventory-1', overrides = {}) => eventMessage('request-fixture', 'hosting.inventory', id, { ...scope, ...overrides });
const response = (requestId, data, status = 200, code = 'E0') => new Response(JSON.stringify({ protocolVersion: 1,
  requestId, code, msg: code === 'E0' ? 'ok' : 'rejected', data }), { status, headers: { 'x-request-id': requestId } });
const reply = (command = null, acknowledgedMessageId = null) => ({ authorizationId: grant.authorizationId,
  hostId: grant.hostId, acknowledgedMessageId, command });
const hasCode = code => error => error?.code === code;
async function fixture(t, handler, authorization = grant) {
  const closers = []; t.after(async () => { for (const close of closers.reverse()) await close(); });
  const f = await hostingFixture(t, { observeInventory: fixtureInventory });
  const stateRoot = resolve(f.root, 'outbound'); await mkdir(stateRoot, { mode: 0o700 });
  const calls = []; const diagnostics = [];
  const options = { control: f.control(), authorization, stateRoot, apiOrigin: 'https://api.example.invalid',
    logger: (...args) => diagnostics.push(args), fetchFn: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, options, body });
      return handler(body, calls.length, options);
    } };
  const worker = await new HostingOutbound(options).initialize();
  closers.push(() => worker.close());
  return { f, options, calls, diagnostics, worker, stateRoot, closers };
}

test('real HTTP outbound exchange uses existing Q/R/M and actual lifecycle; no Runtime listener or enrollment', async t => {
  const closers = []; t.after(async () => { for (const close of closers.reverse()) await close(); });
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const body = JSON.parse(text); requests.push({ body, headers: req.headers, path: req.url });
    const data = requests.length === 1 ? reply(inventory()) : reply(null, body.data.result.messageId);
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': body.requestId });
    res.end(JSON.stringify({ protocolVersion: 1, requestId: body.requestId, code: 'E0', msg: 'ok', data }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
  const f = await hostingFixture(t, { observeInventory: fixtureInventory });
  const before = f.peers.map(peer => structuredClone(f.states.get(peer.subjectKey)[0]));
  const stateRoot = resolve(f.root, 'outbound'); await mkdir(stateRoot, { mode: 0o700 });
  const worker = await new HostingOutbound({ control: f.control(), authorization: grant, stateRoot,
    apiOrigin: `http://127.0.0.1:${server.address().port}` }).initialize();
  closers.push(() => worker.close());
  await worker.exchange(); await worker.exchange();
  assert.equal(requests[0].path, HOSTING_EXCHANGE_PATH);
  assert.equal(requests[0].headers.authorization, `RuntimeHosting ${grant.token}`);
  assert.deepEqual({ ...requests[0].body, requestId: sharedWire.request.requestId }, sharedWire.request);
  assert.deepEqual(inventory(), sharedWire.response.data.command);
  assert.equal(requests[1].body.data.result.messageType, 'hosting.inventory.result');
  assert.equal(requests[1].body.data.result.correlationId, 'inventory-1');
  assert.equal(requests[1].body.data.result.data.canonicalAgentId, scope.canonicalAgentId);
  assert.equal(worker.state.result, null);
  assert.equal(f.enrollmentCount(), 0); assert.equal(f.host().agents.size, 3);
  unchangedPeers(f, before);
  await assert.rejects(stat(f.controlConfig.socketPath), { code: 'ENOENT' });
  const bytes = await readFile(worker.path, 'utf8'); assert.equal(bytes.includes(grant.token), false);
  assert.equal((await stat(worker.path)).mode & 0o777, 0o600);
});

test('lost HTTP response preserves exact result across restart and resubmits before next command', async t => {
  const ctx = await fixture(t, (body, count) => {
    if (count === 1) return response(body.requestId, reply(inventory()));
    if (count === 2) throw Object.assign(Error('private transport detail'), { code: 'ECONNRESET' });
    return response(body.requestId, reply(null, body.data.result.messageId));
  });
  await ctx.worker.exchange(); const pending = structuredClone(ctx.worker.state.result);
  await assert.rejects(ctx.worker.exchange(), hasCode('ECONNRESET'));
  await ctx.worker.close();
  const restarted = await new HostingOutbound(ctx.options).initialize(); ctx.closers.push(() => restarted.close());
  await restarted.exchange();
  assert.deepEqual(ctx.calls[1].body.data.result, pending); assert.deepEqual(ctx.calls[2].body.data.result, pending);
  assert.equal(restarted.state.result, null);
});

test('missing acknowledgment and duplicate command do not rerun or discard pending result', async t => {
  const ctx = await fixture(t, (body, count) => response(body.requestId,
    count === 1 ? reply(inventory()) : count === 2 ? reply() : reply(inventory(), body.data.result.messageId)));
  let handled = 0; const handle = ctx.f.control().handle.bind(ctx.f.control());
  ctx.f.control().handle = input => { handled++; return handle(input); };
  await ctx.worker.exchange(); const pending = structuredClone(ctx.worker.state.result);
  await ctx.worker.exchange(); await ctx.worker.exchange();
  assert.equal(handled, 1); assert.deepEqual(ctx.worker.state.result, pending);
});

test('wrong acknowledgment cannot clear durable receipt', async t => {
  const ctx = await fixture(t, (body, count) => response(body.requestId,
    count === 1 ? reply(inventory()) : reply(null, 'wrong-result')));
  await ctx.worker.exchange(); const pending = structuredClone(ctx.worker.state.result);
  await assert.rejects(ctx.worker.exchange(), hasCode('HOSTING_OUTBOUND_ACK_INVALID'));
  assert.deepEqual((await readPrivateJson(ctx.worker.path)).result, pending);
});

test('unacknowledged result fences next command; reused messageId cannot change bytes', async t => {
  let next = inventory('next');
  const ctx = await fixture(t, (body, count) => response(body.requestId, count === 1 ? reply(inventory()) : reply(next)));
  await ctx.worker.exchange();
  await assert.rejects(ctx.worker.exchange(), hasCode('HOSTING_OUTBOUND_RESULT_PENDING'));
  next = { ...inventory(), requestId: 'changed' };
  await assert.rejects(ctx.worker.exchange(), hasCode('HOSTING_OUTBOUND_COMMAND_CONFLICT'));
});

test('exact subject/owner/tenant and host authorization are fenced before handler', async t => {
  let command = inventory(); let hostId = grant.hostId;
  const ctx = await fixture(t, body => response(body.requestId, { ...reply(command), hostId }));
  let handled = 0; ctx.f.control().handle = () => { handled++; throw Error('must not run'); };
  for (const field of Object.keys(scope)) {
    command = inventory('id', { [field]: 'another' });
    await assert.rejects(ctx.worker.exchange(), hasCode('HOSTING_OUTBOUND_SUBJECT_REJECTED'));
  }
  command = inventory(); hostId = 'other-host';
  await assert.rejects(ctx.worker.exchange(), hasCode('HOSTING_OUTBOUND_REPLY_INVALID'));
  assert.equal(handled, 0); assert.equal(ctx.worker.state.command, null);
});

test('SETUP cannot prepare/ensure paid execution, CONTROL can prepare but never enroll before ensure', async t => {
  const fixtureWire = JSON.parse(await readFile(new URL('./fixtures/gss-hosting-control-v1.json', import.meta.url)));
  const request = quotedPreparation({ ...fixtureWire.prepareRequest, ...scope });
  const { protocol, method, validUntil, ...fields } = request;
  const command = eventMessage('prepare-request', 'hosting.prepare', 'prepare-id', { ...fields, validUntilAt: validUntil });
  const ctx = await fixture(t, body => response(body.requestId, reply(command)));
  await assert.rejects(ctx.worker.exchange(), hasCode('HOSTING_OUTBOUND_SETUP_ONLY'));
  assert.deepEqual(ctx.f.control().state.operations, {});
  const otherRoot = resolve(ctx.f.root, 'control-transport'); await mkdir(otherRoot, { mode: 0o700 });
  const authorized = await new HostingOutbound({ ...ctx.options, stateRoot: otherRoot,
    authorization: { ...grant, authorizationId: 'hca_control', purpose: 'CONTROL' },
    fetchFn: async (_, options) => response(JSON.parse(options.body).requestId, { ...reply(command), authorizationId: 'hca_control' }) }).initialize(); ctx.closers.push(() => authorized.close());
  await authorized.exchange();
  assert.equal(authorized.state.result.data.outcome, 'PREPARED'); assert.equal(ctx.f.enrollmentCount(), 0);
  assert.equal(ctx.f.host().agents.size, 3);
});

test('crash after command persistence recovers same operation; invalid saved identity is rejected', async t => {
  const ctx = await fixture(t, (body, count) => response(body.requestId, count === 1 ? reply(inventory()) : reply(null, body.data.result.messageId)));
  const saved = { ...ctx.worker.state, command: inventory(), result: null };
  await ctx.worker.close(); await writeFile(ctx.worker.path, JSON.stringify(saved), { mode: 0o600 });
  const recovered = await new HostingOutbound(ctx.options).initialize();
  await recovered.exchange(); await recovered.exchange();
  assert.equal(ctx.calls[0].body.data.result, null);
  assert.equal(ctx.calls[1].body.data.result.correlationId, 'inventory-1');
  await recovered.close();
  saved.identity = { ...saved.identity, ownerJiacn: 'another' };
  await writeFile(ctx.worker.path, JSON.stringify(saved), { mode: 0o600 });
  await assert.rejects(new HostingOutbound(ctx.options).initialize(), hasCode('HOSTING_OUTBOUND_STATE_INVALID'));
});

test('exclusive writer prevents another worker; concurrent exchange cannot reorder commands', async t => {
  let release; const ctx = await fixture(t, body => new Promise(done => { release = () => done(response(body.requestId, reply())); }));
  await assert.rejects(new HostingOutbound(ctx.options).initialize(), hasCode('RUNTIME_WRITER_BUSY'));
  const running = ctx.worker.exchange();
  await assert.rejects(ctx.worker.exchange(), hasCode('HOSTING_OUTBOUND_BUSY'));
  await assert.rejects(ctx.worker.close(), hasCode('HOSTING_OUTBOUND_BUSY'));
  while (!release) await new Promise(done => setImmediate(done)); release(); await running;
});

test('transient reconnect keeps pending state; authorization failure stops without retry or secret logging', async t => {
  const abort = new AbortController(); let waits = 0;
  const ctx = await fixture(t, () => { throw Object.assign(Error(grant.token), { code: 'ECONNRESET' }); });
  await ctx.worker.run({ signal: abort.signal, waitFn: async () => { if (++waits === 2) abort.abort(); } });
  assert.equal(ctx.calls.length, 2); assert.equal(JSON.stringify(ctx.diagnostics).includes(grant.token), false);
  ctx.worker.fetchFn = async (_, options) => response(JSON.parse(options.body).requestId, null, 403, 'FORBIDDEN');
  await assert.rejects(ctx.worker.run({ signal: new AbortController().signal }), hasCode('FORBIDDEN'));
  assert.equal(waits, 2);
});

test('no remote plaintext, credential redirects, unauthenticated subject or stale ownership', async t => {
  const ctx = await fixture(t, body => response(body.requestId, reply()));
  assert.throws(() => new HostingOutbound({ ...ctx.options, apiOrigin: 'http://untrusted.example' }), hasCode('HOSTING_OUTBOUND_HTTPS_REQUIRED'));
  assert.throws(() => new HostingOutbound({ ...ctx.options, authorization: { ...grant, ownerJiacn: 'other' } }), hasCode('HOSTING_OUTBOUND_AUTHORIZATION_INVALID'));
  await ctx.worker.exchange(); assert.equal(ctx.calls[0].options.redirect, 'error');
  await ctx.worker.close(); await assert.rejects(ctx.worker.exchange(), hasCode('HOSTING_OUTBOUND_OWNERSHIP_REQUIRED'));
});

test('revoked grant or empty poll cannot authorize replay of an interrupted command', async t => {
  let status = 403;
  const ctx = await fixture(t, body => response(body.requestId, status === 403 ? null : reply(), status, status === 403 ? 'FORBIDDEN' : 'E0'));
  await ctx.worker.persist({ ...ctx.worker.state, command: inventory(), result: null });
  let handled = 0; ctx.f.control().handle = () => { handled++; throw Error('must not run'); };
  await assert.rejects(ctx.worker.exchange(), hasCode('FORBIDDEN'));
  status = 200; await ctx.worker.exchange();
  assert.equal(handled, 0); assert.equal(ctx.worker.state.command.messageId, 'inventory-1');
});

test('one failed authorization does not stop another Agent on the same host', async t => {
  const ctx = await fixture(t, body => response(body.requestId, null, 403, 'FORBIDDEN'));
  const stateRoot = resolve(ctx.f.root, 'other-agent'); await mkdir(stateRoot, { mode: 0o700 });
  const other = { ...grant, authorizationId: 'hca_other', canonicalAgentId: 'agt_other' };
  const worker = await new HostingOutbound({ ...ctx.options, stateRoot, authorization: other, fetchFn: async (_, options) => {
    const body = JSON.parse(options.body);
    return response(body.requestId, { ...reply(inventory('other', { canonicalAgentId: other.canonicalAgentId })), authorizationId: other.authorizationId });
  } }).initialize(); ctx.closers.push(() => worker.close());
  const results = await Promise.allSettled([ctx.worker.exchange(), worker.exchange()]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
  assert.equal(worker.state.result.data.canonicalAgentId, other.canonicalAgentId);
  assert.equal(ctx.f.host().agents.size, 3); assert.equal(ctx.f.enrollmentCount(), 0);
});

test('mismatched HTTP request correlation and changed command cannot execute a handler', async t => {
  const ctx = await fixture(t, () => response('wrong-http-request', reply(inventory())));
  await assert.rejects(ctx.worker.exchange(), hasCode('PROTOCOL_INVALID_RESPONSE'));
  assert.equal(ctx.worker.state.command, null);
  await ctx.worker.persist({ ...ctx.worker.state, command: inventory(), result: null });
  ctx.worker.fetchFn = async (_, options) => response(JSON.parse(options.body).requestId, reply(inventory('next')));
  await assert.rejects(ctx.worker.exchange(), hasCode('HOSTING_OUTBOUND_COMMAND_PENDING'));
  assert.equal(ctx.worker.state.command.messageId, 'inventory-1');
});

test('setup registration fixture publishes only the local bearer hash, not execution credentials', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/hosting-setup-v1.json', import.meta.url)));
  const token = `rth1_${'c'.repeat(64)}`;
  assert.equal(fixture.registrationRequest.data.tokenSha256, createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(fixture).includes(token), false);
  assert.equal(fixture.registrationResponse.data.authorization.purpose, 'SETUP');
  assert.equal(fixture.registrationResponse.data.status, 'WAITING_INVENTORY');
  assert.equal(fixture.registrationResponse.data.authorization.canonicalAgentId, fixture.registrationResponse.data.agentId);
  assert.equal(fixture.targetInventorySource, 'TARGET');
});

test('SETUP discovers a separate exact CONTROL worker without changing the operator file or exposing tokens', async t => {
  const controlAuthorization = activationWire.activationResponse.data.controlAuthorization;
  const authorization = { ...grant, controlToken: `rth1_${'b'.repeat(64)}` };
  let controlSeen;
  const seen = new Promise(done => { controlSeen = done; });
  const ctx = await fixture(t, (body, count, options) => {
    if (body.data.authorizationId === controlAuthorization.authorizationId) {
      assert.equal(options.headers.Authorization, `RuntimeHosting ${authorization.controlToken}`);
      controlSeen();
      return response(body.requestId, { ...reply(), authorizationId: controlAuthorization.authorizationId });
    }
    assert.equal(options.headers.Authorization, `RuntimeHosting ${grant.token}`);
    return response(body.requestId, { ...reply(), controlAuthorization });
  }, authorization);
  await ctx.worker.exchange(); await seen;
  assert.equal(ctx.worker.controlEntry.worker.control, ctx.worker.control);
  assert.equal(ctx.f.enrollmentCount(), 0);
  const child = ctx.worker.controlEntry.worker;
  assert.equal((await readFile(child.path, 'utf8')).includes(authorization.controlToken), false);
  await ctx.worker.exchange(); assert.equal(ctx.worker.controlEntry.worker, child);
  await ctx.worker.close(); assert.equal(child.release, null);
});
test('SETUP cannot accept CONTROL metadata for another owner or promote its own credential', async t => {
  const authorization = { ...grant, controlToken: `rth1_${'b'.repeat(64)}` };
  const ctx = await fixture(t, body => response(body.requestId, { ...reply(), controlAuthorization: {
    ...sharedWire.authorization, authorizationId: 'hca_control', purpose: 'CONTROL', ownerJiacn: 'other-owner'
  } }), authorization);
  await assert.rejects(ctx.worker.exchange(), hasCode('HOSTING_OUTBOUND_CONTROL_REJECTED'));
  assert.equal(ctx.worker.controlEntry, null);
  assert.throws(() => new HostingOutbound({ ...ctx.options, authorization: { ...authorization, controlToken: grant.token } }), hasCode('HOSTING_OUTBOUND_AUTHORIZATION_INVALID'));
});

test('shared target M fixture prepares only the isolated target before payment', async t => {
  const ctx = await fixture(t, body => response(body.requestId, activationWire.response.data));
  await ctx.worker.exchange();
  assert.equal(ctx.worker.state.result.data.outcome, 'TARGET_READY');
  assert.deepEqual(Object.keys(ctx.worker.control.state.subjects), []);
  assert.equal(ctx.f.enrollmentCount(), 0);
});
