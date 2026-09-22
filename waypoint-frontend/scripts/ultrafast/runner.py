"""Ultrafast browser tasks — the runner spawned by ultrafast-mcp.js.

Drives one jev-ultrafast (browser-use/jev-ultrafast, MIT, pinned commit
1231850a0bf1a0c0341fe408ef1668dbbfdfac46 — see
../src/main/engine/runs/ultrafast/pythonEnv.ts) task end to end: reads a
single JSON request from stdin, streams one JSON line per step to stdout
so the MCP server (and, through it, the session's transcript) can show
progress live the way the standalone demo driver (flights.py) printed to
a terminal, then emits one JSON "result" line and exits.

Deliberately a thin driver, not a reimplementation: every decision is
jev's; this only shapes what jev already computes into the wire format
the Node side expects, and takes the one extra screenshot jev's own loop
never takes on its own (see the comment above `final_screenshot` below).

Talks JSON lines, never anything richer, so the parent's stdout parser
stays a plain readline().

Usage:
    python runner.py            # reads one request line from stdin
    python runner.py --selftest # imports both packages and exits 0
"""

import base64
import json
import sys
import time
from pathlib import Path

DEFAULT_MAX_STEPS = 20


def emit(payload):
    """One JSON line to stdout, flushed immediately — the parent reads
    this with a line-buffered pipe and must see each step as it happens,
    not batched behind Python's own stdout buffering."""
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def selftest():
    # Confirms the venv actually has both packages importable — the thing
    # `ultrafast:test` in the settings page runs before ever trying a real
    # task, so a broken install is reported as "not available", not as a
    # task that mysteriously fails.
    import jev_ultrafast.agent  # noqa: F401
    import browser_harness  # noqa: F401
    print("ok")
    return 0


def read_request():
    line = sys.stdin.readline()
    if not line.strip():
        raise ValueError("No request on stdin.")
    request = json.loads(line)
    for key in ("url", "goal"):
        if not isinstance(request.get(key), str) or not request[key].strip():
            raise ValueError(f"Request is missing required field: {key}")
    return request


def save_frame(record_dir: Path, name: str, screenshot_b64: str) -> str:
    record_dir.mkdir(parents=True, exist_ok=True)
    frame_path = record_dir / name
    frame_path.write_bytes(base64.b64decode(screenshot_b64))
    return str(frame_path)


def run(request):
    from jev_ultrafast.agent import Agent
    from browser_harness.admin import restart_daemon

    url = request["url"]
    goal = request["goal"]
    max_steps = request.get("maxSteps") or DEFAULT_MAX_STEPS
    record_dir = Path(request["recordDir"]) if request.get("recordDir") else None

    screenshots = []
    jev_decisions = 0
    text_calls = 0
    started = time.perf_counter()

    # F9 (tech-lead review, 2026-09-22): `Browser.__init__`
    # (jev_ultrafast/browser.py) calls `ensure_daemon()`, which spawns a
    # `browser_harness.daemon` process detached from this one
    # (`start_new_session=True` — it reparents to init, not to us) to own
    # the CDP connection. `Agent.close()`/`Browser.close()` (invoked by
    # this `with` block's own `__exit__`) only closes the CDP *target*
    # that daemon created; the daemon itself is never told to stop, so it
    # outlives this process forever, still holding TYPESAFE_API_KEY (and
    # everything else in buildRunnerEnv) in its own environment. Each task
    # gets a fresh BH_RUNTIME_DIR (ultrafast-mcp.js's buildRunnerEnv
    # mkdtemp's one per call), so each task's `ensure_daemon()` spawns a
    # genuinely distinct daemon process under that runtime dir rather than
    # reusing a shared one — meaning every browser_task call before this
    # fix leaked one (four were found still alive on the reviewer's own
    # machine from four runs).
    #
    # `restart_daemon()` (despite the name — see its own docstring: "Name
    # is historical… The function itself only stops") is the exact
    # best-effort shutdown browser-harness's own `stop_remote_daemon()`
    # and `--reload` paths use: it sends `{"meta": "shutdown"}` over the
    # daemon's IPC socket and SIGTERMs if that doesn't land. Called with
    # no args, it targets `BU_NAME` (unset here, so "default") under
    # whatever BH_RUNTIME_DIR is current in THIS process's env — exactly
    # the daemon this task's own `ensure_daemon()` call spawned via
    # `Agent`/`Browser` above. A `finally` around the whole walk: this
    # must run whether the walk finished, raised, or the max-steps cap
    # broke out early. A daemon that never came up (`Agent()` raised
    # before `ensure_daemon()` finished) or already exited is not an
    # error here — this is cleanup, not part of the task's own result, so
    # any failure is swallowed.
    try:
        with Agent(url, goal, record_dir=record_dir, screenshots=True) as agent:
            # The very first frame (000000.jpg), taken by Agent's own
            # constructor before this loop runs at all.
            if record_dir:
                first = record_dir / "000000.jpg"
                if first.exists():
                    screenshots.append(str(first))

            for state in agent.run():
                history = state.get("history") or []
                step = history[-1] if history else {}
                emit(
                    {
                        "type": "step",
                        "elapsedMs": state.get("elapsed_ms", 0),
                        "status": state.get("status"),
                        "operation": step.get("operation"),
                        "target": step.get("target"),
                        "action": step.get("action"),
                        "text": step.get("text"),
                        "confidence": step.get("confidence"),
                        "jevMs": step.get("latency_ms"),
                    }
                )
                if record_dir:
                    frame = record_dir / f"{state.get('elapsed_ms', 0):06d}.jpg"
                    if frame.exists():
                        screenshots.append(str(frame))
                if len(history) >= max_steps and state.get("status") not in ("done", "blocked"):
                    # Our own cap, independent of jev-ultrafast's internal
                    # MAX_STEPS/model-call budget (questions.py) — a caller may
                    # ask for fewer steps than that budget allows, and this is
                    # the only place that honors it.
                    break

            final_state = agent.state

            # jev's own record_dir only ever holds a frame taken BEFORE the
            # action that produced `done`/`blocked` — there is never a frame of
            # what the page looks like once the walk is actually finished. One
            # more screenshot here, taken after the loop and before the browser
            # closes, is what lets a person (or Claude, reading the MCP
            # response) actually see the outcome rather than the second-to-last
            # step.
            try:
                final_page = agent.browser.observe(screenshot=True)
                final_b64 = final_page.get("screenshot")
            except Exception:
                final_b64 = None

            if final_b64 and record_dir:
                screenshots.append(save_frame(record_dir, "999999-final.jpg", final_b64))

            jev_decisions = len(final_state.get("decisions") or [])
            text_calls = len(final_state.get("text_calls") or [])
            # Where the time went (founder, 2026-09-22: "how did Jev perform"):
            # the decision model's own latency and the text model's, summed
            # from what jev-ultrafast records per decision / per text call.
            jev_ms_total = sum(
                int(d.get("latency_ms") or 0) for d in (final_state.get("decisions") or [])
            )
            text_ms_total = sum(
                int(t.get("latency_ms") or 0) for t in (final_state.get("text_calls") or [])
            )
            status = final_state.get("status", "blocked")
            history_out = [
                {
                    "step": h.get("step"),
                    "action": h.get("action"),
                    "kind": h.get("kind"),
                    "operation": h.get("operation"),
                    "target": h.get("target"),
                    "text": h.get("text"),
                    "confidence": h.get("confidence"),
                    "jevMs": h.get("latency_ms"),
                    "pageChanged": h.get("page_changed"),
                }
                for h in (final_state.get("history") or [])
            ]
    finally:
        try:
            restart_daemon()
        except Exception:
            pass

    emit(
        {
            "type": "result",
            "status": status,
            "steps": len(history_out),
            "elapsedMs": round((time.perf_counter() - started) * 1000),
            "jevDecisions": jev_decisions,
            "textCalls": text_calls,
            "jevMsTotal": jev_ms_total,
            "textMsTotal": text_ms_total,
            "history": history_out,
            "screenshots": screenshots,
            "error": None,
        }
    )


def main():
    if "--selftest" in sys.argv:
        return selftest()
    try:
        request = read_request()
        run(request)
        return 0
    except Exception as error:  # noqa: BLE001 — a task's every failure must
        # still produce one well-formed result line, not a Python traceback
        # the MCP server would have to guess how to parse.
        emit(
            {
                "type": "result",
                "status": "failed",
                "steps": 0,
                "elapsedMs": 0,
                "jevDecisions": 0,
                "textCalls": 0,
                "history": [],
                "screenshots": [],
                "error": str(error),
            }
        )
        return 0


if __name__ == "__main__":
    sys.exit(main())
