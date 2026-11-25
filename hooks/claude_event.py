#!/usr/bin/env python3
"""Claude Code lifecycle hook: local audit records plus an opt-in Stop completion guard.

Fail-open by design: any missing file, unreadable state, or absent validator
results in exit 0 (allow). The hook can only block a Stop when ALL of these
are true: an active workflow exists, that workflow set enforce_stop=true at
init (--enforce-stop), the validator script exists, and validation fails.

That cascade used to live inline in `main` as nine separate `return 0`s, which
is what a fail-open contract looks like when it is written once per condition.
It is one contract, so it is one function per question now — each answering
"allow" for everything it cannot read. test_claude_event.py covers both halves,
the blocking one included; before it, only the no-state case was tested.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
# Fixed argv lists only, never shell=True, no event data in any argument.
# Triage: docs/security/scanner-triage.md#bandit
import subprocess  # nosec B404
import sys
from datetime import datetime, timezone
from pathlib import Path

AGENTIC = ".agentic"
# "abandoned" releases the guard exactly like "completed" does. Only
# `workflow.py close` writes either, and it will not write "completed" over a
# missing handoff -- so an operator who must end the session leaves an honest
# record instead of hand-editing the status, which is what used to happen.
RELEASED_STATUSES = ("completed", "abandoned")


def resolve_root(event: dict) -> Path:
    """Resolve the repository root in the same order as tooling/workflow.py, so the
    hook and the validator can never disagree about where .agentic/ lives.
    CLAUDE_PROJECT_DIR beats cwd: a session started in a subdirectory must not
    audit into that subdirectory and then fail open on a state file it cannot see.
    """
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return Path(env).resolve()
    git = shutil.which("git")
    try:
        if git is None:
            raise OSError("git is not on PATH")
        # Absolute git from shutil.which and a constant argv: nothing untrusted.
        proc = subprocess.run(  # nosec B603
            [git, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return Path(proc.stdout.strip()).resolve()
    except (OSError, subprocess.TimeoutExpired):
        # No git on PATH, not a repository, or git hung past the timeout. Fall
        # through to the event cwd: resolving a root must never raise, because
        # this hook runs on every session start and stop.
        pass
    cwd = event.get("cwd")
    return Path(cwd).resolve() if cwd else Path.cwd().resolve()


def read_event() -> dict:
    """The event on stdin. Unparseable input is RECORDED, not dropped: a hook
    that silently discards what it could not read leaves nothing to debug."""
    raw = sys.stdin.read()
    try:
        return json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return {"raw_input_invalid": True, "raw_input": raw[:1000]}


def audit(root: Path, event_argument: str, event: dict) -> None:
    """Append one local record. Best-effort: never break the session over a log line."""
    try:
        directory = root / AGENTIC / "audit"
        directory.mkdir(parents=True, exist_ok=True)
        record = {
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "event_argument": event_argument,
            "event": event,
        }
        with (directory / "claude-events.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError as error:
        # Never fatal: a lost log line must not break the session. Said on
        # stderr, which the harness shows without treating it as a decision
        # (stdout is the Stop hook's decision channel), so a silently missing
        # audit trail cannot happen either (CodeQL py/empty-except, #363).
        print(f"claude_event: audit record not written: {error}", file=sys.stderr)


def armed_workflow_id(root: Path) -> str | None:
    """The workflow whose Stop guard is armed, or None.

    Every absent, unreadable or released thing answers None. That is the
    fail-open contract in one place: this function can only say "yes, block on
    this one" when the state file exists, parses, opted in, and is still open.
    """
    active = root / AGENTIC / "active-workflow.json"
    if not active.is_file():
        return None
    try:
        workflow_id = json.loads(active.read_text(encoding="utf-8"))["workflow_id"]
        state_path = root / AGENTIC / "workflows" / workflow_id / "WORKFLOW.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, KeyError, json.JSONDecodeError):
        return None
    if not state.get("enforce_stop", False) or state.get("status") in RELEASED_STATUSES:
        return None
    return workflow_id


# The validator is three files since #1845: workflow.py, the command this hook
# runs, imports the other two from its own directory. All three must be there
# for the answer to mean anything; a partial install is a broken install, and
# like a missing one it never traps the session.
VALIDATOR_FILES = ("workflow.py", "workflow_state.py", "workflow_agents.py")


def validation_fails(root: Path, workflow_id: str) -> bool:
    """Whether the repository's own validator reports the workflow incomplete.

    Only a clean non-zero exit is a failure. A missing, mislocated or hung
    validator answers False, because none of those is evidence that the
    operator's work is unfinished -- and a hook that trapped the session on its
    own broken install would be worse than no guard.
    """
    validator = root / "tooling" / "workflow.py"
    if not all((root / "tooling" / name).is_file() for name in VALIDATOR_FILES):
        return False
    try:
        # The running interpreter on the repository's own validator; workflow_id
        # is one argv element (no shell), read from the repository's state file.
        result = subprocess.run(  # nosec B603
            [sys.executable, str(validator), "--root", str(root),
             "validate", "--workflow", workflow_id, "--check"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode != 0


def block_decision(workflow_id: str) -> dict:
    """Refusing a Stop has to come with the way out, or it is just a wall."""
    return {
        "decision": "block",
        "reason": (
            f"Workflow {workflow_id} is not complete. Run the outstanding subagents, then "
            f"'python tooling/workflow.py validate --workflow {workflow_id}'. To end the "
            f"session without them, close it on the record: 'python tooling/workflow.py "
            f"close --workflow {workflow_id} --reason <why> --abandon'."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", required=True)
    args = parser.parse_args()
    event = read_event()
    root = resolve_root(event)
    # Every event is recorded, including one that goes on to block.
    audit(root, args.event, event)
    # stop_hook_active means this hook already blocked once this turn; blocking
    # again would trap the session in a loop.
    if args.event == "Stop" and not event.get("stop_hook_active"):
        workflow_id = armed_workflow_id(root)
        if workflow_id and validation_fails(root, workflow_id):
            print(json.dumps(block_decision(workflow_id)))
    # The decision is carried by the JSON on stdout. A non-zero exit would read
    # to Claude Code as a broken hook rather than as a refusal.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
