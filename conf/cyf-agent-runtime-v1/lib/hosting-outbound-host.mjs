// One authenticated host directory supervises independent Agent transports on
// the SAME RuntimeHost. A complete scan is required before removing workers.
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { HostingOutbound } from './hosting-outbound.mjs';
import { hostingError } from './hosting-config.mjs';
import { ensurePrivateDirectory } from './security.mjs';
import { stableJson } from './manifest.mjs';
import { decodeHttpResponse } from './api-envelope.mjs';
import { normalizeRuntimeOrigin, classifyRuntimeError } from './runtime-client.mjs';

export class HostingOutboundHost {
  constructor({ control, apiOrigin, fetchFn = fetch, logger = () => {}, createWorker = options => new HostingOutbound(options) }) {
    this.control = control; this.apiOrigin = normalizeRuntimeOrigin(apiOrigin); this.fetchFn = fetchFn;
    const url = new URL(this.apiOrigin);
    if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) throw hostingError('HOSTING_OUTBOUND_HTTPS_REQUIRED');
    this.credential = control.hostCredential; this.paused = false; this.aborter = new AbortController(); this.logger = logger; this.createWorker = createWorker;
    this.workers = new Map(); this.quarantined = new Set(); this.gate = Promise.resolve(); this.closing = false; this.closePromise = null; this.refreshing = null;
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    const job = this.gate.then(() => this.reconcile());
    this.refreshing = job;
    const finished = () => { this.refreshing = null; };
    void job.then(finished, finished);
    this.gate = job.catch(() => {}); return job;
  }
  async directory() {
    const items = []; let cursor = null;
    do {
      const requestId = randomUUID();
      const query = new URLSearchParams({ pageSize: '100', ...(cursor === null ? {} : { cursor }) });
      const response = await this.fetchFn(`${this.apiOrigin}/agent/runtime/v1/hosting/authorizations?${query}`, {
        method: 'GET', redirect: 'error', signal: this.aborter.signal,
        headers: { 'X-Request-Id': requestId, Authorization: `RuntimeHosting ${this.credential.token}` }
      });
      const page = decodeHttpResponse(await response.text(), { status: response.status, requestId,
        responseRequestId: response.headers.get('x-request-id') ?? undefined }).value;
      if (!page || stableJson(page.host) !== stableJson(this.credential.host) || !Array.isArray(page.items)
          || page.items.length > 100 || typeof page.hasMore !== 'boolean'
          || (page.hasMore ? !page.items.length || page.nextCursor !== page.items.at(-1)?.authorizationId : page.nextCursor !== null))
        throw hostingError('HOSTING_OUTBOUND_DIRECTORY_INVALID');
      for (const item of page.items) {
        if (typeof item?.authorizationId !== 'string' || cursor !== null && item.authorizationId <= cursor)
          throw hostingError('HOSTING_OUTBOUND_DIRECTORY_INVALID');
        cursor = item.authorizationId; items.push(item);
      }
      if (!page.hasMore) return items;
    } while (!this.closing);
    throw hostingError('HOSTING_CONTROL_NOT_RUNNING');
  }
  async reconcile() {
    if (this.closing || this.paused) return;
    const config = this.control.config.outbound;
    let authorizations;
    try { authorizations = await this.directory(); }
    catch (error) { if (error?.status === 401) this.pause(); throw error; }
    const desired = new Map();
    // Validate the complete replacement before changing any healthy transport.
    for (const authorization of authorizations) {
      const id = authorization?.authorizationId;
      const stateRoot = resolve(this.control.config.managedRoot, 'outbound', createHash('sha256').update(String(id)).digest('hex'));
      const worker = this.createWorker({ control: this.control, authorization, credential: this.credential, fetchFn: this.fetchFn, stateRoot, apiOrigin: this.apiOrigin, logger: this.logger });
      if (desired.has(id)) throw hostingError('HOSTING_OUTBOUND_AUTHORIZATION_DUPLICATE');
      const fingerprint = createHash('sha256').update(stableJson(authorization)).digest('hex');
      const prior = this.workers.get(id);
      if (prior && prior.fingerprint !== fingerprint) throw hostingError('HOSTING_OUTBOUND_AUTHORIZATION_CONFLICT');
      desired.set(id, { worker, fingerprint });
    }
    // Removed grants stop poll/receipt delivery; state is retained, never cleaned or replayed locally.
    await Promise.all([...this.workers].filter(([id]) => !desired.has(id)).map(async ([id, entry]) => {
      await this.stop(entry); this.workers.delete(id);
    }));
    for (const [id, candidate] of desired) {
      if (this.closing || this.paused || this.workers.has(id) || this.quarantined.has(id)) continue;
      const entry = { ...candidate, aborter: new AbortController(), task: null };
      this.workers.set(id, entry);
      try {
        await ensurePrivateDirectory(entry.worker.stateRoot);
        await entry.worker.initialize();
        entry.task = entry.worker.run({ signal: entry.aborter.signal, pollIntervalMs: config.pollIntervalMs })
          .catch(error => { this.quarantined.add(id); this.isolated(error); });
      } catch (error) {
        // Keep the failed ID quarantined; periodic reload is not a replay permission.
        this.quarantined.add(id); this.isolated(error);
      }
    }
  }
  pause() {
    this.paused = true;
    for (const entry of this.workers.values()) entry.aborter.abort();
  }
  isolated(error) {
    if (error?.status === 401) this.pause();
    this.logger('hosting-outbound-isolated', { category: classifyRuntimeError(error).kind });
  }
  async stop(entry) {
    entry.aborter.abort(); await entry.task; await entry.worker.close();
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true; this.aborter.abort();
    // Abort before joining an in-flight refresh, so blocked polls cannot hold shutdown.
    for (const entry of this.workers.values()) entry.aborter.abort();
    const controlClosing = this.control.close().then(() => null, error => error);
    this.closePromise = (async () => {
      await this.gate;
      const results = await Promise.allSettled([...this.workers.values()].map(entry => this.stop(entry)));
      const controlError = await controlClosing;
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (controlError) throw controlError;
    })();
    return this.closePromise;
  }
}
