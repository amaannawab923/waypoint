"""F9 (tech-lead review, 2026-09-22) test fixture: a fake jev_ultrafast.agent.Agent
that runner.daemonCleanup.test.ts puts on PYTHONPATH ahead of the pinned
venv, so runner.py's real `run()` — including its `with Agent(...) as
agent:` block and the `finally: restart_daemon()` around it — executes
against something this repo controls, no real Browser Use decision model,
Chromium, or browser-harness daemon involved.

Shaped to match exactly what runner.py reads off a real Agent/Browser:
`.state` (decisions/text_calls/history/status), `.run()` yielding step
state dicts, `.browser.observe(screenshot=True)`, and the context-manager
protocol `Agent.close()` uses in the real package (jev_ultrafast/agent.py's
own `__enter__`/`__exit__`).

FAKE_AGENT_RAISE=1 makes `run()` raise partway through the walk, standing
in for a jev-ultrafast/browser-harness failure mid-task — the path this
fixture exists to prove `restart_daemon()` still runs for (a `finally`,
not a success-only cleanup).
"""

import os


class _FakeBrowser:
    def observe(self, screenshot=True):
        # No `screenshot` key: runner.py's `final_page.get("screenshot")`
        # then reads None and skips writing a final frame — exactly like a
        # real observe() that failed, which runner.py already tolerates.
        return {}


class Agent:
    def __init__(self, url, goal, record_dir=None, screenshots=False):
        self.url = url
        self.goal = goal
        self.record_dir = record_dir
        self.browser = _FakeBrowser()
        self.state = {
            "status": "done",
            "decisions": [{"latency_ms": 10}],
            "text_calls": [{"latency_ms": 5}],
            "history": [
                {
                    "step": 1,
                    "action": "Click Go",
                    "kind": "click",
                    "operation": "click",
                    "target": "Go",
                    "text": None,
                    "confidence": 0.9,
                    "latency_ms": 10,
                    "page_changed": True,
                }
            ],
        }

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False  # never swallows — same as the real Agent

    def close(self):
        pass

    def run(self):
        if os.environ.get("FAKE_AGENT_RAISE") == "1":
            yield {"history": [], "elapsed_ms": 0, "status": "ready"}
            raise RuntimeError("fake walk failure (FAKE_AGENT_RAISE)")
        yield {
            "history": self.state["history"],
            "elapsed_ms": 10,
            "status": "done",
        }
