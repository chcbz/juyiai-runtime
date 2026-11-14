# Codex app-server startup: remove the diagnostic mount probe

Status: source patch, **not a built or installed Codex release**.

## Scope and reason

`source-lock.json` pins upstream Codex 0.167.0, its full commit, original/patched
file hashes and patch hash. The patch removes only the app-server startup call
to `system_bwrap_warning`. That call builds a warning notification, not an
execution authorization or readiness decision. Its full-root read-only mount
probe unnecessarily touches unrelated host mounts. Its 500ms timeout subsequently
calls blocking `wait()`, so a stuck kernel mount can still block startup.

Other startup warnings stay intact. App-server no longer emits this specific
warning about missing bubblewrap / WSL1 / user-namespace access. Actual sandbox
execution and failures, permissions, network isolation, Runtime readiness and
Runtime's outer sandbox checks are unchanged. CLI/exec warning call sites are
also unchanged: this patch is specifically for Runtime's app-server startup.
Do not change permissions, hide bubblewrap through PATH, fake a successful probe,
or replace actual sandbox checks with this startup test.

## Source verification and build

Use a dedicated **ordinary-disk** upstream checkout at the exact locked commit;
never patch the global Codex installation or bytes in an installed executable.

1. Verify `git rev-parse HEAD` equals `source-lock.json.upstreamCommit`, with no
   pre-existing changes. Run the source tests below against that clean checkout.
2. Apply the pinned patch with `git apply --check` followed by `git apply`.
   The only changed file must be `codex-rs/app-server/src/lib.rs`; verify its
   `afterSha256`. Record the resulting full source tree and patch SHA-256.
3. Use upstream's pinned Rust toolchain and locked Cargo dependencies to build
   the `codex` CLI executable, including app-server, for the actual target.
   No binary surgery, empty-success wrapper, global npm replacement or fabricated
   upstream release identity is permitted. Publish a Runtime-private patched
   dependency with its real build identity, executable hash and resource closure.
4. Run the startup regression against that built candidate and the existing
   actual sandbox failure/read-only/network regressions. Source patch tests
   alone do not establish compiled behavior or sandbox safety.
5. Use the existing controlled installation path, locking, backup, executable
   measurement and profile-specific `codexBin` configuration. Update affected
   measurement/carrier evidence from real runs, never by rewriting old hashes.
   Keep the global Codex distribution unchanged. Do not switch binaries while
   the Runtime's old process group has not exited.

Do not start a build when disk/toolchain prerequisites cannot be met. Follow the
repository's 600-second build limit; request an exception before exceeding it.
A new executable cannot release already-blocked kernel processes.

## Tests

Use Python 3.11 and a private ordinary-disk `TMPDIR`. Tests do not modify the
provided source or binary, read credentials, call a model, or mount filesystems.
The fake `bwrap` exists **only in the test child's PATH** and records invocation.
It must never be used in production. Testing the original upstream executable
must fail with its actual probe arguments; this is the negative control.

```sh
CODEX_UPSTREAM_SOURCE_ROOT=/absolute/path/to/pristine/codex-checkout \
  python3.11 -m unittest discover -s tests -p test_codex_startup_probe.py -v

CODEX_UPSTREAM_SOURCE_ROOT=/absolute/path/to/pristine/codex-checkout \
CYF_CODEX_TEST_BINARY=/absolute/path/to/built/patched/codex \
  python3.11 -m unittest discover -s tests -p test_codex_startup_probe.py -v
```

Absent source/binary inputs are explicit skips, never PASS. The startup test
verifies the real initialize exchange and absence of the diagnostic subprocess;
it intentionally does not execute a tool and is not a sandbox isolation test.
