# GSS-HOSTING-RUNTIME-20261010 implementation boundary

Frozen before source edits, 2026-10-10; base 2ce6fedf34832048e248fde3e07222f5ed867b7a.
Owner gss_runtime_sol_20261010. Development only; no installation, provider call or production readiness evidence.

- Wire catalog: runtime-hosting-v1, capabilities/prepare/ensure/observe; exact flat association from Main's frozen GSS-HOSTING-CONTROL-CONTRACT-20261010.md. Reject duplicate and unknown keys. No request-selected paths, commands, URLs or secrets.
- Lock order: existing lifetime host ownership -> control per-subject journal gate -> RuntimeHost per-subject lifecycle gate -> existing executor short durable-store locks. Journal commits finish before enrollment/session/activation. Observe reads live executor proof, never awaits activation or treats persisted READY as current readiness.
- Transaction boundary: prepare durably allocates a candidate only; API transaction authorizes exact installation before ensure. Runtime has no DB transaction. Ensure durably admits before enrollment/network; enrollment uncertainty marker remains authoritative and prohibits retry. Reprovision preserves installation/manifest/auth; only the subject executor/session changes.
- Sensitive allowlist: only enrollmentSecretSha256 and manifest digest leave private journal; runtime authorization and enrollment secret never leave private Runtime state except native authenticated API enrollment/session calls. Socket admission is filesystem identity/permissions plus exact configured tenant/client/owner scope. Operator explicitly grants access to the API OS identity; hostile same-UID processes are not an isolation boundary.
- Coverage: dynamic add/recreate and peers unchanged -> hosting lifecycle tests; registration-pending heartbeat -> existing runtime-host tests; exact association/replay/scope/duplicate fields/generation -> hosting control tests; journal restart and stale readiness -> hosting control tests; lost enrollment response -> runtime-v1 tests plus hosting control tests; installer/schema/template boundary -> config/installer source checks. All network tests use local mocks, not actual readiness.

Managed template and source installer support are specified below with exact fields. Retired broker remains retired. Final module-wide, isolated DB and production validation belong to Main/test runner, not this Owner.

## Optional host-level mutual TLS control (1.3.98 source candidate)

A remote self-hosted Runtime can expose the **same** hosting handler and journal
through mutual TLS, independent of the Agent executor. Stopping an Agent does not
stop this listener: evidence acknowledgement and private cleanup remain possible.
The local private socket remains supported; no second billing or lifecycle engine
is introduced. Runtime support alone does not enable API routing or production fees.

Operator-owned hosting configuration may add exactly:

```json
"remote": {
  "listenHost": "127.0.0.1",
  "port": 9443,
  "certificatePath": "/home/isp/conf/cyf-agent-runtime-v1/control-tls/server.crt",
  "privateKeyPath": "/home/isp/conf/cyf-agent-runtime-v1/control-tls/server.key",
  "clientCaPath": "/home/isp/conf/cyf-agent-runtime-v1/control-tls/client-ca.crt"
}
```

Use an explicitly selected local interface and reachable production port; port zero
is only useful for tests. Certificates and private keys must be ordinary canonical
files outside host state, managed state and every Agent mutable root, owned by root
or the Runtime service identity. Keys permit no group/other access; certificates and
client CA must not be group/world writable. Never put control keys in CODEX_HOME.
Use a dedicated control-client CA: **every client it authorizes is a control caller**,
then the existing tenant/client/owner scope and exact relationship checks apply.
The API must verify the server certificate hostname/IP and provide its client key.
TLS 1.2 or later, client certificate validation and the 16384-byte request bound are
mandatory. There is no unauthenticated listener or request-selected endpoint/key.

Requests/replies keep the existing newline-framed protocolVersion 1 envelope.
Socket and TLS calls share idempotency, association, journal and execution gates.
Missing/untrusted client certificates are rejected before handler dispatch. TLS
startup failure closes the partially opened private listener; shutdown closes owned
connections including unfinished handshakes. Certificate changes require a controlled
host restart; no extra polling or certificate-management framework is introduced.
An omitted `remote` retains local-only behavior. Static-only hosts may use
`template: null`; `hosting.adopt` associates their exact existing installation without
enrollment, restart or charging, not a fabricated SERVICE_READY proof.

Source tests: `test/hosting-tls.test.mjs`, alongside hosting-config/adoption/lifecycle.
Local synthetic certificates prove transport behavior, not deployed remote readiness.

## Operator setup (source contract, NOT performed on this host)

The artifact-staging installer includes `hosting-control.example.json`, this guide,
`lib/hosting-*.mjs` and `systemd/cyf-agent-runtime-v1-hosting.tmpfiles.conf.example`.
It does not install a service, create production roots, apply tmpfiles, enroll,
connect a provider, or change the API. Existing static config remains valid.

1. Explicitly authorize the release and fix its source/artifact. Copy the example
   to an operator-owned **0600**, non-symlink external configuration, e.g.
   `/home/isp/conf/cyf-agent-runtime-v1/unified.hosting.json`. Replace all placeholders with
   the authorized tenant/client/owner and independent managed provider/model/binary.
   The example is not proof the production host is already configured. Select an
   app-server schema contract supported by the configured binary (no Node gate).
2. Add **only** `"hostingControlPath": "/home/isp/conf/cyf-agent-runtime-v1/unified.hosting.json"`
   to the existing `unified.host.json`; retain `agents/configVersion/hostId/stateRoot`.
   Static Agents stay outside the managed journal and remain installation-authorized.
3. Install the reviewed tmpfiles example as
   `/etc/tmpfiles.d/cyf-agent-runtime-v1-hosting.conf`. The example uses `root:isp`;
   verify the actual trusted group before applying it. Normal boot tmpfiles setup
   recreates `/run/cyf-agent-runtime-v1/unified` as **root:isp 0750**. Persistent
   `/home/isp/state/cyf-agent-runtime-v1-managed/unified` is **root:root 0700**. Applying
   tmpfiles for initial installation requires separate explicit release authority;
   the installer never invokes `systemd-tmpfiles` or changes those directories.
   Service sources order after `systemd-tmpfiles-setup.service`. Existing unknown
   files/listeners/writer locks are never removed or adopted.
4. Configure the exact API/Runtime pair together:
   - Runtime `socketPath`: `/run/cyf-agent-runtime-v1/unified/control.sock`.
   - API `agent.hosting-rent.managed.socket-path`: same path, fixed by the selected API configuration.
   - Runtime `socketGid: 1000` ↔ API
     **`agent.hosting-rent.managed.socket-group-gid=1000`** for trusted `isp`.
   - API runner UID **0** for the root Runtime. Socket is **root:isp 0660**;
     parent accepts only **0710/0750**, same configured group, never group write or
     world access. Runtime uses filesystem group admission + exact scope; any group
     member is a trusted control caller. Do not grant that group to untrusted users.
5. Validate with the artifact-local Node `agent-runtime.mjs validate --config ...`
   and `runtime/validate.sh` before authorized service activation. Validation is
   read-only; it does not make enrollment/registration/provider readiness claims.
   Subsequent subject add/reprovision uses this SAME process, not a service restart.

### Exact local schema

Hosting config requires exactly `configVersion:1`, `socketPath` (canonical UDS
path), `socketGid` (nonnegative integer trusted group), `managedRoot` (canonical,
operator-created owned 0700 root disjoint from host/static Agent roots), `scopes`
(nonempty exact triples `tenantId/clientId/ownerJiacn`), `enrollmentTtlMs` (positive
safe integer, native enrollment expiry only), and `template`.

`template` has exactly `profile`, `codexConfig` (explicit TOML string), and
`modelAuth: {"auth_mode":"apikey","OPENAI_API_KEY":"operator-provided-secret"}`.
Managed profile fields remain `MANAGED_PROFILE_FIELDS`; request input cannot
supply credentials, HOME, identity or commands. Runtime derives each independent
subject HOME and atomically materializes BOTH config.toml and auth.json (0600).
Existing files must match the frozen template; conflicting files are not overwritten.

`codexConfig` selects exactly one HTTPS custom Provider, `wire_api="responses"`,
`requires_openai_auth=true`, and top-level `cli_auth_credentials_store="file"`.
No `env_key`, `providerEnvironment`, headers or alternate authentication are accepted.
`preferred_auth_method` is not supported and must not be generated. Ordinary and
native Provider bindings must agree when native metadata is supplied; new modern
CHAT enrollment still requires complete native metadata. Historical inactive
subjects lacking that metadata are not activated or repaired by credential migration.

All model execution consumes this subject's auth.json, never host environment or
another subject's credentials. Ordinary processes retain the source file; isolated
execution stages a private copy and removes only that copy after initialization.
The operator baseline includes config/auth so stopped private-HOME cleanup and
readmission can rebuild them without retaining old-owner secrets. Other skill
provider environments and Runtime identity credentials are separate and unchanged.
No key rotation or runtime legacy-schema fallback is provided. Existing templates,
journals, targets and operator baselines must be migrated offline together using
`tools/migrate-model-auth.mjs` under the authorized installer's release lock with
writers stopped. Its plan prints paths only; private backups contain secrets.

The initial template snapshot is private and durable per subject. Existing
subject profile/config must match the journal; edits/credential rotation require
an explicitly scoped operator workflow, not another request-supplied profile.
No rotation/automatic auth repair API is supplied in this task.

### API installation handoff and recovery

Prepare persists association + installation/manifest + one-time secret **before**
returning PREPARED. Only manifest and bare SHA256 metadata go to API. API ensures
and links that exact installation in its own transaction, then sends ensure.
Prepare/observe never enroll or activate. Ensure records admission before native
enroll/session/WS registration. Replayed operation association must be identical.
Free reprovision keeps installation/manifest/authorization and enrollment expiry;
its new monotonically allocated provision generation gets a fresh native session.
No reenrollment or full service restart occurs in the normal free-reprovision path.

The private enrollment-attempt marker remains authoritative after a lost enroll
reply or failed authorization write: **RECOVERY_REQUIRED**, never automatic secret
retry, generic FAILED_NO_EFFECT, refund proof or automatic repair delivered.
An operator must reconcile the precise installation under a separate authorized
workflow. Journal loss/unsafe state/unknown writer locks fail closed. Admitted
subjects reload after a clean restart and request a fresh session; prepared-only
candidates stay dormant. Persisted readiness is never trusted: observe requires
this process/operation, current generation, fresh exact registered ACK, current
executor readiness and actual durable health. Revocation/reconnect removes proof.

## Selfcheck evidence boundary

Frozen synthetic fixture source:
`/home/isp/wsps/cyf/docs/implementation/fixtures/gss-hosting-control-v1.json`,
SHA256 `5c4b833e6db5bab3122c6dee17ef49198462aee3c3edf58f628ed8571e241403`.
Copied unchanged under `test/fixtures/`. Selectors `hosting-control.test.mjs` and
`hosting-lifecycle.test.mjs` are local synthetic/native/socket mocks, plus actual
mature-engine state/child environment and local Unix cross-identity permission
checks. They are **not** actual provider, server installation, production GSS
registration/rent settlement, free-reprovision business acceptance or release proof.
`test/hosting-java-bridge-fixture.mjs` starts the actual controller/UDS with
synthetic native/executor mocks and prints one metadata JSON line; keep stdin
open and send `stop` or EOF to clean up. Clock is fixed at 2026-10-10 09:00 CST;
free reprovision `requestedAt=reservedAt` yields expected mock sessions 1/2.
Use this as the Java peer's local integration boundary, not production proof.

Crash recovery is not automatic: stopped-writer repair of a retained ownership
lock or unknown/stale socket requires separate explicit operator reconciliation.
Neither startup nor tmpfiles deletes an existing unknown file/listener/lock.
Clean shutdown releases owned locks and its socket; reboot recreates the `/run`
parent, while persistent private state remains.

Node measured during development: **v20.20.2**. No version gate added.

## Outbound invitation target and one-time pairing

A SETUP grant now permits `hosting.target` in addition to capabilities/inventory.
The target request is an M envelope with only tenantId/clientId/ownerJiacn/canonicalAgentId in data.
Its result echoes these and reports hostId/outcome=TARGET_READY. This is directory preparation,
NOT an installation, enrollment, service-ready proof or a payment event. Target metadata and
model-only template are saved before filesystem creation; unrelated orphan roots are refused.
Inventory uses the actual catalog observer in that private target, including installed disabled skills.

### One-time host registration (1.3.108 candidate, not deployed)

Generate a single host credential on the target machine, not per invitation:

```sh
node "$REPO/shell/cyf_runtime_hosting_setup.mjs" prepare --host-id HOST_ID --output /absolute/private/NEW_DIRECTORY
# Submit only request.json (hostId/tokenSha256) to the host registration UI.
# Managed hosts use controlled maintenance, never an end-user pairing prompt.
# Save returned public host metadata as host.json with mode 0600 and verify its ownership.
node "$REPO/shell/cyf_runtime_hosting_setup.mjs" attach --pending /absolute/private/NEW_DIRECTORY/pending.json --host /absolute/private/host.json --credentials /absolute/private/host-credential.json
```

Configure `outbound.credentialsPath` to that confirmed file. It contains
`{configVersion:1,host:{hostId,mode,tenantId,clientId,ownerJiacn,tokenSha256},token}`.
The local confirmation checks the token hash, host identity, deployment mode and
owner. The file is outside all Agent-mutable roots and never enters a sandbox.
Do not upload pending.json or the confirmed credential file. Rotation is controlled
maintenance, not automatic re-registration. Public metadata must match API responses.

The supervisor GETs `/agent/runtime/v1/hosting/authorizations` using the host token,
scans all cursor pages before removing workers, and hot-adds independent in-process
workers. Each uses the original single-command exchange/ACK protocol. One invitation
keeps the same authorizationId when API atomically changes SETUP to CONTROL with
reserve; there is no second token, child worker or controlAuthorization response.
API alone admits business methods; Runtime checks the exact authenticated Agent
context against each command. UDS callers cannot supply this internal context.

Host 401 pauses all management, not business execution or rent. Grant 403 quarantines
only that worker; rescanning the directory does not resume unknown/failed execution.
Temporary directory errors do not delete workers or delay existing business startup.
Revoked grants retain journals; retained facts do not authorize new management work.

Unmigrated existing relationships still use their explicitly configured legacy
adapter. A mapped outbound relationship never falls back on failure or revocation.
Import requires fixed original binding/lease/installation and operator reconciliation
of existing journals/queues, without fake setup history or command replay.
