"""F9 (tech-lead review, 2026-09-22) test fixture: a fake
browser_harness.admin.restart_daemon — the exact call runner.py's `run()`
now makes in a `finally` around its walk (see runner.py's own comment on
why `restart_daemon()`, despite the name, is the right shutdown call).

Real `restart_daemon()` sends `{"meta": "shutdown"}` to a real daemon over
its IPC socket; this fixture has no daemon to shut down, so it just
records that it was called — appending one JSON record per call to the
file named by FAKE_RESTART_DAEMON_MARKER — so
runner.daemonCleanup.test.ts can assert it ran exactly once per runner.py
invocation, on both the success path and the FAKE_AGENT_RAISE failure
path.
"""

import json
import os


def restart_daemon(name=None, require_clean=False):
    marker = os.environ.get("FAKE_RESTART_DAEMON_MARKER")
    if not marker:
        return
    calls = []
    if os.path.exists(marker):
        try:
            with open(marker) as f:
                calls = json.load(f)
        except (OSError, ValueError):
            calls = []
    calls.append({"name": name, "requireClean": require_clean})
    with open(marker, "w") as f:
        json.dump(calls, f)
