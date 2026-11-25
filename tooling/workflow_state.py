#!/usr/bin/env python3
"""The workflow tool's state: where .agentic/ keeps it, how a workflow is
found, and how each node is scored against its handoff.

One of the three files of the workflow tool (#1845 split tooling/workflow.py
by job): workflow.py is the command line and imports workflow_state.py and
workflow_agents.py from its own directory. hooks/claude_event.py runs
workflow.py and checks that all three are present (VALIDATOR_FILES).
"""

from __future__ import annotations

import json
import os
import re
import shutil
# One fixed argv (git rev-parse), never shell=True.
# Triage: docs/security/scanner-triage.md#bandit
import subprocess  # nosec B404
import sys
from datetime import datetime, timezone
from pathlib import Path

# A workflow in one of these states no longer holds the Stop guard. Nothing but
# close() may put a workflow here, and close() will not write "completed" over
# missing handoffs -- an operator with no exit was the reason WORKFLOW.json got
# hand-edited into "completed" while its own validation still listed 11 errors.
TERMINAL_STATUSES = ("completed", "abandoned")

# A node whose agent is absent and not required. Written by init and by
# evaluate_workflow, read by close to decide "empty" -- three functions that
# have to agree on the spelling, which is why it is named rather than typed
# four times.
STATUS_SKIPPED = "skipped_optional"

# The state tree. These four are the only places that know its shape: the file
# names were repeated at every call site, so a rename could be applied to the
# write and missed on the read, and the tool would report "workflow not found"
# against a workflow it had just created.
AGENTIC = ".agentic"
STATE_FILE = "WORKFLOW.json"
ACTIVE_POINTER = "active-workflow.json"


def agentic_dir(root: Path) -> Path:
    return root / AGENTIC


def workflow_dir(root: Path, workflow_id: str) -> Path:
    return agentic_dir(root) / "workflows" / workflow_id


def state_file(root: Path, workflow_id: str) -> Path:
    return workflow_dir(root, workflow_id) / STATE_FILE


def active_pointer(root: Path) -> Path:
    return agentic_dir(root) / ACTIVE_POINTER


def workflow_not_found(workflow_id: str) -> int:
    """The same answer from validate, close and status, in one place."""
    print(f"workflow not found: {workflow_id}", file=sys.stderr)
    return 2


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def project_dir(cli_root: str | None) -> Path:
    """Resolve the repository root. Explicit flag wins; state never lands in a surprise cwd."""
    if cli_root:
        return Path(cli_root).resolve()
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return Path(env).resolve()
    # No git on PATH, not a repository, or git hung past the timeout: fall
    # through to cwd rather than failing. This is the last of three fallbacks
    # and the caller has no better answer to offer.
    return git_toplevel() or Path.cwd().resolve()


def git_toplevel() -> Path | None:
    """The top of the git checkout around cwd, or None when git cannot say."""
    git = shutil.which("git")
    if git is None:
        return None
    try:
        # Absolute git from shutil.which and a constant argv: nothing untrusted.
        proc = subprocess.run(  # nosec B603
            [git, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=10,
        )
        top = proc.stdout.strip()
        return Path(top).resolve() if proc.returncode == 0 and top else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def armed_workflow(root: Path) -> dict | None:
    """The active workflow, but only while it is still armed: enforce_stop set and
    not closed. init used to overwrite active-workflow.json unconditionally, so a
    second init silently orphaned the first workflow's Stop guard."""
    active = active_pointer(root)
    if not active.is_file():
        return None
    try:
        workflow_id = json.loads(active.read_text(encoding="utf-8"))["workflow_id"]
        state = json.loads(state_file(root, workflow_id).read_text(encoding="utf-8"))
    except (OSError, KeyError, json.JSONDecodeError):
        return None
    if state.get("enforce_stop") and state.get("status") not in TERMINAL_STATUSES:
        return state
    return None


def apply_node_policy(nodes: list[dict], mode: str, require_all: bool, optional: set[str]) -> None:
    """Decide, before the workflow is written, which nodes are required and
    which are skipped. In `all` mode without --require-all an absent agent is
    not required; a node named in --optional-agents is never required; and in
    either case an absent node is recorded as skipped rather than blocked."""
    relax_absent = mode == "all" and not require_all
    for node in nodes:
        if relax_absent:
            node["required"] = bool(node["available"])
        if node["id"] in optional:
            node["required"] = False
        if (relax_absent or node["id"] in optional) and not node["available"]:
            node["status"] = STATUS_SKIPPED


def scalar(text: str, key: str) -> str | None:
    match = re.search(rf"^{re.escape(key)}:\s*(.+?)\s*$", text, re.MULTILINE)
    if not match:
        return None
    value = match.group(1).strip()
    if value.startswith("#"):
        return None
    return value.split(" #", 1)[0].strip().strip("\"'")


def handoff_valid(path: Path, node_id: str, workflow_id: str) -> tuple[bool, list[str]]:
    if not path.is_file():
        return False, ["handoff file is missing"]
    text = path.read_text(encoding="utf-8", errors="replace")
    errors = []
    for key in ["workflow_id", "agent_id", "status", "summary", "next_action", "authorization_used"]:
        if not scalar(text, key):
            errors.append(f"missing {key}")
    if scalar(text, "workflow_id") != workflow_id:
        errors.append("workflow_id does not match")
    if scalar(text, "agent_id") != node_id:
        errors.append("agent_id does not match registered node")
    if not re.search(r"^evidence:\s*$", text, re.MULTILINE):
        errors.append("evidence section is missing")
    if scalar(text, "status") == "completed" and not re.search(r"^\s*-\s+path:", text, re.MULTILINE):
        errors.append("completed handoff has no evidence or artifact path")
    return not errors, errors


def load_state(root: Path, workflow_id: str) -> tuple[Path, Path, dict] | None:
    directory = workflow_dir(root, workflow_id)
    state_path = directory / STATE_FILE
    if not state_path.is_file():
        return None
    return directory, state_path, json.loads(state_path.read_text(encoding="utf-8"))


def score_node(node: dict, directory: Path, workflow_id: str) -> tuple[dict, list[str]]:
    """Set one node's status from its handoff. Returns the node's result row
    and the errors it contributes, which is only ever non-empty for a
    required node: an optional node's failings are recorded, never blocking."""
    required = bool(node.get("required"))
    if not node.get("available"):
        node["status"] = "blocked" if required else STATUS_SKIPPED
        errors = [f"required agent unavailable: {node['id']}"] if required else []
        return {"agent_id": node["id"], "valid": False, "reasons": [node["status"]]}, errors
    handoff = directory / "handoffs" / f"{node['id']}.yml"
    valid, reasons = handoff_valid(handoff, node["id"], workflow_id)
    if valid:
        node["status"] = "completed"
        return {"agent_id": node["id"], "valid": True, "reasons": reasons}, []
    node["status"] = "blocked" if required else "partial"
    errors = [f"{node['id']}: {reason}" for reason in reasons] if required else []
    return {"agent_id": node["id"], "valid": False, "reasons": reasons}, errors


def overall_status(errors: list[str], required: list[dict]) -> str:
    """blocked on any error; completed only when every required node is;
    partial otherwise — including the case of no required nodes at all."""
    if errors:
        return "blocked"
    if required and all(node.get("status") == "completed" for node in required):
        return "completed"
    return "partial"


def evaluate_workflow(state: dict, directory: Path) -> tuple[list[str], list[dict]]:
    """Score every node against its handoff and set state["status"] accordingly.
    Shared by validate and close so the two can never disagree about whether a
    workflow is finished."""
    errors: list[str] = []
    results = []
    for node in state.get("nodes", []):
        result, node_errors = score_node(node, directory, state["workflow_id"])
        results.append(result)
        errors.extend(node_errors)
    required = [node for node in state.get("nodes", []) if node.get("required")]
    state["status"] = overall_status(errors, required)
    state["updated_at"] = now()
    # Report skipped nodes alongside the errors. A workflow whose agents are all
    # absent validates with zero errors and exits 0, which reads as "everything
    # ran" -- it means the opposite. Naming them makes an empty run visible.
    skipped = [node["id"] for node in state.get("nodes", []) if node.get("status") == STATUS_SKIPPED]
    state["validation"] = {
        "validated_at": now(),
        "errors": errors,
        "skipped": skipped,
        "completed": sum(1 for node in required if node.get("status") == "completed"),
        "required": len(required),
        "results": results,
    }
    return errors, results
