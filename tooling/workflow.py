#!/usr/bin/env python3
"""Create, discover, and validate Claude agentic workflow state locally.

Path model (two anchors, never confused):
  PACK_HOME   = the directory this script lives in (tooling/). The agent
                registry lives beside the script and always resolves here.
  PROJECT_DIR = the repository the workflow runs in. Resolved in order:
                --root flag > CLAUDE_PROJECT_DIR env > git toplevel > cwd.
                All runtime state (.agentic/) is created under PROJECT_DIR.

Commands:
  registry   regenerate tooling/agent-registry.yml from installed agents
  discover   report which registry agents are installed (project + user scope)
  init       create .agentic/workflows/<id>/ before any delegation
  validate   check required handoffs; exit 0 only when the workflow is clean
  close      end a workflow: 'completed' only when validation is clean,
             otherwise --abandon records it as abandoned with its open errors
  status     print a workflow's WORKFLOW.json
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# The tool is three files in this directory (#1845): this command line,
# workflow_state.py and workflow_agents.py. Python puts a script's own
# directory first on its import path, but not under -P or PYTHONSAFEPATH, so
# it is put there explicitly: the siblings are always found next to this
# file, never anywhere else.
_PACK_DIR = str(Path(__file__).resolve().parent)
if sys.path[:1] != [_PACK_DIR]:
    sys.path.insert(0, _PACK_DIR)

from workflow_agents import (  # noqa: E402 - after the path line above
    run_discovery,
    selected_nodes,
    write_registry,
)
from workflow_state import (  # noqa: E402 - after the path line above
    STATE_FILE,
    active_pointer,
    apply_node_policy,
    armed_workflow,
    evaluate_workflow,
    load_state,
    now,
    project_dir,
    state_file,
    workflow_dir,
    workflow_not_found,
)

def init_workflow(args: argparse.Namespace, root: Path) -> int:
    armed = armed_workflow(root)
    if armed and not args.force:
        raise SystemExit(
            f"active workflow {armed['workflow_id']} is armed (enforce_stop) and not closed; "
            f"opening another would orphan its Stop guard. Close it first with "
            f"'workflow.py close --workflow {armed['workflow_id']} --reason <why> [--abandon]', "
            f"or pass --force to open a new workflow anyway."
        )
    workflow_id = args.workflow_id or "wf-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    directory = workflow_dir(root, workflow_id)
    if directory.exists():
        raise SystemExit(f"workflow already exists: {workflow_id}")
    discovery = run_discovery(root, include_user=not args.no_user, out=".agentic/discovery.json")
    nodes = selected_nodes(discovery, args.mode, [x for x in args.agents.split(",") if x])
    optional = {x for x in args.optional_agents.split(",") if x}
    apply_node_policy(nodes, args.mode, args.require_all, optional)
    state = {
        "workflow_id": workflow_id,
        "created_at": now(),
        "updated_at": now(),
        "mode": args.mode,
        "objective": args.objective,
        "enforce_stop": bool(args.enforce_stop),
        "max_parallel": args.max_parallel,
        "nodes": nodes,
        "status": "blocked" if any(n["required"] and not n["available"] for n in nodes) else "queued",
    }
    (directory / "handoffs").mkdir(parents=True)
    (directory / "artifacts").mkdir()
    (directory / STATE_FILE).write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    active_pointer(root).write_text(
        json.dumps({"workflow_id": workflow_id, "path": str(directory)}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(state, indent=2))
    return 0


def validate_workflow(args: argparse.Namespace, root: Path) -> int:
    loaded = load_state(root, args.workflow)
    if loaded is None:
        return workflow_not_found(args.workflow)
    directory, state_path, state = loaded
    errors, _ = evaluate_workflow(state, directory)
    if not args.check:
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(dict(state["validation"], workflow_status=state["status"]), indent=2))
    return 0 if not errors else 1


def close_workflow(args: argparse.Namespace, root: Path) -> int:
    """End a workflow and release the Stop guard, honestly.

    A clean validation closes it "completed". Anything else closes only under
    --abandon, which records "abandoned" together with the errors still open.
    There is deliberately no path here that writes "completed" over a missing
    handoff. That state is what an operator produces by hand when the tool
    offers no exit, and it makes the audit trail assert work that never ran.
    """
    loaded = load_state(root, args.workflow)
    if loaded is None:
        return workflow_not_found(args.workflow)
    directory, state_path, state = loaded
    errors, _ = evaluate_workflow(state, directory)
    if errors and not args.abandon:
        print(json.dumps({
            "workflow_id": state["workflow_id"],
            "closed": False,
            "status": state["status"],
            "errors": errors,
            "hint": "run the outstanding agents, or record the truth with --abandon",
        }, indent=2), file=sys.stderr)
        return 1
    # `completed` has to mean work actually ran (T-741).
    #
    # evaluate_workflow already refuses to call an empty required-set
    # "completed" -- `elif required and all(...)` falls through to "partial".
    # This line used to overwrite that with a bare `errors else "completed"`,
    # so a workflow whose every node was skipped_optional closed as completed:
    # an audit trail asserting work that never happened, which the module
    # docstring says this tool exists to prevent. The CI smoke test asserted
    # that behaviour, so it was pinned rather than accidental.
    validation = state.get("validation") or {}
    nothing_ran = validation.get("completed", 0) == 0
    if errors:
        state["status"] = "abandoned"
    elif nothing_ran or validation.get("skipped"):
        # Distinct from "abandoned", which means outstanding errors. This is a
        # workflow that closed cleanly having done nothing -- worth its own
        # word so a reader is not left inferring it from a zero count.
        state["status"] = "empty"
    else:
        state["status"] = "completed"
    state["closed_at"] = now()
    state["closed_reason"] = args.reason
    if errors:
        state["outstanding_at_close"] = errors
    state["updated_at"] = now()
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    active = active_pointer(root)
    if active.is_file():
        try:
            pointer = json.loads(active.read_text(encoding="utf-8")).get("workflow_id")
            if pointer == state["workflow_id"]:
                active.unlink()
        except (OSError, json.JSONDecodeError):
            # An unreadable or malformed pointer is already the outcome this
            # block wants: nothing valid points at the workflow being closed,
            # so there is no stale pointer left to clear.
            pass
    print(json.dumps({
        "workflow_id": state["workflow_id"],
        "closed": True,
        "status": state["status"],
        "reason": args.reason,
        "outstanding": errors,
    }, indent=2))
    return 0


def registry_command(args: argparse.Namespace, root: Path) -> int:
    return write_registry(root, include_user=not args.no_user)


def discover_command(args: argparse.Namespace, root: Path) -> int:
    result = run_discovery(root, include_user=not args.no_user, out=args.out)
    print(json.dumps(result, indent=2))
    return 0


def status_workflow(args: argparse.Namespace, root: Path) -> int:
    """Print a workflow's WORKFLOW.json verbatim. Read-only: status must never
    rewrite the state it reports, or reading it would change it."""
    path = state_file(root, args.workflow)
    if not path.is_file():
        return workflow_not_found(args.workflow)
    print(path.read_text(encoding="utf-8"))
    return 0


# Every subcommand takes (args, root) and returns an exit code, so dispatch is
# a lookup rather than a chain of `if args.command ==`. add_subparsers is
# required=True below, so no key here can be missing at the point of the call.
COMMANDS = {
    "registry": registry_command,
    "discover": discover_command,
    "init": init_workflow,
    "validate": validate_workflow,
    "close": close_workflow,
    "status": status_workflow,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=None, help="repository root (default: CLAUDE_PROJECT_DIR, then git toplevel, then cwd)")
    sub = parser.add_subparsers(dest="command", required=True)
    registry_parser = sub.add_parser("registry", help="regenerate agent-registry.yml from installed agents")
    registry_parser.add_argument("--no-user", action="store_true", help="ignore the user-scope ~/.claude/agents")
    discover_parser = sub.add_parser("discover")
    discover_parser.add_argument("--out", default=".agentic/discovery.json")
    discover_parser.add_argument("--no-user", action="store_true")
    init_parser = sub.add_parser("init")
    init_parser.add_argument("--mode", choices=["one", "selected", "all"], required=True)
    init_parser.add_argument("--agents", default="")
    init_parser.add_argument("--optional-agents", default="", help="named agents that may be skipped when unavailable")
    init_parser.add_argument("--workflow-id")
    init_parser.add_argument("--objective", required=True)
    init_parser.add_argument("--max-parallel", type=int, default=3)
    init_parser.add_argument("--require-all", action="store_true", help="in all mode, block when any registry agent is unavailable")
    init_parser.add_argument("--enforce-stop", action="store_true", help="opt in: let the Stop hook block session end until required handoffs validate")
    init_parser.add_argument("--no-user", action="store_true")
    init_parser.add_argument("--force", action="store_true", help="open a new workflow even if an armed one is still active")
    validate_parser = sub.add_parser("validate")
    validate_parser.add_argument("--workflow", required=True)
    validate_parser.add_argument("--check", action="store_true", help="read-only: report without rewriting WORKFLOW.json")
    close_parser = sub.add_parser("close", help="end a workflow and release the Stop guard")
    close_parser.add_argument("--workflow", required=True)
    close_parser.add_argument("--reason", required=True, help="why it is being closed; recorded in WORKFLOW.json")
    close_parser.add_argument("--abandon", action="store_true", help="close as abandoned when required handoffs are still missing")
    status_parser = sub.add_parser("status")
    status_parser.add_argument("--workflow", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return COMMANDS[args.command](args, project_dir(args.root))


if __name__ == "__main__":
    raise SystemExit(main())
