#!/usr/bin/env python3
"""
The Stop guard, tested on the path that actually guards something.

CI asserted exactly one thing about this hook: that it exits 0 with no state.
That is the FAIL-OPEN half. The blocking half — an armed workflow with missing
handoffs, where the hook is supposed to refuse the Stop — had no coverage at
all, so a regression there would have been silent in the only direction that
matters: the guard quietly never fires, and the session ends on a workflow
whose audit trail claims work that never ran.

Every case below is one branch of the fail-open cascade in `main`, plus the one
case that is not fail-open. The hook is a CLI, so each runs it as a subprocess
against a throwaway repository root — argv, stdin and exit code included.

    python3 -m unittest discover -s hooks -p 'test_*.py'
"""

import json
import os
import shutil
import subprocess  # nosec B404 - fixed argv, the interpreter on this repo's own hook
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "claude_event.py"
REPO = HOOK.parent.parent
VALIDATOR = REPO / "tooling" / "workflow.py"
# The validator and the two files it imports (#1845); the hook checks the same list.
VALIDATOR_FILES = ("workflow.py", "workflow_state.py", "workflow_agents.py")
REGISTRY = REPO / "tooling" / "agent-registry.yml"

BLOCKED_NODE = {
    "id": "ghost",
    "agent_name": "ghost",
    "required": True,
    "available": False,
    "status": "blocked",
}


def run_hook(root: Path, event_name: str, payload: str = "{}") -> subprocess.CompletedProcess:
    """The hook as the harness runs it: one argv flag, the event on stdin."""
    env = dict(os.environ, CLAUDE_PROJECT_DIR=str(root))
    return subprocess.run(  # nosec B603
        [sys.executable, str(HOOK), "--event", event_name],
        input=payload, capture_output=True, text=True, timeout=60, env=env, cwd=str(root),
    )


def decision(result: subprocess.CompletedProcess) -> dict | None:
    """The block decision the hook printed, or None when it allowed the Stop."""
    out = result.stdout.strip()
    return json.loads(out) if out else None


def audit_records(root: Path) -> list[dict]:
    """Every event the hook appended to the audit log under this root."""
    log = root / ".agentic" / "audit" / "claude-events.jsonl"
    if not log.is_file():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line]


class HookCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="stop-guard-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        # The hook shells out to the repository's own validator, so the tree
        # under test carries a real copy rather than a stub: a change to
        # workflow.py that broke validation would otherwise pass here.
        (self.root / "tooling").mkdir()
        for name in VALIDATOR_FILES:
            shutil.copy(VALIDATOR.parent / name, self.root / "tooling" / name)
        shutil.copy(REGISTRY, self.root / "tooling" / "agent-registry.yml")

    def arm(self, **overrides) -> str:
        """An active workflow with one required, unavailable node — so validation fails."""
        workflow_id = overrides.pop("workflow_id", "wf-test")
        state = {
            "workflow_id": workflow_id,
            "status": "blocked",
            "enforce_stop": True,
            "nodes": [dict(BLOCKED_NODE)],
        }
        state.update(overrides)
        directory = self.root / ".agentic" / "workflows" / workflow_id
        directory.mkdir(parents=True)
        (directory / "WORKFLOW.json").write_text(json.dumps(state), encoding="utf-8")
        (self.root / ".agentic" / "active-workflow.json").write_text(
            json.dumps({"workflow_id": workflow_id, "path": str(directory)}), encoding="utf-8"
        )
        return workflow_id


class TheGuardBlocks(HookCase):
    """The half CI never exercised."""

    def test_an_armed_workflow_with_missing_handoffs_blocks_the_stop(self):
        workflow_id = self.arm()
        result = run_hook(self.root, "Stop")
        blocked = decision(result)
        self.assertIsNotNone(blocked, "the guard allowed a Stop it was armed to refuse")
        self.assertEqual(blocked["decision"], "block")
        # The reason has to name the workflow and the way out, or the operator
        # is told "no" with nothing to do about it.
        self.assertIn(workflow_id, blocked["reason"])
        self.assertIn("--abandon", blocked["reason"])

    def test_it_exits_zero_even_when_it_blocks(self):
        # The decision is carried by the JSON on stdout, not by the exit code.
        # A non-zero exit here would read to Claude Code as a broken hook.
        self.arm()
        self.assertEqual(run_hook(self.root, "Stop").returncode, 0)


class TheGuardFailsOpen(HookCase):
    """Every branch that must let the session end."""

    def test_no_state_at_all(self):
        self.assertIsNone(decision(run_hook(self.root, "Stop")))

    def test_a_workflow_that_did_not_opt_in(self):
        # enforce_stop is opt-in at init (--enforce-stop). Without it the
        # workflow is recorded but never guards anything.
        self.arm(enforce_stop=False)
        self.assertIsNone(decision(run_hook(self.root, "Stop")))

    def test_a_closed_workflow_releases_the_guard(self):
        # "abandoned" releases it exactly like "completed": that is what makes
        # an honest close possible instead of a hand-edited status.
        for status in ("completed", "abandoned"):
            with self.subTest(status=status):
                shutil.rmtree(self.root / ".agentic", ignore_errors=True)
                self.arm(status=status)
                self.assertIsNone(decision(run_hook(self.root, "Stop")))

    def test_a_second_pass_of_the_stop_hook(self):
        # stop_hook_active means we already blocked once this turn; blocking
        # again would trap the session in a loop.
        self.arm()
        payload = json.dumps({"stop_hook_active": True})
        self.assertIsNone(decision(run_hook(self.root, "Stop", payload)))

    def test_an_unreadable_pointer(self):
        self.arm()
        (self.root / ".agentic" / "active-workflow.json").write_text("{not json", encoding="utf-8")
        self.assertIsNone(decision(run_hook(self.root, "Stop")))

    def test_a_pointer_to_a_workflow_that_is_not_there(self):
        self.arm()
        shutil.rmtree(self.root / ".agentic" / "workflows")
        self.assertIsNone(decision(run_hook(self.root, "Stop")))

    def test_a_missing_validator(self):
        # A mislocated install must never trap the session.
        self.arm()
        (self.root / "tooling" / "workflow.py").unlink()
        self.assertIsNone(decision(run_hook(self.root, "Stop")))

    def test_a_validator_missing_one_of_its_files(self):
        # A partial install (a sibling the validator imports is gone) fails
        # open like a missing one, rather than blocking on an ImportError.
        self.arm()
        (self.root / "tooling" / "workflow_state.py").unlink()
        self.assertIsNone(decision(run_hook(self.root, "Stop")))

    def test_the_hook_and_this_test_name_the_same_validator_files(self):
        hook = HOOK.read_text(encoding="utf-8")
        self.assertIn(f"VALIDATOR_FILES = {VALIDATOR_FILES!r}".replace("'", '"'), hook)
        for name in VALIDATOR_FILES:
            self.assertTrue((VALIDATOR.parent / name).is_file(), name)

    def test_any_event_that_is_not_stop(self):
        self.arm()
        self.assertIsNone(decision(run_hook(self.root, "SessionStart")))


class TheAuditRecord(HookCase):
    def test_every_event_is_recorded_including_one_that_blocks(self):
        self.arm()
        run_hook(self.root, "Stop", json.dumps({"session_id": "abc"}))
        records = audit_records(self.root)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["event_argument"], "Stop")
        self.assertEqual(records[0]["event"]["session_id"], "abc")

    def test_unparseable_stdin_is_recorded_rather_than_dropped(self):
        result = run_hook(self.root, "SessionStart", "this is not json")
        self.assertEqual(result.returncode, 0)
        records = audit_records(self.root)
        self.assertTrue(records[0]["event"]["raw_input_invalid"])
        self.assertIn("not json", records[0]["event"]["raw_input"])

    def test_an_unwritable_audit_directory_never_breaks_the_session(self):
        # Auditing is best-effort. A read-only checkout must still allow Stop.
        self.arm(enforce_stop=False)
        (self.root / ".agentic" / "audit").write_text("not a directory", encoding="utf-8")
        result = run_hook(self.root, "Stop")
        self.assertEqual(result.returncode, 0)
        self.assertIsNone(decision(result))
        # ...and the lost record is said, on stderr, not swallowed.
        self.assertIn("audit record not written", result.stderr)


if __name__ == "__main__":
    unittest.main()
