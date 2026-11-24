import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { digestManifest, readRuntimeHostConfig } from '../lib/manifest.mjs';
import { createExecutionAdapterFactory } from '../lib/execution-adapter.mjs';
import { isManagementMessage, parseManagementMessage } from '../../codex-bridge/skill-management-wire.mjs';
import { fromAgentWire } from '../../codex-bridge/agent-message-wire.mjs';
import { agentMessageFixture, httpFixture } from './agent-wire-fixture.mjs';
export async function fixture(t, { count = 3, sameAgentId = false, firstIdentity = {} } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'ur01-owned-fixture-'));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { await rm(root, { recursive: true, force: true }); } // only this test's fresh root
  });
  const hostRoot = resolve(root, 'host');
  await mkdir(hostRoot, { mode: 0o700 });
  const entries = []; const manifests = []; const profiles = [];
  const json = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  for (let i = 0; i < count; i++) {
    const base = resolve(root, `agent-${i}`); await mkdir(base, { mode: 0o700 });
    for (const name of ['state', 'home', 'work']) await mkdir(resolve(base, name), { mode: 0o700 });
    const unsigned = { runtimeProtocolVersion: 'v1', manifestVersion: '1', installationId: `installation-${i}`,
      tenantId: `tenant-${i}`, clientId: 'client', canonicalAgentId: sameAgentId ? 'agent' : `agent-${i}`, ...(i === 0 ? firstIdentity : {}) };
    const manifest = { ...unsigned, manifestSha256: digestManifest(unsigned) };
    const profile = { profileId: `profile-${i}`, agentId: manifest.canonicalAgentId, codexBin: '/bin/true',
      codexHome: resolve(base, 'home'), codexWorkdir: resolve(base, 'work'), appServerEnabled: false,
      fastChatEnabled: false, typedInspectionProviderNetwork: 'isolated' };
    const entry = { manifestPath: resolve(base, 'manifest.json'), profilePath: resolve(base, 'profile.json'), stateRoot: resolve(base, 'state') };
    await json(entry.manifestPath, manifest); await json(entry.profilePath, profile);
    entries.push(entry); manifests.push(manifest); profiles.push(profile);
  }
  const raw = { configVersion: 1, hostId: 'stable-host', stateRoot: hostRoot, agents: entries };
  const path = resolve(root, 'host.json'); await json(path, raw);
  return { root, raw, path, entries, manifests, profiles, json, cleanup: fn => cleanups.push(fn),
    async config() { await json(path, raw); return readRuntimeHostConfig(path); },
    async profile(i, change) { Object.assign(profiles[i], change); await json(entries[i].profilePath, profiles[i]); },
    async manifest(i, change) { Object.assign(manifests[i], change); manifests[i].manifestSha256 = digestManifest(manifests[i]); await json(entries[i].manifestPath, manifests[i]); }
  };
}

// M3 adapter acceptance: exact Wire r1 token-free registration and per-subject
// lifecycle. Synthetic socket/HTTP only; no server/production claim.
export async function channelFixture(t, { ackRegistration = true, nativeWorkNotifications = null, workspaceFileWorkNotifications = null, archiveJobDiscovery = null, chatReady = false, types = ['TASK_INVITE'], healthy = true, validateBusiness = false, firstIdentity = {}, hostId = 'stable-host', instanceId = 'boot-fixture', previousGeneration = 6, comparePrepared, measureSkills = false, sessionFailureOnce = null, reconcileSkills = false } = {}) {
  const { EventEmitter } = await import('node:events');
  const { RuntimeV1Client } = await import('../lib/runtime-client.mjs');
  const f = await fixture(t, { count: 2, firstIdentity }); f.raw.hostId=hostId; const config = await f.config();
  const requests = []; const sockets = []; const engines = new Map(); const logs = [];
  const normalize = validateBusiness ? (await import('../../codex-bridge/agent-client.mjs')).normalizeInboundMessage : null;
  const socketEvents = new EventEmitter();
  class Socket extends EventEmitter {
    constructor(url, options) {
      super(); this.url = url; this.headers = options.headers; this.readyState = 0; this.sent = [];
      // Concurrent session HTTP reads can complete in either order; fixture indices are subjects, not arrival order.
      const index = config.agents.findIndex(agent => agent.manifest.canonicalAgentId === this.headers['X-Agent-Id']);
      assert.ok(index >= 0);
      if (!sockets[index]) sockets[index] = this; else sockets.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.emit('open'); socketEvents.emit('opened', this); } });
    }
    send(bytes) {
      const frame = fromAgentWire(bytes); this.sent.push(frame);if(frame.messageType==='runtime.task.configuration.measured')this.measuredWire=bytes;
      if (frame.messageType === 'agent.register' && ackRegistration) queueMicrotask(() => this.receive({ type: 'agent_registered',
        messageId: frame.messageId, agentId: frame.agentId, runtimeInstanceId: frame.runtimeInstanceId,
        installationId: frame.installationId, hostId: frame.hostId, sessionGeneration: frame.sessionGeneration,
        status: 'online', durableStateHealthy: frame.durableStateHealthy, readyCommandTypes: frame.readyCommandTypes,
        ...(nativeWorkNotifications === 1 ? { nativeWorkNotifications: 1 } : {}),
        ...(workspaceFileWorkNotifications === 1 ? { workspaceFileWorkNotifications: 1 } : {}),
        ...(archiveJobDiscovery !== null ? { archiveJobDiscovery } : {}),
        ...(measureSkills ? { runtimeAuth: { scheme: 'native-runtime-v1', tenantId: frame.tenantId, clientId: frame.clientId,
          ownerJiacn: 'fixture-owner', agentId: frame.agentId, installationId: frame.installationId, hostId: frame.hostId,
          runtimeInstanceId: frame.runtimeInstanceId, sessionGeneration: frame.sessionGeneration, contextPackEnabled: true } } : {}) }));
    }
    receive(frame) { this.emit('message', Buffer.from(JSON.stringify(agentMessageFixture(frame)))); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit('close', code)); }
    terminate() { this.close(); }
  }
  const module = {
    buildProtocolEnvelope: (messageType, payload) => ({ schemaVersion: 1, messageType, ...payload }),
    createRuntimeExecutionHost: () => ({
      createExecutor: ({ subjectKey, agent }) => {
        const state = { profile: agent.profile, processor: { pause: () => { state.paused = true; } }, healthy,
          accepted: [], normalized: [], closed: false, resumed: 0, types: [...types], paused: true, transport: null };
        engines.set(subjectKey, state);
        return {
          initialize: async () => {}, bindTransport: transport => { state.transport = transport; }, attachSocket: socket => { state.socket = socket; },
          bindSkillSession: binding => {
            state.skillBinding = binding;
            if (!measureSkills || !binding || state.catalogMeasured) return false;
            queueMicrotask(() => { state.catalogMeasured = true; state.transport.refreshCapabilities(); });
            return true;
          },
          bindWorkNotifications: version => { state.workNotificationVersion = version; },
          comparePreparedLocalTask: outputs => { (state.preparedReads ||= []).push(outputs);return comparePrepared ? comparePrepared(outputs) : state.preparedGroup; },
          nativeWorkAvailable: () => { state.workHints = (state.workHints || 0) + 1; },
          bindWorkspaceFileWorkNotifications: version => { state.fileWorkNotificationVersion = version; },
          workspaceFileWorkAvailable: () => { state.fileWorkHints = (state.fileWorkHints || 0) + 1; },
          matchesSkillManagementAck: envelope => state.skillInstallManager?.matchesDurableAckEnvelope(envelope) === true,
          ...(reconcileSkills ? {
            reconcilePositionSkills: async () => { (state.reconciliation ||= []).push('positions'); if (state.positionGate) await state.positionGate; if (state.reconcileFailure) throw Object.assign(new Error('private'), {code:'POSITION_TEST_FAILURE'}); },
            reconcileArchiveJobs: async () => { (state.reconciliation ||= []).push('archive'); }
          } : {}),
          matchesSkillInstallResult: envelope => state.skillInstallManager?.matchesDurableResultEnvelope(envelope) === true,
          matchesSkillInstallReceipt: receipt => state.skillInstallManager?.matchesDurableResultReceipt(receipt) === true,
          durableStateHealthy: () => { state.healthChecks = (state.healthChecks || 0) + 1; return state.healthy; }, readyCommandTypes: () => state.types, chatReady: () => chatReady,
          registrationPayload: () => ({ runtimeCapabilities: { profiles: { EXECUTE: { available: false } } } }),
          acceptFrame: async frame => { state.accepted.push(frame); if (normalize && !(frame.type === 'agent_message_saved' && !Object.hasOwn(frame, 'messageType'))) state.normalized.push(isManagementMessage(frame) ? parseManagementMessage(frame) : normalize(frame)); return state.handleFrame?.(frame); }, resume: async () => { state.resumed++; },
          disconnected: () => { state.paused = true; }, suspendAdmission: () => { state.paused = true; },
          close: async () => { state.closed = true; }, state: () => state
        };
      }, close: async () => {}
    })
  };
  for (const agent of config.agents) await f.json(resolve(agent.stateRoot, 'runtime-authorization.json'), { installationId: agent.manifest.installationId, runtimeAuthorization: 'synthetic-' + agent.manifest.installationId });
  const generation = new Map();
  const adapters = await createExecutionAdapterFactory({ config, instanceId, apiOrigin: 'https://api.example.test', socketFactory: Socket, logger: (event, details) => logs.push({ event, ...details }),
    loadEngine: async () => module, clientFactory: settings => new RuntimeV1Client({ ...settings, fetchFn: async (url, options) => {
      const body = JSON.parse(options.body).data; requests.push({ url, options, body });
      if (url.endsWith('/session')) {
        if (sessionFailureOnce) { const code = sessionFailureOnce; sessionFailureOnce = null; throw new TypeError('fetch failed', { cause: { code } }); }
        const current = (generation.get(body.runtimeInstallationId) ?? previousGeneration) + 1; generation.set(body.runtimeInstallationId, current);
        return httpFixture(options, { ...Object.fromEntries(['runtimeInstallationId','tenantId','clientId','canonicalAgentId','hostId','runtimeInstanceId'].map(key => [key, body[key]])), sessionGeneration: String(current),
          scheme: 'AgentRuntime', sessionToken: 'rts1_' + 'a'.repeat(64), websocketPath: '/ws/agent/channel', status: 'CHANNEL_PENDING' });
      }
      return httpFixture(options, { kind: 'ADVANCED', status: body.status, deliveryVersion: String(BigInt(body.deliveryVersion ?? '0') + 1n) });
    } }) });
  f.cleanup(() => adapters.close());
  const executors = config.agents.map(agent => adapters.createExecutor({ subjectKey: agent.subjectKey, agent }));
  for (const executor of executors) await executor.initialize();
  return { f, config, adapters, sockets, requests, executors, engines, logs, states: () => [...engines.values()], nextOpened: () => new Promise(resolveOpen => socketEvents.once('opened', resolveOpen)), opened: () => sockets.some(socket => socket.readyState === 1) ? Promise.resolve() : new Promise(resolveOpen => socketEvents.once('opened', resolveOpen)), tick: () => new Promise(resolveTick => setImmediate(resolveTick)) };
}
