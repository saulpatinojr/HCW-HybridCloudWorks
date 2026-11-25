"""The report handed to the site through the lab agent's CLI."""

import json
import os
import subprocess
import sys

from .common import DeliveryUnknown, NotDelivered, me, scrub

# The environment every program this helper starts gets, and nothing more: the
# token never travels in one, $CREDENTIALS_DIRECTORY does not reach the CLI,
# and a proxy variable cannot reach it either.
CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# The sandbox systemd-run puts the site's CLI in, each as a --property.
CLI_SANDBOX = (
    "Environment=NODE_ENV=production",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=full",
    "ProtectHome=yes",
)


def deliver(config, report):
    """Hand the report to the site through the lab agent's CLI.

    Returns the CLI's answer, {"ok": true}. Raises NotDelivered when the CLI
    certainly never ran, DeliveryUnknown when it ran and did not answer ok.
    """
    if not os.path.isfile(config["agent_env_file"]):
        raise NotDelivered(
            f"the lab agent is not configured ({config['agent_env_file']} is missing), "
            "so nothing could be sent to the site"
        )
    payload = {"check": "portainer", "report": report}
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
            print(f"{me}: site CLI: {scrub(line)}", file=sys.stderr, flush=True)
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
