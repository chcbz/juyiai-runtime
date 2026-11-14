"""Pinned source regression and opt-in, credential-free real Codex startup.

CODEX_UPSTREAM_SOURCE_ROOT supplies the unmodified pinned upstream checkout.
CYF_CODEX_TEST_BINARY supplies the built candidate's absolute executable path.
Neither test installs anything or executes a model turn / sandbox command.
"""
import hashlib
import json
import os
from pathlib import Path
import selectors
import shlex
import signal
import subprocess
import tempfile
import time
import unittest

PATCH_ROOT = Path(__file__).resolve().parents[1] / 'patches/codex/0.167.0'
LOCK = json.loads((PATCH_ROOT / 'source-lock.json').read_text())
PATCH = PATCH_ROOT / LOCK['patch']
SOURCE_ROOT = os.environ.get('CODEX_UPSTREAM_SOURCE_ROOT')
BINARY = os.environ.get('CYF_CODEX_TEST_BINARY')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class PatchIdentityTest(unittest.TestCase):
    def test_patch_matches_locked_digest_and_only_changes_startup(self):
        self.assertEqual(sha256(PATCH.read_bytes()), LOCK['patchSha256'])
        changes = subprocess.check_output(['git', 'apply', '--numstat', str(PATCH)], text=True)
        self.assertEqual(changes.strip(), '2\t11\tcodex-rs/app-server/src/lib.rs')
        self.assertEqual(LOCK['upstreamCommit'], '086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a')


@unittest.skipUnless(SOURCE_ROOT, 'explicit pinned upstream source required')
class UpstreamSourceTest(unittest.TestCase):
    def test_exact_patch_applies_without_changing_other_startup_logic(self):
        # Never modify the supplied checkout (including production or shared source).
        with tempfile.TemporaryDirectory(prefix='codex-source-test-') as temporary:
            root = Path(temporary)
            for name, identity in LOCK['files'].items():
                original = (Path(SOURCE_ROOT) / name).read_bytes()
                self.assertEqual(sha256(original), identity['beforeSha256'])
                destination = root / name
                destination.parent.mkdir(parents=True)
                destination.write_bytes(original)
            subprocess.run(['git', 'apply', '--check', str(PATCH)], cwd=root, check=True)
            subprocess.run(['git', 'apply', str(PATCH)], cwd=root, check=True)
            for name, identity in LOCK['files'].items():
                candidate = (root / name).read_bytes()
                self.assertEqual(sha256(candidate), identity['afterSha256'])
                self.assertNotIn(b'codex_core::config::system_bwrap_warning(', candidate)
                for unchanged in (b'check_execpolicy_for_warnings', b'project_config_warning',
                                  b'config.startup_warnings', b'SQLITE_RECOVERY_CONFIG_WARNING_SUMMARY'):
                    self.assertIn(unchanged, candidate)


@unittest.skipUnless(BINARY, 'built candidate binary required; source checks are not runtime acceptance')
class RealAppServerStartupTest(unittest.TestCase):
    def test_initialize_does_not_launch_bwrap_warning_probe(self):
        binary = Path(BINARY)
        self.assertTrue(binary.is_absolute() and binary.is_file())
        with tempfile.TemporaryDirectory(prefix='codex-startup-test-') as temporary:
            root = Path(temporary)
            home, bins, work = root / 'home', root / 'bin', root / 'work'
            home.mkdir(mode=0o700)
            bins.mkdir(mode=0o700)
            work.mkdir(mode=0o700)
            marker = root / 'bwrap-invocations.txt'
            # This test double never calls real bwrap or performs mounts. An old
            # binary is expected to fail the assertion, not wedge on host mounts.
            stub = bins / 'bwrap'
            stub.write_text('#!/bin/sh\nprintf "%s\\n" "$@" >> '
                            + shlex.quote(str(marker)) + '\nexit 1\n')
            stub.chmod(0o700)
            (home / 'config.toml').write_text(
                'approval_policy = "never"\nsandbox_mode = "read-only"\n'
                'web_search = "disabled"\n[analytics]\nenabled = false\n')
            env = {'PATH': str(bins), 'HOME': str(home),
                   'CODEX_HOME': str(home), 'LANG': 'C.UTF-8',
                   'XDG_CONFIG_HOME': str(home), 'XDG_CACHE_HOME': str(root / 'cache')}
            with (root / 'stderr.log').open('wb') as stderr:
                child = subprocess.Popen([str(binary), 'app-server'], cwd=work, env=env,
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=stderr, start_new_session=True)
                try:
                    child.stdin.write(json.dumps({'id': 1, 'method': 'initialize', 'params': {
                        'clientInfo': {'name': 'cyf-startup-regression', 'version': '1'}}}).encode() + b'\n')
                    child.stdin.flush()
                    response, pending = None, b''
                    deadline = time.monotonic() + 20
                    with selectors.DefaultSelector() as selector:
                        selector.register(child.stdout, selectors.EVENT_READ)
                        while response is None and time.monotonic() < deadline:
                            if not selector.select(max(0, deadline - time.monotonic())):
                                break
                            chunk = os.read(child.stdout.fileno(), 65536)
                            if not chunk:
                                break
                            pending += chunk
                            self.assertLess(len(pending), 1024 * 1024)
                            while b'\n' in pending:
                                line, pending = pending.split(b'\n', 1)
                                frame = json.loads(line)
                                if frame.get('id') == 1:
                                    response = frame
                    self.assertIsNotNone(response, 'app-server did not initialize within 20 seconds')
                    self.assertNotIn('error', response)
                    self.assertIn('result', response)
                    self.assertFalse(marker.exists(), 'startup still launched bwrap: ' +
                                     (marker.read_text() if marker.exists() else ''))
                finally:
                    # Signal only the private test process group, never a service.
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        try:
                            os.killpg(child.pid, sig)
                        except ProcessLookupError:
                            pass
                        try:
                            child.communicate(timeout=3)
                            break
                        except subprocess.TimeoutExpired:
                            continue
                    if child.poll() is None:
                        raise RuntimeError('owned startup fixture did not exit')


if __name__ == '__main__':
    unittest.main()
