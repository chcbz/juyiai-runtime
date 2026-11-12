// Supervisor for independent authorization transports on the SAME RuntimeHost.
// Operator-owned credential file updates do not grant API business permission.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { HostingOutbound } from './hosting-outbound.mjs';
import { canonicalHostingPath, hostingError } from './hosting-config.mjs';
import { readPrivateJson, ensurePrivateDirectory } from './security.mjs';
import { stableJson } from './manifest.mjs';
import { classifyRuntimeError } from './runtime-client.mjs';

export class HostingOutboundHost {
  constructor({ control, apiOrigin, logger = () => {}, createWorker = options => new HostingOutbound(options) }) {
    this.control = control; this.apiOrigin = apiOrigin; this.logger = logger; this.createWorker = createWorker;
    this.workers = new Map(); this.gate = Promise.resolve(); this.closing = false; this.closePromise = null; this.refreshing = null;
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    const job = this.gate.then(() => this.reconcile());
    this.refreshing = job;
    const finished = () => { this.refreshing = null; };
    void job.then(finished, finished);
    this.gate = job.catch(() => {}); return job;
  }
  async reconcile() {
    if (this.closing) return;
    const config = this.control.config.outbound;
    await canonicalHostingPath(config.authorizationsPath);
    const value = await readPrivateJson(config.authorizationsPath, null);
    if (!value || value.configVersion !== 1 || !Array.isArray(value.authorizations))
      throw hostingError('HOSTING_OUTBOUND_AUTHORIZATIONS_INVALID');
    const desired = new Map();
    // Validate the complete replacement before changing any healthy transport.
    for (const authorization of value.authorizations) {
      const id = authorization?.authorizationId;
      const stateRoot = resolve(this.control.config.managedRoot, 'outbound', createHash('sha256').update(String(id)).digest('hex'));
      const worker = this.createWorker({ control: this.control, authorization, stateRoot, apiOrigin: this.apiOrigin, logger: this.logger });
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
      if (this.closing || this.workers.has(id)) continue;
      const entry = { ...candidate, aborter: new AbortController(), task: null };
      this.workers.set(id, entry);
      try {
        await ensurePrivateDirectory(entry.worker.stateRoot);
        await entry.worker.initialize();
        entry.task = entry.worker.run({ signal: entry.aborter.signal, pollIntervalMs: config.pollIntervalMs })
          .catch(error => this.isolated(error));
      } catch (error) {
        // Keep the failed ID quarantined; periodic reload is not a replay permission.
        this.isolated(error);
      }
    }
  }
  isolated(error) {
    this.logger('hosting-outbound-isolated', { category: classifyRuntimeError(error).kind });
  }
  async stop(entry) {
    entry.aborter.abort(); await entry.task; await entry.worker.close();
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
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
