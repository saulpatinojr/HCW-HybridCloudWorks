"""The report, and a new status token when there is one, handed to the site through the lab agent's CLI."""

import json
import os
import subprocess
import sys

from . import common
from .common import CHILD_PATH, DeliveryUnknown, NotDelivered, iso, scrub

# The sandbox systemd-run puts the site's CLI in, each as a --property.
CLI_SANDBOX = (
    "Environment=NODE_ENV=production",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=full",
    "ProtectHome=yes",
)


def deliver(config, status_token, report):
    """Hand a report, and a new status token when there is one, to the site.

    Returns the CLI's answer, {"ok": true, "stored": true|false}. Raises
    NotDelivered when the CLI certainly never ran, DeliveryUnknown when it ran
    and did not answer ok.
    """
    if not os.path.isfile(config["agent_env_file"]):
        raise NotDelivered(
            f"the lab agent is not configured ({config['agent_env_file']} is missing), "
            "so nothing could be sent to the site"
        )
    payload = {"report": report}
    if status_token is not None:
        payload["statusToken"] = status_token
    timeout = config["report_timeout_seconds"]
    properties = [
        f"EnvironmentFile={config['agent_env_file']}",
        f"WorkingDirectory={config['agent_app_dir']}",
        *CLI_SANDBOX,
        # systemd stops the CLI itself before this helper gives up on it, so
        # a hung CLI never outlives the run that started it.
        f"RuntimeMaxSec={timeout}",
    ]
    argv = [config["systemd_run"], "--pipe", "--wait", "--quiet", "--collect", "--service-type=exec",
            f"--uid={config['agent_user']}", f"--gid={config['agent_group']}"]
    argv += [f"--property={setting}" for setting in properties]
    argv += ["--", config["node"], config["report_cli"]]
    try:
        completed = subprocess.run(
            argv,
            input=(json.dumps(payload) + "\n").encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"PATH": CHILD_PATH, "LC_ALL": "C"},
            timeout=timeout + 30,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise DeliveryUnknown(f"the site's CLI did not finish within {timeout} seconds") from None
    except OSError as error:
        raise NotDelivered(f"the site's CLI could not be started ({type(error).__name__})") from None
    for line in completed.stderr.decode("utf-8", "replace").splitlines():
        if line.strip():
            print(f"{common.me}: site CLI: {scrub(line)}", file=sys.stderr, flush=True)
    if completed.returncode != 0:
        raise DeliveryUnknown(f"the site's CLI exited with {completed.returncode}")
    lines = [line for line in completed.stdout.decode("utf-8", "replace").splitlines() if line.strip()]
    try:
        answer = json.loads(lines[-1]) if lines else None
    except ValueError:
        answer = None
    if not isinstance(answer, dict) or answer.get("ok") is not True:
        raise DeliveryUnknown("the site's CLI did not answer {\"ok\": true}")
    return answer


def report_fields(state, checked_at, source_digest=None):
    """The report: what is known, and nothing that is not.

    templateDigest is the digest of what push-template last published (the
    state's, from template_digest at that push); templateSourceDigest is the
    same digest of the checkout as it is now, which bootstrap.sh leaves at the
    commit the host converged from. The site compares the two and raises a
    template Coder serves that is not the converged commit's, such as a
    bootstrap whose publish failed or was skipped (#1009, finding 8).
    """
    report = {"checkedAt": iso(checked_at)}
    for field in ("statusTokenExpiresAt", "statusTokenRotatedAt", "rotationTokenExpiresAt",
                  "templatePushedAt", "templateVersion", "templateDigest"):
        if state.get(field):
            report[field] = state[field]
    if source_digest:
        report["templateSourceDigest"] = source_digest
    return report
