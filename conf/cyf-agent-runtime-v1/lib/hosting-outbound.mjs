// Outbound transport for the existing HostingControl lifecycle. No listener,
// business execution authority, payment decisions or second lifecycle journal.
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { encodeHttpRequest, decodeHttpResponse } from './api-envelope.mjs';
import { validateMessage } from './message-envelope.mjs';
import { validateHostingRequest, hostingReply } from './hosting-wire.mjs';
import { exactHostingId, hostingError } from './hosting-config.mjs';
import { normalizeRuntimeOrigin, classifyRuntimeError } from './runtime-client.mjs';
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from './security.mjs';
import { acquireRuntimeOwnership } from './runtime-host.mjs';
import { stableJson } from './manifest.mjs';

export const HOSTING_EXCHANGE_PATH = '/agent/runtime/v1/hosting/exchanges';
const subjectFields = ['tenantId', 'clientId', 'ownerJiacn', 'canonicalAgentId'];
const tokenPattern = /^rth1_[0-9a-f]{64}$/;
const fail = code => { throw hostingError(code); };
const same = (a, b) => stableJson(a) === stableJson(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const wait = (ms, signal) => new Promise(done => {
  if (signal.aborted) return done();
  const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); done(); };
  const timer = setTimeout(stop, ms); signal.addEventListener('abort', stop, { once: true });
});

/** One exact authorization, not a hostId-as-user credential. SETUP may only
 * inspect capabilities/inventory. The API must issue a separate CONTROL grant
 * after reserve. Neither grant is an AgentRuntime execution/session credential.
 * stateRoot is an operator-created private subdirectory, never a wire path. */
export class HostingOutbound {
  constructor({ control, authorization, stateRoot, apiOrigin, fetchFn = fetch, logger = () => {} }) {
    if (!control || !object(authorization) || !exactHostingId(authorization.authorizationId)
        || !tokenPattern.test(authorization.token) || !['SETUP', 'CONTROL'].includes(authorization.purpose)
        || authorization.controlToken !== undefined && (authorization.purpose !== 'SETUP' || !tokenPattern.test(authorization.controlToken) || authorization.controlToken === authorization.token)
        || subjectFields.some(field => !exactHostingId(authorization[field]))
        || authorization.hostId !== control.host.config.hostId || !control.scopeAllowed(authorization))
      fail('HOSTING_OUTBOUND_AUTHORIZATION_INVALID');
    this.origin = normalizeRuntimeOrigin(apiOrigin);
    const url = new URL(this.origin);
    if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) fail('HOSTING_OUTBOUND_HTTPS_REQUIRED');
    this.control = control; this.authorization = Object.freeze({ ...authorization });
    this.identity = Object.freeze(Object.fromEntries(['authorizationId', 'hostId', 'purpose', ...subjectFields].map(key => [key, authorization[key]])));
    this.stateRoot = stateRoot; this.path = resolve(stateRoot, 'hosting-exchange.json');
    this.controlEntry = null; this.fetchFn = fetchFn; this.logger = logger; this.release = null; this.state = null; this.active = false;
  }

  async initialize() {
    if (this.release || !this.control.release || !this.control.host.releaseHost) fail('HOSTING_OUTBOUND_OWNERSHIP_REQUIRED');
    this.release = await acquireRuntimeOwnership(this.stateRoot, { hostId: this.identity.hostId,
      instanceId: this.control.host.instanceId, subjectKey: `hosting:${this.identity.authorizationId}` });
    try {
      this.state = await readPrivateJson(this.path, null);
      if (this.state === null) {
        this.state = { formatVersion: 1, identity: this.identity, command: null, result: null };
        await writePrivateJson(this.path, this.state, { exclusive: true });
      }
      this.validateState(this.state);
      return this;
    } catch (error) { await this.release(); this.release = null; throw error; }
  }

  validateCommand(command) {
    const request = validateHostingRequest(command);
    if (subjectFields.filter(field => field !== 'canonicalAgentId' || request.method !== 'capabilities')
      .some(field => request[field] !== this.identity[field])) fail('HOSTING_OUTBOUND_SUBJECT_REJECTED');
    if (this.identity.purpose === 'SETUP' && !['capabilities', 'target', 'inventory'].includes(request.method))
      fail('HOSTING_OUTBOUND_SETUP_ONLY');
    return request;
  }

  validateState(state) {
    if (!object(state) || state.formatVersion !== 1 || !same(state.identity, this.identity)
        || !Object.hasOwn(state, 'command') || !Object.hasOwn(state, 'result')) fail('HOSTING_OUTBOUND_STATE_INVALID');
    if (state.command !== null) this.validateCommand(state.command);
    if (state.result !== null) {
      validateMessage(state.result);
      if (!state.command || state.result.correlationId !== state.command.messageId
          || state.result.requestId !== state.command.requestId || state.result.code !== 'E0'
          || state.result.messageType !== `${state.command.messageType}.result`) fail('HOSTING_OUTBOUND_STATE_INVALID');
    }
  }

  async persist(next) {
    this.validateState(next);
    // Do not process/send another command after an uncertain journal write.
    try { await writePrivateJson(this.path, next); this.state = next; }
    catch (cause) { this.state = null; throw cause; }
  }

  async executePending() {
    if (this.state.command === null || this.state.result !== null) return;
    const request = this.validateCommand(this.state.command);
    // Existing methods reconcile exact lifecycle operation IDs. On a crash
    // before response persistence, recover that same operation, never a new one.
    // Errors remain pending/unknown; never invent FAILED_NO_EFFECT or cleanup.
    const result = hostingReply(this.state.command, await this.control.handle(request));
    await this.persist({ ...this.state, result });
  }

  async exchange(signal) {
    if (this.active) fail('HOSTING_OUTBOUND_BUSY');
    if (!this.release || !this.state || !this.control.release || this.control.closing
        || !this.control.host.releaseHost || this.control.host.stopping) fail('HOSTING_OUTBOUND_OWNERSHIP_REQUIRED');
    this.active = true;
    try {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const requestId = randomUUID();
      const response = await this.fetchFn(`${this.origin}${HOSTING_EXCHANGE_PATH}`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId,
          Authorization: `RuntimeHosting ${this.authorization.token}` },
        body: JSON.stringify(encodeHttpRequest({ authorizationId: this.identity.authorizationId,
          hostId: this.identity.hostId, runtimeInstanceId: this.control.host.instanceId, result: this.state.result }, requestId))
      });
      const reply = decodeHttpResponse(await response.text(), { status: response.status, requestId,
        responseRequestId: response.headers.get('x-request-id') ?? undefined }).value;
      if (!object(reply) || reply.authorizationId !== this.identity.authorizationId || reply.hostId !== this.identity.hostId
          || !Object.hasOwn(reply, 'acknowledgedMessageId') || !Object.hasOwn(reply, 'command')) fail('HOSTING_OUTBOUND_REPLY_INVALID');
      await this.acceptControl(reply.controlAuthorization);
      const pending = this.state.result;
      if (reply.acknowledgedMessageId !== null && reply.acknowledgedMessageId !== pending?.messageId)
        fail('HOSTING_OUTBOUND_ACK_INVALID');
      const acknowledged = pending !== null && reply.acknowledgedMessageId === pending.messageId;
      if (reply.command !== null) {
        this.validateCommand(reply.command);
        if (this.state.command && reply.command.messageId === this.state.command.messageId) {
          if (!same(reply.command, this.state.command)) fail('HOSTING_OUTBOUND_COMMAND_CONFLICT');
          // A duplicate command is an explicit request to replay the same result,
          // even when the previous result was acknowledged in this response.
          await this.executePending(); // Fresh API authorization precedes interrupted-command recovery.
          return;
        }
        if (this.state.command && !pending) fail('HOSTING_OUTBOUND_COMMAND_PENDING');
        if (pending && !acknowledged) fail('HOSTING_OUTBOUND_RESULT_PENDING');
      }
      if (this.state.command && !pending) return; // Unknown execution is not an empty queue.
      if (pending && !acknowledged) return; // Never drop an unconfirmed result on an empty poll.
      await this.persist({ ...this.state, command: reply.command, result: null });
      await this.executePending();
    } finally { this.active = false; }
  }

  async acceptControl(metadata) {
    if (metadata == null) return;
    if (this.identity.purpose !== 'SETUP' || !this.authorization.controlToken || !object(metadata)
        || metadata.purpose !== 'CONTROL' || metadata.authorizationId === this.identity.authorizationId
        || ['hostId', ...subjectFields].some(key => metadata[key] !== this.identity[key]))
      fail('HOSTING_OUTBOUND_CONTROL_REJECTED');
    const authorization = { ...metadata, token: this.authorization.controlToken };
    if (this.controlEntry) {
      if (!same(this.controlEntry.authorization, authorization)) fail('HOSTING_OUTBOUND_CONTROL_CONFLICT');
      return;
    }
    const stateRoot = resolve(this.stateRoot, 'control', createHash('sha256').update(metadata.authorizationId).digest('hex'));
    const worker = new HostingOutbound({ control: this.control, authorization, stateRoot, apiOrigin: this.origin, fetchFn: this.fetchFn, logger: this.logger });
    await ensurePrivateDirectory(stateRoot);
    await worker.initialize();
    const aborter = new AbortController();
    const entry = { authorization, worker, aborter, task: null };
    this.controlEntry = entry;
    entry.task = worker.run({ signal: aborter.signal }).catch(error => {
      this.logger('hosting-outbound-control-isolated', { category: classifyRuntimeError(error).kind });
    });
  }
  async closeControl() {
    const entry = this.controlEntry;
    if (!entry) return;
    entry.aborter.abort(); await entry.task; await entry.worker.close();
    this.controlEntry = null;
  }

  async run({ signal, pollIntervalMs = 1000, waitFn = wait }) {
    if (!signal || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) fail('HOSTING_OUTBOUND_RUN_INVALID');
    try { while (!signal.aborted) {
      try { await this.exchange(signal); }
      catch (cause) {
        if (signal.aborted) return;
        const category = classifyRuntimeError(cause).kind;
        if (!['transient-network', 'transient-http'].includes(category)) throw cause;
        // No message, URL, token, command content or raw exception in diagnostics.
        this.logger('hosting-outbound-retry', { category });
      }
      if (!signal.aborted) await waitFn(pollIntervalMs, signal);
    } } finally { await this.closeControl(); }
  }

  async close() {
    if (this.active) fail('HOSTING_OUTBOUND_BUSY'); // Abort/join the caller's run before releasing its writer.
    await this.closeControl();
    await this.release?.(); this.release = null; this.state = null;
  }
}
